const { isViewer } = require('./_lib/auth');

// The shared viewer can't run anyone's Claude CLI, so it is read-only.
module.exports = (req, res) => {
  res.status(200).json({
    mode: 'web',
    authenticated: isViewer(req),
    canTranslate: false,
    canPublish: false,
  });
};
