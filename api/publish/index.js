const { requireUploader } = require('../_lib/auth');
const r2 = require('../_lib/r2');

const MAX_FILE_BYTES = 100 * 1024 * 1024;

// Step 1 of publishing: hand the translator's PC presigned PUT URLs so it can
// upload the paper's four files straight to R2.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  if (!requireUploader(req, res)) return;

  const { id, files } = req.body || {};
  if (!r2.isPaperId(id) || !Array.isArray(files)) {
    res.status(400).json({ error: 'invalid request' });
    return;
  }
  const names = files.map((f) => f.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...r2.PAPER_FILES].sort())) {
    res.status(400).json({ error: `files must be exactly: ${r2.PAPER_FILES.join(', ')}` });
    return;
  }
  if (files.some((f) => !(f.size > 0) || f.size > MAX_FILE_BYTES)) {
    res.status(400).json({ error: 'ファイルサイズが大きすぎます（1ファイル100MBまで）' });
    return;
  }

  const uploads = {};
  for (const f of files) {
    const contentType = f.name.endsWith('.pdf') ? 'application/pdf' : 'application/json';
    uploads[f.name] = await r2.presignPut(r2.paperKey(id, f.name), contentType);
  }
  res.status(200).json({ uploads });
};
