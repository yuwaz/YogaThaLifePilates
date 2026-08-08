const { PlatformAdmin } = require('../models');
const { verifyPlatformAccessToken } = require('../services/platformAuthTokenService');

function sendAuthRequired(res) {
  return res.status(401).json({ error: 'PLATFORM_AUTH_REQUIRED' });
}

function sendAccessDenied(res) {
  return res.status(403).json({ error: 'PLATFORM_ACCESS_DENIED' });
}

function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  return match[1] ? match[1].trim() : null;
}

async function authenticatePlatformAdmin(req, res, next) {
  try {
    const token = extractBearerToken(req.headers && req.headers.authorization);
    if (!token) {
      return sendAuthRequired(res);
    }

    let verified;
    try {
      verified = verifyPlatformAccessToken(token);
    } catch (err) {
      return sendAuthRequired(res);
    }

    const platformAdmin = await PlatformAdmin.findByPk(verified.platformAdminId, {
      attributes: ['id', 'email', 'status', 'mfaRequired', 'lastLoginAt'],
    });

    if (!platformAdmin) {
      return sendAccessDenied(res);
    }

    if (platformAdmin.status !== 'active') {
      return sendAccessDenied(res);
    }

    req.platformAdmin = {
      id: platformAdmin.id,
      email: platformAdmin.email,
      status: platformAdmin.status,
      mfaRequired: Boolean(platformAdmin.mfaRequired),
      lastLoginAt: platformAdmin.lastLoginAt,
    };

    return next();
  } catch (err) {
    return sendAuthRequired(res);
  }
}

module.exports = {
  authenticatePlatformAdmin,
};