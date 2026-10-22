const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');

const store = require('./lib/store');
const { runPipeline, retranslateParagraph } = require('./lib/pipeline');
const { ensureTranslatedPdf } = require('./lib/pdfGenerate');
const { getCliInfo } = require('./lib/claudeTranslate');
const shareClient = require('./lib/shareClient');
const termBase = require('./lib/termBase');
const { applyTermEdit } = require('./lib/termEdit');

let shareConfig = shareClient.loadShareConfig();

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

// Connect this app to a shared library from the page instead of hand-editing
// config.local.json. Only from this PC itself: the app is reachable over the
// LAN, and nobody else should be able to redirect where papers get published.
function fromThisPc(req, res) {
  const ip = req.socket.remoteAddress || '';
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return true;
  res.status(403).json({ error: '接続設定はこのPCからのみ変更できます' });
  return false;
}

app.post('/api/share-config', async (req, res) => {
  if (!fromThisPc(req, res)) return;
  const body = req.body || {};
  // Changing only the URL (e.g. a new Vercel domain) keeps the saved password.
  const password = body.password || (shareConfig && shareConfig.password) || '';
  try {
    const cfg = await shareClient.verifyShareConfig({ ...body, password, name: body.name ?? (shareConfig && shareConfig.name) });
    shareClient.saveShareConfig(cfg);
    shareConfig = cfg;
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/share-config', (req, res) => {
  if (!fromThisPc(req, res)) return;
  shareClient.clearShareConfig();
  shareConfig = null;
  res.json({ ok: true });
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

// Take a published paper back as a local draft to correct it (paragraph
// fixes, term fixes), then publish it again to replace the shared copy.
app.post('/api/shared-documents/:paperId/checkout', async (req, res) => {
  if (!fromThisPc(req, res)) return;
  if (!shareConfig) {
    res.status(400).json({ error: '共有ライブラリに接続されていません' });
    return;
  }
  const paperId = req.params.paperId;
  const existing = store.findByHash(paperId);
  if (existing) {
    res.json({ id: existing.id });
    return;
  }
  try {
    const { result, pdf } = await shareClient.fetchPaper(shareConfig, paperId);
    const { meta: sharedMeta, ...rest } = result;
    const id = store.createDocument((sharedMeta && sharedMeta.filename) || 'document.pdf', paperId);
    const p = store.paths(id);
    fs.writeFileSync(p.pdf, pdf);
    store.writeResult(id, rest);
    const meta = store.readMeta(id);
    fs.writeFileSync(p.meta, JSON.stringify({ ...meta, title: (sharedMeta && sharedMeta.title) || rest.title || '', fromShared: true }, null, 2));
    store.writeStatus(id, { state: 'done', processedChunks: 0, totalChunks: 0, message: '' });
    res.json({ id });
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
  // instead of spending this user's Claude quota on it again — unless the
  // user explicitly chose to re-translate it (e.g. after the rules improved).
  if (shareConfig && req.body.force !== '1') {
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

  const id = store.createDocument(filename, hash, req.body.model);
  fs.writeFileSync(store.paths(id).pdf, req.file.buffer);
  startTranslation(id);

  res.json({ id, reused: false });
});

// Documents whose translation is running in this process right now.
const running = new Set();

// Translate a stored document, or carry on with one that stopped (usage
// limit, server restart, failed paragraphs). Paragraphs already translated
// come from the cache, so a resumed run only pays for what's left.
function startTranslation(id) {
  if (running.has(id)) return;
  const meta = store.readMeta(id);
  if (!meta) return;
  running.add(id);
  store.writeStatus(id, { state: 'processing', processedChunks: 0, totalChunks: 0, message: '' });

  // Also renews the "I'm translating this" claim each time a run starts.
  const onTitle = shareConfig && meta.hash
    ? (title) => shareClient.claim(shareConfig, { id: meta.hash, filename: meta.filename, title, force: true }).catch(() => {})
    : undefined;
  termBase.loadTerms(shareConfig)
    .catch(() => [])
    .then((terms) => runPipeline(id, fs.readFileSync(store.paths(id).pdf), { model: meta.model, onTitle, termBase: terms }))
    .catch((err) => {
      store.writeStatus(id, { state: 'error', processedChunks: 0, totalChunks: 0, message: String(err) });
      return 'error';
    })
    .then((state) => {
      running.delete(id);
      // A failed translation shouldn't keep the paper marked as taken.
      if (shareConfig && meta.hash && state === 'error') shareClient.releaseClaim(shareConfig, meta.hash).catch(() => {});
    });
}

// Resume paused translations once their limit has reset. Polled rather than
// one timer per document, so a PC that slept past the reset time (timers
// don't advance during sleep) still picks up right after waking.
const RESUME_CHECK_MS = 60 * 1000;
function resumeDueTranslations() {
  for (const doc of store.listDocuments()) {
    if (doc.status !== 'paused') continue;
    const status = store.readStatus(doc.id);
    if (status && Date.parse(status.resumeAt) <= Date.now()) {
      console.log(`resuming ${doc.id} after usage limit`);
      startTranslation(doc.id);
    }
  }
}

function hasFailedParagraphs(id) {
  const result = store.readResult(id);
  return !!result && result.paragraphs.some((p) => p.ja_sentences.includes('(翻訳に失敗しました)'));
}

app.get('/api/documents/:id/status', (req, res) => {
  const status = store.readStatus(req.params.id);
  if (!status) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(status);
});

// "Resume now" for a paused or failed translation, and "retry the failed
// paragraphs" for a finished one.
app.post('/api/documents/:id/resume', async (req, res) => {
  const status = store.readStatus(req.params.id);
  if (!status) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (status.state === 'processing' || running.has(req.params.id)) {
    res.json({ ok: true });
    return;
  }
  // rebuild: read the PDF again with the current code. The draft's glossary
  // and every paragraph whose English didn't change come from the cache, so
  // only the changed paragraphs are sent to Claude.
  const rebuild = !!(req.body && req.body.rebuild);
  if (status.state === 'done' && !rebuild && !hasFailedParagraphs(req.params.id)) {
    res.status(400).json({ error: '翻訳し直す段落はありません' });
    return;
  }
  if (!(await getCliInfo()).usable) {
    res.status(400).json({ error: '翻訳するには Claude CLI が必要です' });
    return;
  }
  startTranslation(req.params.id);
  res.json({ ok: true });
});

app.get('/api/documents/:id/result', (req, res) => {
  const result = store.readResult(req.params.id);
  if (!result) {
    res.status(404).json({ error: 'not ready' });
    return;
  }
  const meta = store.readMeta(req.params.id);
  res.json({ ...result, meta, hasFailed: hasFailedParagraphs(req.params.id) });
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
    const result = store.readResult(req.params.id);
    const url = await shareClient.publish(shareConfig, req.params.id, { replace: !!(req.body && req.body.replace) });
    // The shared library now holds the master copy; the local draft is done.
    fs.rmSync(store.paths(req.params.id).dir, { recursive: true, force: true });
    // Its terms join the shared term base, so later papers translate them
    // the same way (terms already there are kept).
    if (result && result.glossary) {
      termBase.addTerms(shareConfig, result.glossary).catch((err) => console.warn('could not update the term base:', err.message));
    }
    res.json({ url });
  } catch (err) {
    // 409: already shared — the page asks whether to replace it.
    res.status(err.status === 409 ? 409 : 500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// Correct a term in a draft: every Japanese sentence using the old rendering
// is updated, the Japanese PDF is rebuilt, and the term base remembers the
// correction for later papers.
app.post('/api/documents/:id/terms', async (req, res) => {
  if (!fromThisPc(req, res)) return;
  const { en, ja } = req.body || {};
  if (!en || !ja || !String(ja).trim()) {
    res.status(400).json({ error: '訳語を入力してください' });
    return;
  }
  try {
    const { replaced, term } = applyTermEdit(req.params.id, String(en), String(ja).trim());
    let warning = null;
    try {
      await termBase.addTerms(shareConfig, [term], { overwrite: true });
    } catch (err) {
      warning = `この論文は直しましたが、共有の用語ベースには保存できませんでした: ${err.message}`;
    }
    res.json({ replaced, term, warning });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// "Fix this part": re-translate one paragraph of a draft with an instruction.
app.post('/api/documents/:id/paragraphs/:pid/retranslate', async (req, res) => {
  if (!fromThisPc(req, res)) return;
  if (running.has(req.params.id)) {
    res.status(409).json({ error: '翻訳中は直せません。終わってからお試しください。' });
    return;
  }
  const instruction = String((req.body && req.body.instruction) || '').trim().slice(0, 1000);
  try {
    res.json(await retranslateParagraph(req.params.id, req.params.pid, instruction));
  } catch (err) {
    if (err.rateLimited) {
      res.status(429).json({ error: 'Claude の利用上限に達しています。上限が戻ってからもう一度お試しください。' });
      return;
    }
    res.status(err.status || (err.fatal ? 400 : 500)).json({ error: err.message });
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
  // A run still marked "processing" was cut off when the server stopped.
  for (const doc of store.listDocuments()) {
    if (doc.status === 'processing') {
      console.log(`resuming ${doc.id}, interrupted by a restart`);
      startTranslation(doc.id);
    }
  }
  resumeDueTranslations();
  setInterval(resumeDueTranslations, RESUME_CHECK_MS);
  for (const addr of lanAddresses()) {
    console.log(`  同じネットワーク内の他の端末からは http://${addr}:${PORT} でアクセスできます`);
  }
});
