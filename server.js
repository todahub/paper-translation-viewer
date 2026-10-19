const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');

const store = require('./lib/store');
const { runPipeline } = require('./lib/pipeline');
const { ensureTranslatedPdf } = require('./lib/pdfGenerate');
const { getCliInfo } = require('./lib/claudeTranslate');
const shareClient = require('./lib/shareClient');

const shareConfig = shareClient.loadShareConfig();

const PORT = process.env.PORT || 3000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// Served locally (not from a CDN) so the viewer also works for LAN users without internet.
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build')));
app.use(express.json());

// What this instance can do; the same page also runs on the shared (web)
// viewer, where this endpoint answers mode "web".
app.get('/api/capabilities', async (req, res) => {
  const cli = await getCliInfo();
  res.json({
    mode: 'local',
    authenticated: true,
    canTranslate: cli.usable,
    cli,
    canPublish: !!shareConfig,
    shareUrl: shareConfig ? shareConfig.shareUrl : null,
  });
});

app.get('/api/documents', (req, res) => {
  res.json(store.listDocuments());
});

app.post('/api/documents', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'pdf ファイルが見つかりません' });
    return;
  }

  const hash = store.hashBuffer(req.file.buffer);
  const existing = store.findByHash(hash);
  if (existing) {
    res.json({ id: existing.id, reused: true });
    return;
  }

  // Someone may already have translated and shared this paper; reuse theirs
  // instead of spending this user's Claude quota on it again.
  if (shareConfig) {
    try {
      const sharedUrl = await shareClient.findInLibrary(shareConfig, hash);
      if (sharedUrl) {
        res.json({ sharedUrl });
        return;
      }
    } catch (err) {
      console.warn('shared library check failed:', err.message);
    }
  }

  const cli = await getCliInfo();
  if (!cli.usable) {
    res.status(400).json({
      error: cli.installed
        ? 'インストールされている Claude CLI が古いため翻訳できません。Claude CLI を更新してください。'
        : '翻訳するには Claude CLI が必要です。インストールしてから再度お試しください。',
    });
    return;
  }

  const id = store.createDocument(req.file.originalname || 'document.pdf', hash);
  fs.writeFileSync(store.paths(id).pdf, req.file.buffer);

  runPipeline(id, req.file.buffer, { model: req.body.model }).catch((err) => {
    store.writeStatus(id, { state: 'error', processedChunks: 0, totalChunks: 0, message: String(err) });
  });

  res.json({ id, reused: false });
});

app.get('/api/documents/:id/status', (req, res) => {
  const status = store.readStatus(req.params.id);
  if (!status) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(status);
});

app.get('/api/documents/:id/result', (req, res) => {
  const result = store.readResult(req.params.id);
  if (!result) {
    res.status(404).json({ error: 'not ready' });
    return;
  }
  const meta = store.readMeta(req.params.id);
  res.json({ ...result, meta });
});

app.get('/api/documents/:id/original.pdf', (req, res) => {
  const p = store.paths(req.params.id);
  if (!fs.existsSync(p.pdf)) {
    res.status(404).end();
    return;
  }
  res.type('application/pdf').sendFile(p.pdf);
});

// The layout-preserving Japanese PDF (and where each Japanese sentence sits
// on it) is generated once and cached on disk; later requests, including
// other people on the network opening the same doc, reuse the cached files.
async function withTranslatedPdf(req, res, send) {
  try {
    await ensureTranslatedPdf(req.params.id);
    send(store.paths(req.params.id));
  } catch (err) {
    const status = err.code === 'OLD_FORMAT' ? 409 : 500;
    res.status(status).json({ error: String(err && err.message ? err.message : err) });
  }
}

app.get('/api/documents/:id/translated.pdf', (req, res) => {
  withTranslatedPdf(req, res, (p) => {
    if (req.query.download) {
      const meta = store.readMeta(req.params.id);
      const base = ((meta && meta.filename) || 'document.pdf').replace(/\.pdf$/i, '');
      res.download(p.translatedPdf, `${base}-JA.pdf`);
    } else {
      res.type('application/pdf').sendFile(p.translatedPdf);
    }
  });
});

app.get('/api/documents/:id/ja-layout', (req, res) => {
  withTranslatedPdf(req, res, (p) => res.type('application/json').sendFile(p.jaLayout));
});

app.post('/api/documents/:id/publish', async (req, res) => {
  if (!shareConfig) {
    res.status(400).json({ error: '共有ライブラリの設定（config.local.json）がありません' });
    return;
  }
  try {
    const url = await shareClient.publish(shareConfig, req.params.id);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

function lanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

app.listen(PORT, () => {
  console.log(`transrate_reserch server listening on http://localhost:${PORT}`);
  for (const addr of lanAddresses()) {
    console.log(`  同じネットワーク内の他の端末からは http://${addr}:${PORT} でアクセスできます`);
  }
});
