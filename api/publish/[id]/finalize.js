const { requireUploader } = require('../../_lib/auth');
const r2 = require('../../_lib/r2');

const MAX_ATTEMPTS = 5;

// Step 2 of publishing: once all four files are in R2, add the paper to
// index.json. The write is conditional on the index being unchanged since we
// read it, so two friends publishing at once can't overwrite each other.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const publisher = requireUploader(req, res);
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

  const { filename, translator } = req.body || {};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { papers, etag } = await r2.readIndex();
    const now = new Date().toISOString();
    const prev = papers.find((p) => p.id === id);
    const entry = {
      id,
      filename: String(filename || (prev && prev.filename) || 'document.pdf').slice(0, 300),
      createdAt: prev ? prev.createdAt : now,
      updatedAt: now,
      publishedBy: publisher,
      translator: translator || null,
    };
    const next = { papers: [...papers.filter((p) => p.id !== id), entry] };
    try {
      await r2.putJson(r2.INDEX_KEY, next, etag ? { ifMatch: etag } : { ifNoneMatch: '*' });
      res.status(200).json({ ok: true });
      return;
    } catch (err) {
      const status = err.$metadata && err.$metadata.httpStatusCode;
      if (status !== 412 && status !== 409) throw err;
    }
  }
  res.status(409).json({ error: '同時に公開が行われたため更新できませんでした。もう一度お試しください。' });
};
