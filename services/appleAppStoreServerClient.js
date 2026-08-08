const fs = require('fs');
const path = require('path');

class AppleAppStoreServerClientConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppleAppStoreServerClientConfigurationError';
    this.code = code;
  }
}

let cachedClient = null;
let cachedConfigSignature = null;

function getAppleLibrary() {
  try {
    return require('@apple/app-store-server-library');
  } catch (error) {
    throw new AppleAppStoreServerClientConfigurationError(
      'APPLE_SERVER_API_LIBRARY_IMPORT_FAILED',
      'Failed to import App Store Server API library'
    );
  }
}

function parseEnvironment(rawValue) {
  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
  const normalized = raw.toLowerCase();

  if (normalized === 'sandbox') {
    return 'SANDBOX';
  }
  if (normalized === 'production') {
    return 'PRODUCTION';
  }
  if (normalized === 'localtesting' || normalized === 'local_testing') {
    return 'LOCAL_TESTING';
  }
  if (normalized === 'xcode') {
    return 'XCODE';
  }

  throw new AppleAppStoreServerClientConfigurationError(
    'APPLE_SERVER_API_ENVIRONMENT_INVALID',
    'Apple server API environment must be Sandbox or Production'
  );
}

function parseRequiredString(value, code, message) {
  if (typeof value !== 'string') {
    throw new AppleAppStoreServerClientConfigurationError(code, message);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new AppleAppStoreServerClientConfigurationError(code, message);
  }

  return normalized;
}

function resolveSigningKey(config = {}) {
  const inlineKey = Object.prototype.hasOwnProperty.call(config, 'privateKey')
    ? config.privateKey
    : process.env.APPLE_IAP_ASC_PRIVATE_KEY;

  if (typeof inlineKey === 'string' && inlineKey.trim() !== '') {
    return inlineKey.replace(/\\n/g, '\n').trim();
  }

  const keyPathRaw = Object.prototype.hasOwnProperty.call(config, 'privateKeyPath')
    ? config.privateKeyPath
    : process.env.APPLE_IAP_ASC_PRIVATE_KEY_PATH;

  const keyPath = typeof keyPathRaw === 'string' ? keyPathRaw.trim() : '';
  if (!keyPath) {
    throw new AppleAppStoreServerClientConfigurationError(
      'APPLE_SERVER_API_PRIVATE_KEY_REQUIRED',
      'Apple server API private key is required'
    );
  }

  const absolutePath = path.isAbsolute(keyPath) ? keyPath : path.resolve(keyPath);

  try {
    const fileContents = fs.readFileSync(absolutePath, 'utf8');
    const signingKey = String(fileContents || '').trim();
    if (!signingKey) {
      throw new Error('empty file');
    }
    return signingKey;
  } catch (error) {
    throw new AppleAppStoreServerClientConfigurationError(
      'APPLE_SERVER_API_PRIVATE_KEY_READ_FAILED',
      'Apple server API private key could not be read'
    );
  }
}

function getAppStoreClientConfig(input = {}) {
  const keyId = parseRequiredString(
    Object.prototype.hasOwnProperty.call(input, 'keyId') ? input.keyId : process.env.APPLE_IAP_ASC_KEY_ID,
    'APPLE_SERVER_API_KEY_ID_REQUIRED',
    'Apple server API key ID is required'
  );

  const issuerId = parseRequiredString(
    Object.prototype.hasOwnProperty.call(input, 'issuerId') ? input.issuerId : process.env.APPLE_IAP_ASC_ISSUER_ID,
    'APPLE_SERVER_API_ISSUER_ID_REQUIRED',
    'Apple server API issuer ID is required'
  );

  const bundleId = parseRequiredString(
    Object.prototype.hasOwnProperty.call(input, 'bundleId') ? input.bundleId : process.env.APPLE_IAP_BUNDLE_ID,
    'APPLE_SERVER_API_BUNDLE_ID_REQUIRED',
    'Apple server API bundle ID is required'
  );

  const environment = parseEnvironment(
    Object.prototype.hasOwnProperty.call(input, 'environment')
      ? input.environment
      : (process.env.APPLE_IAP_SERVER_API_ENVIRONMENT || process.env.APPLE_IAP_VERIFICATION_ENVIRONMENT || 'Sandbox')
  );

  const signingKey = resolveSigningKey(input);

  return {
    keyId,
    issuerId,
    bundleId,
    environment,
    signingKey,
  };
}

function toClientEnvironmentEnum(appleLib, environment) {
  if (environment === 'SANDBOX') {
    return appleLib.Environment.SANDBOX;
  }
  if (environment === 'PRODUCTION') {
    return appleLib.Environment.PRODUCTION;
  }
  if (environment === 'LOCAL_TESTING') {
    return appleLib.Environment.LOCAL_TESTING;
  }
  if (environment === 'XCODE') {
    return appleLib.Environment.XCODE;
  }

  throw new AppleAppStoreServerClientConfigurationError(
    'APPLE_SERVER_API_ENVIRONMENT_INVALID',
    'Apple server API environment must be Sandbox or Production'
  );
}

function configSignature(config) {
  return JSON.stringify({
    keyId: config.keyId,
    issuerId: config.issuerId,
    bundleId: config.bundleId,
    environment: config.environment,
    signingKeyHash: String(config.signingKey.length),
  });
}

function createAppleAppStoreServerApiClient(config = {}, dependencies = {}) {
  const resolvedConfig = getAppStoreClientConfig(config);
  const appleLib = dependencies.appleLib || getAppleLibrary();

  const client = new appleLib.AppStoreServerAPIClient(
    resolvedConfig.signingKey,
    resolvedConfig.keyId,
    resolvedConfig.issuerId,
    resolvedConfig.bundleId,
    toClientEnvironmentEnum(appleLib, resolvedConfig.environment)
  );

  return {
    client,
    appleLib,
    config: resolvedConfig,
  };
}

function getAppleAppStoreServerApiClient(options = {}) {
  const resolved = createAppleAppStoreServerApiClient(options.config || {}, options.dependencies || {});
  const signature = configSignature(resolved.config);

  if (!cachedClient || cachedConfigSignature !== signature || options.forceNew === true) {
    cachedClient = resolved;
    cachedConfigSignature = signature;
  }

  return cachedClient;
}

function clearAppleAppStoreServerApiClientCache() {
  cachedClient = null;
  cachedConfigSignature = null;
}

module.exports = {
  AppleAppStoreServerClientConfigurationError,
  getAppStoreClientConfig,
  createAppleAppStoreServerApiClient,
  getAppleAppStoreServerApiClient,
  clearAppleAppStoreServerApiClientCache,
};
