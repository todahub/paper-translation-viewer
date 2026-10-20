const { requireViewer } = require('../_lib/auth');
const { readIndex } = require('../_lib/r2');

// Same shape as the local server's /api/documents so the page needs no changes.
module.exports = async (req, res) => {
  if (!requireViewer(req, res)) return;
  const { papers } = await readIndex();
  const docs = papers
    .map((p) => ({
      id: p.id,
      filename: p.filename,
      title: p.title,
      createdAt: p.createdAt,
      status: 'done',
      publishedBy: p.publishedBy,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.status(200).json(docs);
};
