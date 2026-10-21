// Talks to the shared library (the Vercel viewer) from a translator's PC:
// checks whether a paper is already shared and publishes local translations.
// Enabled only when config.local.json has { shareUrl, password, name }:
// the same password used to log in to the viewer, and the display name shown
// as the publisher.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { ensureTranslatedPdf } = require('./pdfGenerate');

const CONFIG_PATH = path.join(__dirname, '..', 'config.local.json');

function normalize(cfg) {
  return { shareUrl: String(cfg.shareUrl).trim().replace(/\/+$/, '').replace(/\/#.*$/, ''), password: cfg.password, name: (cfg.name || '').trim() };
}

function loadShareConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!cfg.shareUrl || !cfg.password) return null;
  return normalize(cfg);
}

// Check a URL + password against the shared library before saving them, and
// explain the common failure where Vercel's own login sits in front of it.
async function verifyShareConfig(input) {
  const cfg = normalize(input);
  if (!/^https?:\/\//.test(cfg.shareUrl)) throw new Error('URL は https:// から始めてください');
  let res;
  try {
    res = await fetch(cfg.shareUrl + '/api/claims', {
      headers: { Authorization: `Bearer ${cfg.password}` },
      redirect: 'manual',
    });
  } catch {
    throw new Error('共有ライブラリに接続できませんでした。URL を確認してください。');
  }
  const location = res.headers.get('location') || '';
  if ((res.status >= 300 && res.status < 400 && /vercel\.com\/sso/.test(location)) || res.headers.get('x-vercel-protection')) {
    throw new Error('このURLは Vercel のログインで保護されています。Vercel の Settings → Deployment Protection で「Vercel Authentication」をオフにするか、Settings → Domains の本番用URLを使ってください。');
  }
  if (res.status === 401) throw new Error('パスワードが違います');
  if (!res.ok) throw new Error(`共有ライブラリとして応答しませんでした (HTTP ${res.status})。URL を確認してください。`);
  return cfg;
}

function saveShareConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function clearShareConfig() {
  fs.rmSync(CONFIG_PATH, { force: true });
}

async function callApi(cfg, method, apiPath, body) {
  const res = await fetch(cfg.shareUrl + apiPath, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.password}`,
      'X-Publisher-Name': encodeURIComponent(cfg.name),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `共有ライブラリへの接続に失敗しました (HTTP ${res.status})`);
    err.status = res.status;
    err.claim = data.claim;
    throw err;
  }
  return data;
}

// Mark a paper as "being translated by me" on the shared board. Throws an
// error carrying `.claim` if someone else is already translating it.
async function claim(cfg, { id, filename, title, force }) {
  await callApi(cfg, 'POST', '/api/claims', { id, filename, title, force: !!force });
}

async function releaseClaim(cfg, id) {
  await callApi(cfg, 'DELETE', `/api/claims?id=${encodeURIComponent(id)}`);
}

async function listClaims(cfg) {
  return (await callApi(cfg, 'GET', '/api/claims')).claims;
}

// The shared library's paper list, each with a link to open it in the viewer.
async function listDocuments(cfg) {
  const docs = await callApi(cfg, 'GET', '/api/documents');
  return docs.map((d) => ({ ...d, url: docUrl(cfg, d.id) }));
}

function docUrl(cfg, paperId) {
  return `${cfg.shareUrl}/#/doc/${paperId}`;
}

async function findInLibrary(cfg, paperId) {
  const data = await callApi(cfg, 'GET', `/api/publish/exists?id=${encodeURIComponent(paperId)}`);
  return data.exists ? docUrl(cfg, paperId) : null;
}

const FILES = [
  { name: 'original.pdf', key: 'pdf', contentType: 'application/pdf' },
  { name: 'translated.pdf', key: 'translatedPdf', contentType: 'application/pdf' },
  { name: 'result.json', key: 'result', contentType: 'application/json' },
  { name: 'ja_layout.json', key: 'jaLayout', contentType: 'application/json' },
];

// Upload the four files of a local document straight to R2 (via presigned
// URLs from the shared library), then ask the library to list it.
async function publish(cfg, docId) {
  const meta = store.readMeta(docId);
  const result = store.readResult(docId);
  if (!meta || !result) throw new Error('翻訳が完了していない文書は公開できません');
  if (!result.paragraphs.length || !result.paragraphs[0].en_rects) {
    throw new Error('古い形式で処理された文書は公開できません。もう一度アップロードして翻訳し直してください。');
  }
  await ensureTranslatedPdf(docId);

  const p = store.paths(docId);
  const paperId = meta.hash || store.hashBuffer(fs.readFileSync(p.pdf));
  const files = FILES.map((f) => ({ name: f.name, contentType: f.contentType, size: fs.statSync(p[f.key]).size }));

  const { uploads } = await callApi(cfg, 'POST', '/api/publish', { id: paperId, files });
  for (const f of FILES) {
    const res = await fetch(uploads[f.name], {
      method: 'PUT',
      headers: { 'Content-Type': f.contentType },
      body: fs.readFileSync(p[f.key]),
    });
    if (!res.ok) throw new Error(`${f.name} のアップロードに失敗しました (HTTP ${res.status})`);
  }

  await callApi(cfg, 'POST', `/api/publish/${encodeURIComponent(paperId)}/finalize`, {
    filename: meta.filename,
    title: result.title || '',
    translator: result.translator || null,
  });
  return docUrl(cfg, paperId);
}

module.exports = {
  loadShareConfig, verifyShareConfig, saveShareConfig, clearShareConfig, findInLibrary, publish, claim, releaseClaim, listClaims, listDocuments,
};
