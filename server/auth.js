'use strict';

function createRequireAuth(getSettings) {
  let setupCompleted = false;

  return async function requireAuth(req, res, next) {
    if (req.session?.authenticated) return next();

    if (!setupCompleted) {
      const settings = await getSettings();
      if (settings.ADMIN_PASSWORD) {
        setupCompleted = true;
      } else if (req.path.startsWith('/api/')) {
        return res.status(401).json({ ok: false, error: 'Setup required' });
      } else {
        return res.redirect('/setup.html');
      }
    }

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
  };
}

module.exports = { createRequireAuth };
