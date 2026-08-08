const fs = require('fs');
const path = require('path');

const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

class GooglePlayConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GooglePlayConfigurationError';
    this.code = code;
  }
}

class GooglePlayAPIError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GooglePlayAPIError';
    this.code = code;
  }
}

class GooglePlayRetryableError extends GooglePlayAPIError {
  constructor(code = 'GOOGLE_PLAY_API_RETRYABLE', message = 'Google Play API request failed') {
    super(code, message);
    this.name = 'GooglePlayRetryableError';
    this.retryable = true;
  }
}

class GooglePlayNonRetryableError extends GooglePlayAPIError {
  constructor(code = 'GOOGLE_PLAY_API_NON_RETRYABLE', message = 'Google Play API request failed') {
    super(code, message);
    this.name = 'GooglePlayNonRetryableError';
    this.retryable = false;
  }
}

class GooglePlayNotFoundError extends GooglePlayNonRetryableError {
  constructor(code = 'GOOGLE_PLAY_API_NOT_FOUND', message = 'Google Play resource not found') {
    super(code, message);
    this.name = 'GooglePlayNotFoundError';
  }
}

class GooglePlayRateLimitError extends GooglePlayRetryableError {
  constructor(code = 'GOOGLE_PLAY_API_RATE_LIMIT', message = 'Google Play API rate limit exceeded') {
    super(code, message);
    this.name = 'GooglePlayRateLimitError';
  }
}

let cachedClient = null;
let cachedSignature = null;

function normalizeString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseEnvironment(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return 'production';
  }

  if (normalized === 'test' || normalized === 'production') {
    return normalized;
  }

  throw new GooglePlayConfigurationError(
    'GOOGLE_PLAY_ENVIRONMENT_INVALID',
    'Google Play environment must be test or production'
  );
}

function parseRequiredString(value, code, message) {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new GooglePlayConfigurationError(code, message);
  }

  return normalized;
}

function normalizeCredentialObject(input) {
  if (!input || typeof input !== 'object') {
    throw new GooglePlayConfigurationError(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_INVALID',
      'Google Play service account credentials are invalid'
    );
  }

  const credentials = { ...input };
  if (typeof credentials.private_key === 'string') {
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }

  if (!normalizeString(credentials.client_email) || !normalizeString(credentials.private_key)) {
    throw new GooglePlayConfigurationError(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_INVALID',
      'Google Play service account credentials are invalid'
    );
  }

  return credentials;
}

function parseInlineServiceAccountJson(rawJson) {
  try {
    const parsed = JSON.parse(rawJson);
    return normalizeCredentialObject(parsed);
  } catch (error) {
    throw new GooglePlayConfigurationError(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_INVALID',
      'Google Play service account JSON is invalid'
    );
  }
}

function parseServiceAccountFromFile(filePathRaw) {
  const absolutePath = path.isAbsolute(filePathRaw) ? filePathRaw : path.resolve(filePathRaw);

  let contents;
  try {
    contents = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new GooglePlayConfigurationError(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_PATH_READ_FAILED',
      'Google Play service account file could not be read'
    );
  }

  try {
    const parsed = JSON.parse(contents);
    return normalizeCredentialObject(parsed);
  } catch (error) {
    throw new GooglePlayConfigurationError(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_PATH_INVALID',
      'Google Play service account file is invalid'
    );
  }
}

function readConfigValue(source, key, envKey) {
  if (source && Object.prototype.hasOwnProperty.call(source, key)) {
    return normalizeString(source[key]);
  }

  return normalizeString(process.env[envKey]);
}

function resolveServiceAccountCredentials(config = {}) {
  const source = config || {};
  const inlineJson = readConfigValue(source, 'serviceAccountJson', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
  const serviceAccountPath = readConfigValue(source, 'serviceAccountPath', 'GOOGLE_PLAY_SERVICE_ACCOUNT_PATH');

  if (inlineJson && serviceAccountPath) {
    throw new GooglePlayConfigurationError(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_SOURCE_AMBIGUOUS',
      'Provide either GOOGLE_PLAY_SERVICE_ACCOUNT_JSON or GOOGLE_PLAY_SERVICE_ACCOUNT_PATH, not both'
    );
  }

  if (!inlineJson && !serviceAccountPath) {
    throw new GooglePlayConfigurationError(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_REQUIRED',
      'Google Play service account credentials are required'
    );
  }

  if (inlineJson) {
    return {
      source: 'inline_json',
      credentials: parseInlineServiceAccountJson(inlineJson),
    };
  }

  return {
    source: 'file_path',
    credentials: parseServiceAccountFromFile(serviceAccountPath),
  };
}

function getGooglePlayClientConfig(input = {}) {
  const source = input || {};
  const packageName = parseRequiredString(
    readConfigValue(source, 'packageName', 'GOOGLE_PLAY_PACKAGE_NAME'),
    'GOOGLE_PLAY_PACKAGE_NAME_REQUIRED',
    'GOOGLE_PLAY_PACKAGE_NAME is required'
  );

  const projectId = readConfigValue(source, 'projectId', 'GOOGLE_PLAY_PROJECT_ID');
  const environment = parseEnvironment(
    Object.prototype.hasOwnProperty.call(source, 'environment')
      ? source.environment
      : process.env.GOOGLE_PLAY_ENVIRONMENT
  );

  const resolvedCredentials = resolveServiceAccountCredentials(source);

  return {
    packageName,
    projectId,
    environment,
    credentialsSource: resolvedCredentials.source,
    credentials: resolvedCredentials.credentials,
  };
}

function buildConfigSignature(config) {
  return JSON.stringify({
    packageName: config.packageName,
    projectId: config.projectId || null,
    environment: config.environment,
    credentialsSource: config.credentialsSource,
    clientEmailLength: String((config.credentials.client_email || '').length),
    privateKeyLength: String((config.credentials.private_key || '').length),
  });
}

function createGooglePlayDeveloperClient({ environment, config } = {}, dependencies = {}) {
  let google;
  try {
    const googleapisModule = dependencies.googleapisModule || require('googleapis');
    google = dependencies.google || googleapisModule.google;
  } catch (error) {
    throw new GooglePlayConfigurationError(
      'GOOGLE_PLAY_LIBRARY_IMPORT_FAILED',
      'Failed to import googleapis library'
    );
  }

  const resolvedConfig = getGooglePlayClientConfig({
    ...(config || {}),
    environment,
  });

  const GoogleAuthCtor = dependencies.GoogleAuthCtor || (google && google.auth && google.auth.GoogleAuth);
  if (typeof GoogleAuthCtor !== 'function') {
    throw new GooglePlayConfigurationError(
      'GOOGLE_PLAY_AUTH_CONSTRUCTOR_MISSING',
      'Google Play auth constructor is unavailable'
    );
  }

  const auth = new GoogleAuthCtor({
    credentials: resolvedConfig.credentials,
    scopes: [ANDROID_PUBLISHER_SCOPE],
    projectId: resolvedConfig.projectId || resolvedConfig.credentials.project_id || undefined,
  });

  const androidPublisherFactory = dependencies.androidPublisherFactory
    || (typeof google.androidpublisher === 'function'
      ? google.androidpublisher.bind(google)
      : null);

  if (!androidPublisherFactory) {
    throw new GooglePlayConfigurationError(
      'GOOGLE_PLAY_ANDROID_PUBLISHER_UNAVAILABLE',
      'Android Publisher API v3 client is unavailable'
    );
  }

  const client = androidPublisherFactory({
    version: 'v3',
    auth,
  });

  return {
    client,
    auth,
    google,
    packageName: resolvedConfig.packageName,
    environment: resolvedConfig.environment,
    scope: ANDROID_PUBLISHER_SCOPE,
    config: {
      packageName: resolvedConfig.packageName,
      environment: resolvedConfig.environment,
      projectId: resolvedConfig.projectId,
      credentialsSource: resolvedConfig.credentialsSource,
    },
  };
}

function getGooglePlayDeveloperClient(options = {}) {
  const resolved = createGooglePlayDeveloperClient(
    {
      environment: options.environment,
      config: options.config,
    },
    options.dependencies || {}
  );

  const signature = buildConfigSignature({
    packageName: resolved.config.packageName,
    environment: resolved.config.environment,
    projectId: resolved.config.projectId,
    credentialsSource: resolved.config.credentialsSource,
    credentials: {
      client_email: (options.config && options.config.serviceAccountJson) ? 'inline' : 'path_or_env',
      private_key: (options.config && options.config.serviceAccountJson) ? 'inline' : 'path_or_env',
    },
  });

  if (!cachedClient || cachedSignature !== signature || options.forceNew === true) {
    cachedClient = resolved;
    cachedSignature = signature;
  }

  return cachedClient;
}

function clearGooglePlayDeveloperClientCache() {
  cachedClient = null;
  cachedSignature = null;
}

module.exports = {
  ANDROID_PUBLISHER_SCOPE,
  GooglePlayConfigurationError,
  GooglePlayAPIError,
  GooglePlayRetryableError,
  GooglePlayNonRetryableError,
  GooglePlayNotFoundError,
  GooglePlayRateLimitError,
  getGooglePlayClientConfig,
  createGooglePlayDeveloperClient,
  getGooglePlayDeveloperClient,
  clearGooglePlayDeveloperClientCache,
};
