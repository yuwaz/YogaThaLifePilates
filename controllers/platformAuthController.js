const { authenticatePlatformAdmin } = require('../services/platformAuthService');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

async function login(req, res) {
  const { email, password } = req.body || {};
  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    return res.status(400).json({ error: 'INVALID_REQUEST' });
  }

  try {
    const result = await authenticatePlatformAdmin({ email, password });
    return res.status(200).json({
      accessToken: result.accessToken,
      platformAdmin: result.platformAdmin,
    });
  } catch (err) {
    if (err && err.code === 'PLATFORM_MFA_REQUIRED') {
      return res.status(403).json({ error: 'PLATFORM_MFA_REQUIRED' });
    }

    if (err && err.code === 'PLATFORM_ACCESS_DENIED') {
      return res.status(403).json({ error: 'PLATFORM_ACCESS_DENIED' });
    }

    if (err && err.code === 'PLATFORM_INVALID_CREDENTIALS') {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    }

    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
}

async function me(req, res) {
  if (!req.platformAdmin) {
    return res.status(401).json({ error: 'PLATFORM_AUTH_REQUIRED' });
  }

  return res.status(200).json({
    platformAdmin: req.platformAdmin,
  });
}

module.exports = {
  login,
  me,
};