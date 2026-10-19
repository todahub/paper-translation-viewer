const { requireUploader } = require('../_lib/auth');
const r2 = require('../_lib/r2');

// Lets a translator's PC skip translating a paper someone already shared.
module.exports = async (req, res) => {
  if (!requireUploader(req, res)) return;
  const { id } = req.query;
  if (!r2.isPaperId(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const { papers } = await r2.readIndex();
  res.status(200).json({ exists: papers.some((p) => p.id === id) });
};
