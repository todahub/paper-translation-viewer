const { isViewer, requirePublisher } = require('./_lib/auth');
const r2 = require('./_lib/r2');

// "Who is translating which paper" board, to avoid two friends translating
// the same paper at once.
//   GET                  list active claims (logged-in viewer or local app)
//   POST {id, filename, title, force}  claim a paper (409 if someone else has it)
//   DELETE ?id=          release a claim (translation failed / cancelled)
module.exports = async (req, res) => {
  if (req.method === 'GET') {
    if (!isViewer(req) && !(await requirePublisher(req, res))) return;
    res.status(200).json({ claims: await r2.readClaims() });
    return;
  }

  const name = await requirePublisher(req, res);
  if (!name) return;

  if (req.method === 'DELETE') {
    const { id } = req.query;
    await r2.updateJson(r2.CLAIMS_KEY, { claims: [] }, (data) => ({
      claims: r2.activeClaims(data.claims).filter((c) => !(c.id === id && c.by === name)),
    }));
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'GET, POST or DELETE only' });
    return;
  }

  const { id, filename, title, force } = req.body || {};
  if (!r2.isPaperId(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  try {
    const now = new Date().toISOString();
    await r2.updateJson(r2.CLAIMS_KEY, { claims: [] }, (data) => {
      const claims = r2.activeClaims(data.claims);
      const other = claims.find((c) => c.id === id && c.by !== name);
      if (other && !force) {
        const err = new r2.UpdateAborted('claimed');
        err.claim = other;
        throw err;
      }
      const mine = claims.find((c) => c.id === id && c.by === name);
      const entry = {
        id,
        by: name,
        filename: String(filename || (mine && mine.filename) || '').slice(0, 300),
        title: String(title || (mine && mine.title) || '').slice(0, 300),
        startedAt: mine ? mine.startedAt : now,
        updatedAt: now,
      };
      return { claims: [...claims.filter((c) => !(c.id === id && c.by === name)), entry] };
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof r2.UpdateAborted) {
      res.status(409).json({ error: `${err.claim.by} さんが翻訳中です`, claim: err.claim });
      return;
    }
    throw err;
  }
};
