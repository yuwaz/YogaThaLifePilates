const fs = require('fs');
const path = require('path');
const {
  getAppleProductPlan,
  validateAppleProductConfiguration,
} = require('../models/appleSubscriptionMetadata');
const { isValidAppAccountToken } = require('./appleSubscriptionService');

class AppleVerifierConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppleVerifierConfigurationError';
    this.code = code;
  }
}

class AppleVerifierError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppleVerifierError';
    this.code = code;
  }
}

function parseList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  if (typeof value !== 'string') {
    return [];
  }

  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return defaultValue;
}

function parseAppleAppId(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppleVerifierConfigurationError('APPLE_APP_ID_INVALID', 'APPLE_IAP_APPLE_APP_ID must be a positive integer when set');
  }

  return parsed;
}

function normalizeVerifierEnvironment(value) {
  if (value === 'Sandbox' || value === 'Production') {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === 'sandbox') return 'Sandbox';
    if (trimmed.toLowerCase() === 'production') return 'Production';
  }

  throw new AppleVerifierConfigurationError('APPLE_ENVIRONMENT_INVALID', 'Apple verifier environment must be Sandbox or Production');
}

function getVerifierConfig(input = {}) {
  const source = input || {};
  const bundleId = typeof source.bundleId === 'string'
    ? source.bundleId.trim()
    : String(process.env.APPLE_IAP_BUNDLE_ID || '').trim();
  const appAppleIdRaw = Object.prototype.hasOwnProperty.call(source, 'appAppleId')
    ? source.appAppleId
    : process.env.APPLE_IAP_APPLE_APP_ID;
  const appAppleId = parseAppleAppId(appAppleIdRaw);
  const environmentRaw = Object.prototype.hasOwnProperty.call(source, 'environment')
    ? source.environment
    : process.env.APPLE_IAP_VERIFICATION_ENVIRONMENT || 'Sandbox';
  const environment = normalizeVerifierEnvironment(environmentRaw);
  const rootCaPaths = parseList(
    Object.prototype.hasOwnProperty.call(source, 'rootCaPaths')
      ? source.rootCaPaths
      : process.env.APPLE_IAP_ROOT_CA_PATHS
  );
  const environmentsAllowed = parseList(
    Object.prototype.hasOwnProperty.call(source, 'environmentsAllowed')
      ? source.environmentsAllowed
      : process.env.APPLE_IAP_ENVIRONMENTS_ALLOWED
  );
  const enableOnlineChecks = parseBoolean(
    Object.prototype.hasOwnProperty.call(source, 'enableOnlineChecks')
      ? source.enableOnlineChecks
      : process.env.APPLE_IAP_ENABLE_ONLINE_CHECKS,
    false
  );
  const productConfig = {
    basicProductIds: Object.prototype.hasOwnProperty.call(source, 'basicProductIds')
      ? source.basicProductIds
      : process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_BASIC,
    proProductIds: Object.prototype.hasOwnProperty.call(source, 'proProductIds')
      ? source.proProductIds
      : process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_PRO,
  };

  return {
    bundleId,
    appAppleId,
    environment,
    rootCaPaths,
    environmentsAllowed,
    enableOnlineChecks,
    productConfig,
  };
}

function assertVerifierConfig(resolvedConfig) {
  if (!resolvedConfig.bundleId) {
    throw new AppleVerifierConfigurationError('APPLE_BUNDLE_ID_REQUIRED', 'APPLE_IAP_BUNDLE_ID is required for Apple signed-data verification');
  }

  if (!Array.isArray(resolvedConfig.rootCaPaths) || resolvedConfig.rootCaPaths.length === 0) {
    throw new AppleVerifierConfigurationError('APPLE_ROOT_CA_REQUIRED', 'APPLE_IAP_ROOT_CA_PATHS is required for Apple signed-data verification');
  }

  if (resolvedConfig.environment === 'Production' && typeof resolvedConfig.appAppleId === 'undefined') {
    throw new AppleVerifierConfigurationError('APPLE_APP_ID_REQUIRED', 'APPLE_IAP_APPLE_APP_ID is required when verifying Production signed data');
  }

  const productConfigValidation = validateAppleProductConfiguration(resolvedConfig.productConfig, {
    requireConfigured: true,
  });
  if (!productConfigValidation.isValid) {
    throw new AppleVerifierConfigurationError('APPLE_PRODUCT_CONFIG_INVALID', 'Apple product configuration is invalid for verification');
  }
}

function readRootCertificateBuffers(rootCaPaths) {
  return rootCaPaths.map((rootPath) => {
    const absolute = path.isAbsolute(rootPath) ? rootPath : path.resolve(rootPath);
    return fs.readFileSync(absolute);
  });
}

function getAppleLibrary() {
  try {
    return require('@apple/app-store-server-library');
  } catch (error) {
    throw new AppleVerifierConfigurationError('APPLE_LIBRARY_IMPORT_FAILED', 'Failed to import @apple/app-store-server-library');
  }
}

function buildAllowedEnvironmentSet(environmentsAllowed) {
  if (!Array.isArray(environmentsAllowed) || environmentsAllowed.length === 0) {
    return new Set(['Sandbox', 'Production']);
  }

  const normalized = environmentsAllowed.map((value) => normalizeVerifierEnvironment(value));
  return new Set(normalized);
}

function assertDecodedPayloadCommon(decoded, resolvedConfig, options = {}) {
  if (!decoded || typeof decoded !== 'object') {
    throw new AppleVerifierError('APPLE_DECODED_PAYLOAD_INVALID', 'Decoded Apple payload is invalid');
  }

  const bundleId = typeof decoded.bundleId === 'string' ? decoded.bundleId.trim() : '';
  if (!bundleId || bundleId !== resolvedConfig.bundleId) {
    throw new AppleVerifierError('APPLE_BUNDLE_ID_MISMATCH', 'Decoded Apple payload bundle ID does not match expected bundle ID');
  }

  if (typeof decoded.appAppleId !== 'undefined'
      && typeof resolvedConfig.appAppleId !== 'undefined'
      && String(decoded.appAppleId) !== String(resolvedConfig.appAppleId)) {
    throw new AppleVerifierError('APPLE_APP_ID_MISMATCH', 'Decoded Apple payload appAppleId does not match expected appAppleId');
  }

  const allowedEnvironmentSet = buildAllowedEnvironmentSet(resolvedConfig.environmentsAllowed);
  const decodedEnvironment = normalizeVerifierEnvironment(decoded.environment || resolvedConfig.environment);
  if (!allowedEnvironmentSet.has(decodedEnvironment)) {
    throw new AppleVerifierError('APPLE_ENVIRONMENT_NOT_ALLOWED', 'Decoded Apple payload environment is not allowed');
  }

  if (options.requireProduct && !getAppleProductPlan(decoded.productId, resolvedConfig.productConfig)) {
    throw new AppleVerifierError('APPLE_PRODUCT_NOT_ALLOWED', 'Decoded Apple payload product is not in allowlist');
  }

  if (options.requireTransactionIds) {
    if (typeof decoded.transactionId !== 'string' || decoded.transactionId.trim() === '') {
      throw new AppleVerifierError('APPLE_TRANSACTION_ID_INVALID', 'Decoded Apple payload transactionId is invalid');
    }
    if (typeof decoded.originalTransactionId !== 'string' || decoded.originalTransactionId.trim() === '') {
      throw new AppleVerifierError('APPLE_ORIGINAL_TRANSACTION_ID_INVALID', 'Decoded Apple payload originalTransactionId is invalid');
    }
  }

  if (typeof decoded.appAccountToken !== 'undefined' && decoded.appAccountToken !== null) {
    if (!isValidAppAccountToken(decoded.appAccountToken)) {
      throw new AppleVerifierError('APPLE_APP_ACCOUNT_TOKEN_INVALID', 'Decoded Apple payload appAccountToken is invalid');
    }
  }
}

function createAppleSignedDataVerifier(config = {}) {
  const resolvedConfig = getVerifierConfig(config);
  assertVerifierConfig(resolvedConfig);

  const appleLib = getAppleLibrary();
  const rootCertBuffers = readRootCertificateBuffers(resolvedConfig.rootCaPaths);
  const environmentValue = resolvedConfig.environment === 'Sandbox'
    ? appleLib.Environment.SANDBOX
    : appleLib.Environment.PRODUCTION;

  const verifier = new appleLib.SignedDataVerifier(
    rootCertBuffers,
    resolvedConfig.enableOnlineChecks,
    environmentValue,
    resolvedConfig.bundleId,
    resolvedConfig.appAppleId
  );

  return {
    verifier,
    config: resolvedConfig,
  };
}

async function verifyAndDecodeTransaction(signedTransactionInfo, config = {}) {
  if (typeof signedTransactionInfo !== 'string' || signedTransactionInfo.trim() === '') {
    throw new AppleVerifierError('APPLE_SIGNED_TRANSACTION_REQUIRED', 'signedTransactionInfo is required');
  }

  try {
    const { verifier, config: resolvedConfig } = createAppleSignedDataVerifier(config);
    const decoded = await verifier.verifyAndDecodeTransaction(signedTransactionInfo);
    assertDecodedPayloadCommon(decoded, resolvedConfig, {
      requireProduct: true,
      requireTransactionIds: true,
    });
    return decoded;
  } catch (error) {
    if (error instanceof AppleVerifierConfigurationError || error instanceof AppleVerifierError) {
      throw error;
    }
    throw new AppleVerifierError('APPLE_TRANSACTION_VERIFICATION_FAILED', 'Apple signed transaction verification failed');
  }
}

async function verifyAndDecodeNotification(signedPayload, config = {}) {
  if (typeof signedPayload !== 'string' || signedPayload.trim() === '') {
    throw new AppleVerifierError('APPLE_SIGNED_PAYLOAD_REQUIRED', 'signedPayload is required');
  }

  try {
    const { verifier, config: resolvedConfig } = createAppleSignedDataVerifier(config);
    const decoded = await verifier.verifyAndDecodeNotification(signedPayload);
    assertDecodedPayloadCommon(decoded, resolvedConfig);
    return decoded;
  } catch (error) {
    if (error instanceof AppleVerifierConfigurationError || error instanceof AppleVerifierError) {
      throw error;
    }
    throw new AppleVerifierError('APPLE_NOTIFICATION_VERIFICATION_FAILED', 'Apple signed notification verification failed');
  }
}

async function verifyAndDecodeRenewalInfo(signedRenewalInfo, config = {}) {
  if (typeof signedRenewalInfo !== 'string' || signedRenewalInfo.trim() === '') {
    throw new AppleVerifierError('APPLE_SIGNED_RENEWAL_REQUIRED', 'signedRenewalInfo is required');
  }

  try {
    const { verifier, config: resolvedConfig } = createAppleSignedDataVerifier(config);
    const decoded = await verifier.verifyAndDecodeRenewalInfo(signedRenewalInfo);
    assertDecodedPayloadCommon(decoded, resolvedConfig);
    return decoded;
  } catch (error) {
    if (error instanceof AppleVerifierConfigurationError || error instanceof AppleVerifierError) {
      throw error;
    }
    throw new AppleVerifierError('APPLE_RENEWAL_VERIFICATION_FAILED', 'Apple signed renewal verification failed');
  }
}

module.exports = {
  AppleVerifierConfigurationError,
  AppleVerifierError,
  getVerifierConfig,
  createAppleSignedDataVerifier,
  verifyAndDecodeTransaction,
  verifyAndDecodeNotification,
  verifyAndDecodeRenewalInfo,
};