// Firebase Admin FCM push transport. Lazy-initialized: firebase-admin is only
// required and initialized on first send(), never on module import. Credentials
// come from FIREBASE_SERVICE_ACCOUNT_JSON (inline) OR FIREBASE_SERVICE_ACCOUNT_PATH
// (file) — never both, never committed. No service-account data or FCM tokens
// are ever logged.

const path = require('path');
const fs = require('fs');

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

class FirebasePushError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readCredentialSource(env) {
  const inlineJson = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const filePath = env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const hasInline = typeof inlineJson === 'string' && inlineJson.trim() !== '';
  const hasPath = typeof filePath === 'string' && filePath.trim() !== '';

  if (hasInline && hasPath) {
    throw new FirebasePushError(
      'FIREBASE_SERVICE_ACCOUNT_SOURCE_AMBIGUOUS',
      'Provide either FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH, not both'
    );
  }
  if (!hasInline && !hasPath) {
    throw new FirebasePushError(
      'FIREBASE_SERVICE_ACCOUNT_REQUIRED',
      'Firebase service account credentials are not configured'
    );
  }

  let rawJson;
  if (hasInline) {
    rawJson = inlineJson;
  } else {
    let contents;
    try {
      contents = fs.readFileSync(path.resolve(filePath.trim()), 'utf8');
    } catch {
      throw new FirebasePushError('FIREBASE_SERVICE_ACCOUNT_PATH_READ_FAILED', 'Unable to read Firebase service account file');
    }
    rawJson = contents;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new FirebasePushError('FIREBASE_SERVICE_ACCOUNT_JSON_INVALID', 'Firebase service account JSON is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.client_email || !parsed.private_key) {
    throw new FirebasePushError('FIREBASE_SERVICE_ACCOUNT_INVALID', 'Firebase service account credentials are invalid');
  }
  // Normalize escaped newlines in the private key.
  return { ...parsed, private_key: String(parsed.private_key).replace(/\\n/g, '\n') };
}

// Creates the FCM transport. Options:
//   env: environment source (default process.env)
//   admin: injectable firebase-admin module (for tests; lazy-required otherwise)
//   appName: firebase-admin app name (default '[DEFAULT]')
function createFirebasePushTransport({ env = process.env, admin, appName } = {}) {
  let messagingInstance = null;

  function getMessaging() {
    if (messagingInstance) return messagingInstance;
    // firebase-admin 14.x: use the /app and /messaging subpath exports.
    // The top-level default export has initializeApp/cert but NOT credential/apps.
    const appMod = (admin && admin.app) || require('firebase-admin/app');
    const messagingMod = (admin && admin.messaging) || require('firebase-admin/messaging');
    const credentials = readCredentialSource(env);
    const appOptions = { credential: appMod.cert(credentials) };
    const existingApps = appMod.getApps();
    const existing = appName
      ? existingApps.find((a) => a && a.name === appName)
      : existingApps[0];
    const app = existing || appMod.initializeApp(appOptions, appName);
    messagingInstance = messagingMod.getMessaging(app);
    return messagingInstance;
  }

  // Sends a generic, privacy-safe push. Never sends Notification.body or raw
  // payload — only a generic title/body and the persisted notification id in
  // data. All data values are strings (FCM requirement). The notificationId is
  // the persisted Notifications.id passed by the caller — never derived from
  // the notification payload.
  async function send({ token, notificationId, title, body, payload, platform }) {
    const messaging = getMessaging();
    const safeNotificationId = notificationId != null ? String(notificationId) : '';

    const message = {
      token,
      notification: {
        title: 'CepStudio',
        body: 'Yeni bir bildiriminiz var.',
      },
      data: {
        notificationId: safeNotificationId,
        type: 'notification',
      },
    };
    return messaging.send(message);
  }

  function isInvalidTokenError(error) {
    return Boolean(error && error.code && INVALID_TOKEN_CODES.has(error.code));
  }

  return { send, isInvalidTokenError };
}

module.exports = {
  createFirebasePushTransport,
  FirebasePushError,
};
