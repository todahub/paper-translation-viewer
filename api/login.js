const { checkPassword, sessionCookie } = require('./_lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const password = req.body && req.body.password;
  if (!checkPassword(password)) {
    // Slow down password guessing a little; there is no per-user lockout.
    await new Promise((r) => setTimeout(r, 800));
    res.status(401).json({ error: 'パスワードが違います' });
    return;
  }
  res.setHeader('Set-Cookie', sessionCookie());
  res.status(200).json({ ok: true });
};
