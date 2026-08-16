const { authenticatePlatformAdmin } = require('../services/platformAuthService');

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const loginAttempts = new Map();

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeLoginKeyPart(value) {
  if (typeof value !== 'string') {
    return 'unknown';
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '' ? 'unknown' : normalized;
}

function getLoginThrottleKey(req, email) {
  const ip = typeof req.ip === 'string' && req.ip.trim() ? req.ip.trim() : 'unknown-ip';
  return `${ip}|${normalizeLoginKeyPart(email)}`;
}

function pruneExpiredLoginAttempts(now = Date.now()) {
  for (const [key, entry] of loginAttempts.entries()) {
    if (!entry || now >= entry.expiresAt) {
      loginAttempts.delete(key);
    }
  }
}

function isLoginThrottled(key, now = Date.now()) {
  const entry = loginAttempts.get(key);
  if (!entry) {
    return false;
  }

  if (now >= entry.expiresAt) {
    loginAttempts.delete(key);
    return false;
  }

  return entry.failures >= LOGIN_RATE_LIMIT_MAX_FAILURES;
}

function recordFailedLoginAttempt(key, now = Date.now()) {
  const entry = loginAttempts.get(key);
  if (!entry || now >= entry.expiresAt) {
    loginAttempts.set(key, {
      failures: 1,
      expiresAt: now + LOGIN_RATE_LIMIT_WINDOW_MS,
    });
    return;
  }

  entry.failures += 1;
  loginAttempts.set(key, entry);
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

async function login(req, res) {
  const { email, password } = req.body || {};
  const throttleKey = getLoginThrottleKey(req, email);
  pruneExpiredLoginAttempts();

  if (isLoginThrottled(throttleKey)) {
    return res.status(429).json({ error: 'PLATFORM_LOGIN_RATE_LIMITED' });
  }

  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    recordFailedLoginAttempt(throttleKey);
    return res.status(400).json({ error: 'INVALID_REQUEST' });
  }

  try {
    const result = await authenticatePlatformAdmin({ email, password });
    clearLoginAttempts(throttleKey);
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
      recordFailedLoginAttempt(throttleKey);
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