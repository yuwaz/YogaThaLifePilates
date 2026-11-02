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

  // Sends the real notification title/body. Data carries the persisted
  // notification id, the notification type, and a small allowlist of scheduling
  // metadata (reservation/salon/date/time/recurrence identifiers) so clients can
  // deep-link. All data values are strings (FCM requirement). The
  // notificationId is the persisted Notifications.id passed by the caller —
  // never derived from the notification payload. The raw payload is never sent:
  // only the allowlisted scalar fields below, so no secrets or unrelated
  // personal data (debt amounts, phone numbers, etc.) can leak into FCM.
  const DATA_METADATA_KEYS = [
    'reservationId',
    'recurrenceGroupId',
    'salonId',
    'date',
    'time',
    'oldDate',
    'oldTime',
    'newDate',
    'newTime',
    'firstDate',
  ];

  function safeDataString(value) {
    if (value === null || value === undefined) return null;
    const t = typeof value;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') return null;
    const s = String(value);
    return s.length <= 128 ? s : null;
  }

  async function send({ token, notificationId, title, body, payload, type, platform }) {
    const messaging = getMessaging();
    const safeNotificationId = notificationId != null ? String(notificationId) : '';

    const data = {
      notificationId: safeNotificationId,
      type: safeDataString(type) || 'notification',
    };
    if (payload && typeof payload === 'object') {
      for (const key of DATA_METADATA_KEYS) {
        const s = safeDataString(payload[key]);
        if (s !== null) data[key] = s;
      }
    }

    const message = {
      token,
      notification: {
        title: typeof title === 'string' && title.trim() !== '' ? title : 'CepStudio',
        body: typeof body === 'string' && body.trim() !== '' ? body : 'Yeni bir bildiriminiz var.',
      },
      data,
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
