// Friends-only access with one shared password: the browser exchanges it for
// a signed session cookie, and a translator's local app sends it directly
// when publishing (anyone who can log in can also publish).

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

function requireViewer(req, res) {
  if (isViewer(req)) return true;
  res.status(401).json({ error: 'ログインが必要です' });
  return false;
}

// Publishing from a translator's local app: "Authorization: Bearer <password>"
// plus a self-declared display name in X-Publisher-Name (URI-encoded, since
// headers must be ASCII). Returns the name, or null after sending 401.
async function requirePublisher(req, res) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
  if (!m || !checkPassword(m[1].trim())) {
    await new Promise((r) => setTimeout(r, 800));
    res.status(401).json({ error: 'パスワードが違います' });
    return null;
  }
  let name = '';
  try {
    name = decodeURIComponent(req.headers['x-publisher-name'] || '');
  } catch {
    name = '';
  }
  return name.trim().slice(0, 40) || '名前なし';
}

module.exports = { checkPassword, sessionCookie, isViewer, requireViewer, requirePublisher };
