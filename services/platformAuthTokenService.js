const jwt = require('jsonwebtoken');

const PLATFORM_ISSUER = 'yogatha-platform';
const PLATFORM_AUDIENCE = 'backoffice';
const DEFAULT_PLATFORM_EXPIRES_IN = '30m';

function createTokenError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getPlatformJwtSecret() {
  const secret = process.env.PLATFORM_JWT_SECRET;
  if (typeof secret !== 'string' || secret.trim().length < 16) {
    throw createTokenError(
      'PLATFORM_JWT_SECRET_INVALID',
      'PLATFORM_JWT_SECRET must be a non-empty string with at least 16 characters'
    );
  }
  return secret;
}

function getPlatformAccessTokenExpiresIn() {
  const configured = process.env.PLATFORM_JWT_EXPIRES_IN;
  if (typeof configured !== 'string' || configured.trim() === '') {
    return DEFAULT_PLATFORM_EXPIRES_IN;
  }
  return configured.trim();
}

function normalizePlatformAdminId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createTokenError('PLATFORM_TOKEN_SUBJECT_INVALID', 'Platform token subject must be a positive integer');
  }
  return parsed;
}

function signPlatformAccessToken({ platformAdminId }) {
  const subjectId = normalizePlatformAdminId(platformAdminId);
  const secret = getPlatformJwtSecret();
  const expiresIn = getPlatformAccessTokenExpiresIn();

  try {
    return jwt.sign(
      { tokenType: 'platform' },
      secret,
      {
        subject: String(subjectId),
        audience: PLATFORM_AUDIENCE,
        issuer: PLATFORM_ISSUER,
        expiresIn,
      }
    );
  } catch (err) {
    throw createTokenError('PLATFORM_TOKEN_SIGN_FAILED', `Failed to sign platform token: ${err.message}`);
  }
}

function verifyPlatformAccessToken(token) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw createTokenError('PLATFORM_TOKEN_INVALID', 'Platform token is required');
  }

  const secret = getPlatformJwtSecret();

  let decoded;
  try {
    decoded = jwt.verify(token, secret, {
      issuer: PLATFORM_ISSUER,
      audience: PLATFORM_AUDIENCE,
    });
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      throw createTokenError('PLATFORM_TOKEN_EXPIRED', 'Platform token has expired');
    }
    throw createTokenError('PLATFORM_TOKEN_INVALID', 'Platform token is invalid');
  }

  if (!decoded || typeof decoded !== 'object') {
    throw createTokenError('PLATFORM_TOKEN_INVALID', 'Platform token payload is invalid');
  }

  if (decoded.tokenType !== 'platform') {
    throw createTokenError('PLATFORM_TOKEN_INVALID', 'Platform token type is invalid');
  }

  const platformAdminId = normalizePlatformAdminId(decoded.sub);

  return {
    platformAdminId,
    tokenType: decoded.tokenType,
    issuer: decoded.iss,
    audience: decoded.aud,
    expiresAt: typeof decoded.exp === 'number' ? decoded.exp : null,
  };
}

module.exports = {
  PLATFORM_ISSUER,
  PLATFORM_AUDIENCE,
  signPlatformAccessToken,
  verifyPlatformAccessToken,
  getPlatformJwtSecret,
};