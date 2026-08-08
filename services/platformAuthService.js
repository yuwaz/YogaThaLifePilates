const bcrypt = require('bcrypt');
const { PlatformAdmin } = require('../models');
const { signPlatformAccessToken } = require('./platformAuthTokenService');

function createAuthError(code, message, status = 401) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizePlatformAdminEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function toSafePlatformAdmin(adminLike) {
  const admin = adminLike && typeof adminLike.get === 'function'
    ? adminLike.get({ plain: true })
    : adminLike;

  return {
    id: admin.id,
    email: admin.email,
    status: admin.status,
    mfaRequired: Boolean(admin.mfaRequired),
    lastLoginAt: admin.lastLoginAt,
  };
}

async function authenticatePlatformAdmin({ email, password }) {
  const normalizedEmail = normalizePlatformAdminEmail(email);
  if (!normalizedEmail || typeof password !== 'string' || password.length === 0) {
    throw createAuthError('PLATFORM_INVALID_CREDENTIALS', 'Invalid credentials', 401);
  }

  const admin = await PlatformAdmin.findOne({
    where: { email: normalizedEmail },
  });

  if (!admin) {
    throw createAuthError('PLATFORM_INVALID_CREDENTIALS', 'Invalid credentials', 401);
  }

  const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
  if (!passwordMatches) {
    throw createAuthError('PLATFORM_INVALID_CREDENTIALS', 'Invalid credentials', 401);
  }

  if (admin.status !== 'active') {
    throw createAuthError('PLATFORM_ACCESS_DENIED', 'Platform access denied', 403);
  }

  if (admin.mfaRequired) {
    throw createAuthError('PLATFORM_MFA_REQUIRED', 'MFA is required but not yet supported', 403);
  }

  admin.lastLoginAt = new Date();
  await admin.save({ fields: ['lastLoginAt'] });

  const accessToken = signPlatformAccessToken({ platformAdminId: admin.id });

  return {
    accessToken,
    platformAdmin: toSafePlatformAdmin(admin),
  };
}

module.exports = {
  normalizePlatformAdminEmail,
  authenticatePlatformAdmin,
  toSafePlatformAdmin,
};