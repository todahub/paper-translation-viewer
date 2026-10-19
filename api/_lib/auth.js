// Friends-only access: one shared viewing password (exchanged for a signed
// session cookie) plus per-person upload tokens for publishing.

const crypto = require('crypto');

const COOKIE = 'session';
const SESSION_DAYS = 30;

function hmac(value) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update(value).digest('hex');
}

// Compare via fixed-length digests so neither length nor content leaks timing.
function safeEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

function checkPassword(password) {
  return !!process.env.VIEW_PASSWORD && safeEqual(password || '', process.env.VIEW_PASSWORD);
}

function sessionCookie() {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const value = `${exp}.${hmac(String(exp))}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function isViewer(req) {
  const value = readCookie(req, COOKIE);
  if (!value || !process.env.SESSION_SECRET) return false;
  const [exp, sig] = value.split('.');
  return !!sig && safeEqual(sig, hmac(exp)) && Number(exp) > Date.now();
}

// UPLOAD_TOKENS="alice:tok1,bob:tok2" -> the publisher's name, or null.
function uploaderName(req) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  for (const entry of (process.env.UPLOAD_TOKENS || '').split(',')) {
    const i = entry.indexOf(':');
    if (i <= 0) continue;
    if (safeEqual(m[1].trim(), entry.slice(i + 1).trim())) return entry.slice(0, i).trim();
  }
  return null;
}

function requireViewer(req, res) {
  if (isViewer(req)) return true;
  res.status(401).json({ error: 'ログインが必要です' });
  return false;
}

function requireUploader(req, res) {
  const name = uploaderName(req);
  if (name) return name;
  res.status(401).json({ error: '公開用トークンが正しくありません' });
  return null;
}

module.exports = { checkPassword, sessionCookie, isViewer, requireViewer, requireUploader, uploaderName };
