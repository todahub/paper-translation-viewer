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

// With a shared library configured it is the single source of truth: the
// local page lists it (relayed, since the browser can't send the shared
// password itself) and local documents are only unpublished drafts.
app.get('/api/shared-documents', async (req, res) => {
  if (!shareConfig) {
    res.json([]);
    return;
  }
  try {
    res.json(await shareClient.listDocuments(shareConfig));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// The shared "who is translating what" board, relayed the same way.
app.get('/api/shared-claims', async (req, res) => {
  if (!shareConfig) {
    res.json({ claims: [] });
    return;
  }
  try {
    res.json({ claims: await shareClient.listClaims(shareConfig) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
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

  const filename = req.file.originalname || 'document.pdf';

  // Tell friends "I'm translating this" so nobody starts the same paper.
  // If someone else already is, stop unless the user chose to go ahead.
  if (shareConfig) {
    try {
      await shareClient.claim(shareConfig, { id: hash, filename, force: req.body.force === '1' });
    } catch (err) {
      if (err.claim) {
        res.json({ inProgress: err.claim });
        return;
      }
      console.warn('could not register as translating:', err.message);
    }
  }

  const id = store.createDocument(filename, hash);
  fs.writeFileSync(store.paths(id).pdf, req.file.buffer);

  const onTitle = shareConfig
    ? (title) => shareClient.claim(shareConfig, { id: hash, filename, title, force: true }).catch(() => {})
    : undefined;
  runPipeline(id, req.file.buffer, { model: req.body.model, onTitle })
    .catch((err) => {
      store.writeStatus(id, { state: 'error', processedChunks: 0, totalChunks: 0, message: String(err) });
    })
    .then(() => {
      // A failed translation shouldn't keep the paper marked as taken.
      const status = store.readStatus(id);
      if (shareConfig && status && status.state === 'error') shareClient.releaseClaim(shareConfig, hash).catch(() => {});
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
    // The shared library now holds the master copy; the local draft is done.
    fs.rmSync(store.paths(req.params.id).dir, { recursive: true, force: true });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

app.delete('/api/documents/:id', (req, res) => {
  const meta = store.readMeta(req.params.id);
  if (!meta) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const status = store.readStatus(req.params.id);
  if (status && status.state === 'processing') {
    res.status(409).json({ error: '翻訳中の文書は削除できません' });
    return;
  }
  fs.rmSync(store.paths(req.params.id).dir, { recursive: true, force: true });
  if (shareConfig && meta.hash) shareClient.releaseClaim(shareConfig, meta.hash).catch(() => {});
  res.json({ ok: true });
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
