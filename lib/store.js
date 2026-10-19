const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function docDir(id) {
  return path.join(DATA_DIR, id);
}

function paths(id) {
  const dir = docDir(id);
  return {
    dir,
    pdf: path.join(dir, 'original.pdf'),
    translatedPdf: path.join(dir, 'translated.pdf'),
    jaLayout: path.join(dir, 'ja_layout.json'),
    meta: path.join(dir, 'meta.json'),
    status: path.join(dir, 'status.json'),
    result: path.join(dir, 'result.json'),
  };
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function createDocument(filename, hash) {
  ensureDataDir();
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const p = paths(id);
  fs.mkdirSync(p.dir, { recursive: true });
  const meta = { id, filename, createdAt: new Date().toISOString(), hash };
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2));
  writeStatus(id, { state: 'processing', processedChunks: 0, totalChunks: 0, message: '' });
  return id;
}

// Find an already-processed (or in-progress) document with the same PDF
// content, so re-uploading the same file reuses the existing translation
// instead of paying for it again.
function findByHash(hash) {
  const docs = listDocuments();
  return docs.find((d) => d.hash === hash && d.status !== 'error') || null;
}

function writeStatus(id, status) {
  fs.writeFileSync(paths(id).status, JSON.stringify(status, null, 2));
}

function readStatus(id) {
  const p = paths(id).status;
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readMeta(id) {
  const p = paths(id).meta;
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeResult(id, result) {
  fs.writeFileSync(paths(id).result, JSON.stringify(result, null, 2));
}

function readResult(id) {
  const p = paths(id).result;
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Per-paragraph translation cache shared by all documents, so a run that
// stopped halfway (or a re-upload of a revised paper) doesn't pay twice.
const CACHE_DIR = path.join(DATA_DIR, '_cache');

function readTranslationCache(key) {
  const p = path.join(CACHE_DIR, key + '.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeTranslationCache(key, value) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, key + '.json'), JSON.stringify(value));
}

function listDocuments() {
  ensureDataDir();
  const ids = fs.readdirSync(DATA_DIR).filter((f) => fs.statSync(path.join(DATA_DIR, f)).isDirectory());
  const docs = ids
    .map((id) => {
      const meta = readMeta(id);
      const status = readStatus(id);
      if (!meta) return null;
      return { ...meta, status: status ? status.state : 'unknown' };
    })
    .filter(Boolean);
  docs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return docs;
}

module.exports = {
  DATA_DIR,
  paths,
  createDocument,
  writeStatus,
  readStatus,
  readMeta,
  writeResult,
  readResult,
  listDocuments,
  hashBuffer,
  findByHash,
  readTranslationCache,
  writeTranslationCache,
};
