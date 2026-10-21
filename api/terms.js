const { isViewer, requirePublisher } = require('./_lib/auth');
const r2 = require('./_lib/r2');

// The shared term base.
//   GET                                 all terms (logged-in viewer or local app)
//   POST {terms: [{en, ja}], overwrite}  add terms; existing ones are kept
//                                        unless overwrite (a person corrected them)
module.exports = async (req, res) => {
  if (req.method === 'GET') {
    if (!isViewer(req) && !(await requirePublisher(req, res))) return;
    const got = await r2.getJson(r2.TERMS_KEY);
    res.status(200).json({ terms: (got && got.data.terms) || [] });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'GET or POST only' });
    return;
  }
  const name = await requirePublisher(req, res);
  if (!name) return;

  const { terms, overwrite } = req.body || {};
  const incoming = (Array.isArray(terms) ? terms : [])
    .filter((t) => t && typeof t.en === 'string' && typeof t.ja === 'string' && t.en.trim() && t.ja.trim())
    .slice(0, 1000)
    .map((t) => ({ en: t.en.trim().slice(0, 200), ja: t.ja.trim().slice(0, 200) }));
  const now = new Date().toISOString();
  let added = 0;
  await r2.updateJson(r2.TERMS_KEY, { terms: [] }, (data) => {
    const list = data.terms || [];
    const byKey = new Map(list.map((t, i) => [t.en.toLowerCase(), i]));
    added = 0;
    for (const t of incoming) {
      const i = byKey.get(t.en.toLowerCase());
      if (i === undefined) {
        byKey.set(t.en.toLowerCase(), list.length);
        list.push({ ...t, updatedAt: now });
        added += 1;
      } else if (overwrite && list[i].ja !== t.ja) {
        list[i] = { ...list[i], ja: t.ja, updatedAt: now, edited: true };
        added += 1;
      }
    }
    return { terms: list };
  });
  res.status(200).json({ ok: true, changed: added });
};
