const { OAuth2Client } = require('google-auth-library');

const DEFAULT_ISSUERS = Object.freeze([
  'https://accounts.google.com',
  'accounts.google.com',
]);

class GooglePubSubAuthError extends Error {
  constructor(code, message, httpStatus = 401) {
    super(message);
    this.name = 'GooglePubSubAuthError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

class GooglePubSubConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GooglePubSubConfigurationError';
    this.code = code;
    this.httpStatus = 500;
  }
}

function normalizeString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseBearerToken(authorizationHeader) {
  const normalized = normalizeString(authorizationHeader);
  if (!normalized) {
    throw new GooglePubSubAuthError('GOOGLE_PUBSUB_AUTH_MISSING', 'Authorization header is required', 401);
  }

  const match = normalized.match(/^Bearer\s+(.+)$/i);
  if (!match || !normalizeString(match[1])) {
    throw new GooglePubSubAuthError('GOOGLE_PUBSUB_AUTH_INVALID', 'Authorization header must use Bearer authentication', 401);
  }

  return match[1].trim();
}

function parseAllowedIssuers(rawValue = process.env.GOOGLE_PUBSUB_PUSH_ISSUERS) {
  if (typeof rawValue === 'undefined' || rawValue === null || String(rawValue).trim() === '') {
    return new Set(DEFAULT_ISSUERS);
  }

  const issuers = String(rawValue)
    .split(',')
    .map((value) => normalizeString(value))
    .filter(Boolean);

  if (issuers.length === 0) {
    throw new GooglePubSubConfigurationError('GOOGLE_PUBSUB_ISSUERS_INVALID', 'Google Pub/Sub issuer configuration is invalid');
  }

  return new Set(issuers);
}

function createGooglePubSubOidcClient() {
  return new OAuth2Client();
}

function extractPayload(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }

  if (typeof result.getPayload === 'function') {
    return result.getPayload();
  }

  if (result.payload && typeof result.payload === 'object') {
    return result.payload;
  }

  return result;
}

async function verifyGooglePubSubPushRequest({
  authorizationHeader,
  expectedAudience,
  expectedServiceAccountEmail,
  expectedIssuers,
  dependencies = {},
} = {}) {
  const token = parseBearerToken(authorizationHeader);
  const audience = normalizeString(expectedAudience) || normalizeString(process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE);
  const serviceAccountEmail = normalizeString(expectedServiceAccountEmail) || normalizeString(process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL);

  if (!audience || !serviceAccountEmail) {
    throw new GooglePubSubConfigurationError('GOOGLE_PUBSUB_PUSH_CONFIGURATION_INVALID', 'Google Pub/Sub push configuration is invalid');
  }

  const issuers = parseAllowedIssuers(expectedIssuers);
  const verifier = typeof dependencies.tokenVerifier === 'function'
    ? dependencies.tokenVerifier
    : async ({ idToken, audience: verifierAudience }) => {
      const client = dependencies.oauth2Client || createGooglePubSubOidcClient();
      return client.verifyIdToken({
        idToken,
        audience: verifierAudience,
      });
    };

  let verification;
  try {
    verification = await verifier({ idToken: token, audience });
  } catch (error) {
    throw new GooglePubSubAuthError('GOOGLE_PUBSUB_AUTH_FAILED', 'Google Pub/Sub push authentication failed', 403);
  }

  const payload = extractPayload(verification);
  if (!payload || typeof payload !== 'object') {
    throw new GooglePubSubAuthError('GOOGLE_PUBSUB_AUTH_FAILED', 'Google Pub/Sub push authentication failed', 403);
  }

  const payloadAudience = normalizeString(payload.aud);
  const payloadEmail = normalizeString(payload.email);
  const payloadIssuer = normalizeString(payload.iss);
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';

  if (payloadAudience !== audience) {
    throw new GooglePubSubAuthError('GOOGLE_PUBSUB_AUTH_AUDIENCE_MISMATCH', 'Google Pub/Sub push authentication failed', 403);
  }

  if (payloadEmail !== serviceAccountEmail) {
    throw new GooglePubSubAuthError('GOOGLE_PUBSUB_AUTH_EMAIL_MISMATCH', 'Google Pub/Sub push authentication failed', 403);
  }

  if (!emailVerified) {
    throw new GooglePubSubAuthError('GOOGLE_PUBSUB_AUTH_EMAIL_UNVERIFIED', 'Google Pub/Sub push authentication failed', 403);
  }

  if (!payloadIssuer || !issuers.has(payloadIssuer)) {
    throw new GooglePubSubAuthError('GOOGLE_PUBSUB_AUTH_ISSUER_INVALID', 'Google Pub/Sub push authentication failed', 403);
  }

  return {
    verified: true,
  };
}

module.exports = {
  GooglePubSubAuthError,
  GooglePubSubConfigurationError,
  createGooglePubSubOidcClient,
  parseBearerToken,
  parseAllowedIssuers,
  verifyGooglePubSubPushRequest,
};