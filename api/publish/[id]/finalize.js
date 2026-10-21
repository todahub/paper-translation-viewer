const { requirePublisher } = require('../../_lib/auth');
const r2 = require('../../_lib/r2');

// Step 2 of publishing: once all four files are in R2, add the paper to
// index.json (refusing to replace a paper someone already shared) and take
// it off the "translating" board.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const publisher = await requirePublisher(req, res);
  if (!publisher) return;

  const { id } = req.query;
  if (!r2.isPaperId(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  for (const name of r2.PAPER_FILES) {
    if (!(await r2.exists(r2.paperKey(id, name)))) {
      res.status(400).json({ error: `${name} がアップロードされていません` });
      return;
    }
  }

  const { filename, title, translator, replace } = req.body || {};
  try {
    await r2.updateJson(r2.INDEX_KEY, { papers: [] }, (data) => {
      const papers = data.papers || [];
      const prev = papers.find((p) => p.id === id);
      if (prev && !replace) throw new r2.UpdateAborted('exists');
      const now = new Date().toISOString();
      const entry = {
        id,
        filename: String(filename || 'document.pdf').slice(0, 300),
        title: String(title || '').slice(0, 300),
        createdAt: prev ? prev.createdAt : now,
        ...(prev ? { updatedAt: now } : {}),
        publishedBy: publisher,
        translator: translator || null,
      };
      return { papers: [...papers.filter((p) => p.id !== id), entry] };
    });
  } catch (err) {
    if (err instanceof r2.UpdateAborted) {
      res.status(409).json({ error: 'この論文はすでに共有ライブラリにあります', exists: true });
      return;
    }
    throw err;
  }

  // Best effort: a stale claim would expire on its own anyway.
  try {
    await r2.updateJson(r2.CLAIMS_KEY, { claims: [] }, (data) => ({
      claims: r2.activeClaims(data.claims).filter((c) => c.id !== id),
    }));
  } catch (err) {
    console.warn('could not clear claim', err.message);
  }
  res.status(200).json({ ok: true });
};
