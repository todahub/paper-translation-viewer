const { isViewer } = require('./_lib/auth');

// The shared viewer can't run anyone's Claude CLI, so it is read-only.
// `build` is the deployed commit, to tell which version a URL is serving.
module.exports = (req, res) => {
  res.status(200).json({
    mode: 'web',
    authenticated: isViewer(req),
    canTranslate: false,
    canPublish: false,
    build: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7),
  });
};
