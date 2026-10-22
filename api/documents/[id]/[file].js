const { isViewer, requirePublisher } = require('../../_lib/auth');
const r2 = require('../../_lib/r2');

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader('Location', url);
  // Presigned URLs expire; never let a browser or CDN cache the redirect.
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

// Mirrors the local server's per-document endpoints. Large files are not
// proxied (Vercel functions can only return ~4.5MB); the browser is sent to a
// presigned R2 URL and downloads directly from R2.
// Readable by a logged-in browser, or by a translator's local app with the
// shared password (to take a published paper back as a draft and fix it).
module.exports = async (req, res) => {
  if (!isViewer(req) && !(await requirePublisher(req, res))) return;
  const { id, file } = req.query;
  if (!r2.isPaperId(id)) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  if (file === 'status') {
    res.status(200).json({ state: 'done', processedChunks: 0, totalChunks: 0, message: '' });
    return;
  }

  const { papers } = await r2.readIndex();
  const meta = papers.find((p) => p.id === id);
  if (!meta) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  if (file === 'result') {
    const got = await r2.getJson(r2.paperKey(id, 'result.json'));
    if (!got) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(200).json({ ...got.data, meta });
    return;
  }

  if (file === 'ja-layout') {
    redirect(res, await r2.presignGet(r2.paperKey(id, 'ja_layout.json')));
    return;
  }

  if (file === 'original.pdf') {
    redirect(res, await r2.presignGet(r2.paperKey(id, 'original.pdf')));
    return;
  }

  if (file === 'translated.pdf') {
    const downloadName = req.query.download
      ? `${(meta.filename || 'document.pdf').replace(/\.pdf$/i, '')}-JA.pdf`
      : undefined;
    redirect(res, await r2.presignGet(r2.paperKey(id, 'translated.pdf'), { downloadName }));
    return;
  }

  res.status(404).json({ error: 'not found' });
};
