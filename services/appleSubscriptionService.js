const crypto = require('crypto');
const {
  APPLE_ENVIRONMENTS,
  APPLE_PURCHASE_INTENT_TOKEN_STATES,
  getAppleProductPlan,
  validateAppleProductConfiguration,
} = require('../models/appleSubscriptionMetadata');

const APPLE_INTENT_VERIFICATION_STATUSES = Object.freeze([
  'created',
  'started',
]);

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isValidAppAccountToken(value) {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value.trim().toLowerCase());
}

function generateAppAccountToken() {
  return crypto.randomUUID().toLowerCase();
}

function normalizeAppleEnvironment(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (normalized === 'Sandbox') {
    return 'sandbox';
  }
  if (normalized === 'Production') {
    return 'production';
  }
  return null;
}

function mapAppleProductIdToPlan(productId, config = {}) {
  return getAppleProductPlan(productId, config);
}

function isVerificationEligibleIntentStatus(status) {
  return typeof status === 'string' && APPLE_INTENT_VERIFICATION_STATUSES.includes(status);
}

function validateApplePurchaseIntentForVerification(intent, context = {}) {
  const now = context.now instanceof Date ? context.now : new Date();
  const expectedStudioId = context.studioId;
  const errors = [];

  if (!intent || typeof intent !== 'object') {
    return {
      isValid: false,
      errors: ['Purchase intent is required'],
    };
  }

  if (intent.provider !== 'apple') {
    errors.push('Purchase intent provider must be apple');
  }

  if (intent.targetPlan !== 'basic' && intent.targetPlan !== 'pro') {
    errors.push('Purchase intent targetPlan must be basic or pro');
  }

  if (!isVerificationEligibleIntentStatus(intent.status)) {
    errors.push('Purchase intent status is not eligible for verification');
  }

  if (typeof expectedStudioId === 'number' && intent.studioId !== expectedStudioId) {
    errors.push('Purchase intent studioId does not match authenticated studio');
  }

  if (intent.consumedAt) {
    errors.push('Purchase intent is already consumed');
  }

  const expiresAt = intent.expiresAt ? new Date(intent.expiresAt) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    errors.push('Purchase intent expiresAt is invalid');
  } else if (expiresAt.getTime() <= now.getTime()) {
    errors.push('Purchase intent is expired');
  }

  if (!isValidAppAccountToken(intent.appAccountToken)) {
    errors.push('Purchase intent appAccountToken is missing or invalid');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function toDateFromMillis(value) {
  if (value === null || typeof value === 'undefined') {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const parsed = new Date(numeric);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function getAppleProviderSubscriptionId(decodedTransaction) {
  if (!decodedTransaction || typeof decodedTransaction.originalTransactionId !== 'string') {
    return null;
  }

  const value = decodedTransaction.originalTransactionId.trim();
  return value.length > 0 ? value : null;
}

function isAppleTransactionCurrentlyEntitled(decodedTransaction, now = new Date()) {
  if (!decodedTransaction || typeof decodedTransaction !== 'object') {
    return false;
  }

  const revocationDate = toDateFromMillis(decodedTransaction.revocationDate);
  if (revocationDate) {
    return false;
  }

  const expiresDate = toDateFromMillis(decodedTransaction.expiresDate);
  if (!expiresDate) {
    return false;
  }

  return expiresDate.getTime() > now.getTime();
}

function mapVerifiedAppleTransactionToEntitlementInput(decodedTransaction, context = {}) {
  if (!decodedTransaction || typeof decodedTransaction !== 'object') {
    return {
      ok: false,
      errorCode: 'APPLE_TRANSACTION_REQUIRED',
    };
  }

  const environment = normalizeAppleEnvironment(decodedTransaction.environment);
  if (!environment) {
    return {
      ok: false,
      errorCode: 'APPLE_ENVIRONMENT_INVALID',
    };
  }

  const productPlan = mapAppleProductIdToPlan(decodedTransaction.productId, context.productConfig || {});
  if (!productPlan) {
    return {
      ok: false,
      errorCode: 'APPLE_PRODUCT_ID_NOT_ALLOWED',
    };
  }

  const providerSubscriptionId = getAppleProviderSubscriptionId(decodedTransaction);
  if (!providerSubscriptionId) {
    return {
      ok: false,
      errorCode: 'APPLE_ORIGINAL_TRANSACTION_ID_REQUIRED',
    };
  }

  const transactionId = typeof decodedTransaction.transactionId === 'string'
    ? decodedTransaction.transactionId.trim()
    : '';
  if (!transactionId) {
    return {
      ok: false,
      errorCode: 'APPLE_TRANSACTION_ID_REQUIRED',
    };
  }

  const now = context.now instanceof Date ? context.now : new Date();
  const expiresDate = toDateFromMillis(decodedTransaction.expiresDate);
  const revocationDate = toDateFromMillis(decodedTransaction.revocationDate);

  let normalizedStatus = null;

  if (revocationDate) {
    normalizedStatus = 'revoked';
  } else if (expiresDate && expiresDate.getTime() <= now.getTime()) {
    normalizedStatus = 'expired';
  } else if (expiresDate && expiresDate.getTime() > now.getTime()) {
    if (decodedTransaction.offerDiscountType === 'FREE_TRIAL') {
      normalizedStatus = 'trialing';
    } else {
      normalizedStatus = 'active';
    }
  }

  if (!normalizedStatus) {
    return {
      ok: false,
      errorCode: 'APPLE_STATUS_MAPPING_REQUIRES_ADDITIONAL_CONTEXT',
      requiresAdditionalContext: true,
      limitationReason: 'EXPIRES_DATE_REQUIRED_FOR_STATUS',
    };
  }

  return {
    ok: true,
    entitlementInput: {
      provider: 'apple',
      providerSubscriptionId,
      providerProductId: decodedTransaction.productId,
      plan: productPlan,
      environment,
      normalizedStatus,
      currentPeriodStart: toDateFromMillis(decodedTransaction.purchaseDate),
      currentPeriodEnd: expiresDate,
      revokedAt: revocationDate,
      trialEndsAt: normalizedStatus === 'trialing' ? expiresDate : null,
      providerEventTime: toDateFromMillis(decodedTransaction.signedDate),
      sourceLastUpdate: context.sourceLastUpdate || 'verify_endpoint',
    },
    requiresAdditionalContext: false,
    limitationReason: null,
  };
}

function getAppleOriginalTransactionBindingKey(environment, originalTransactionId) {
  const normalizedEnvironment = normalizeAppleEnvironment(environment);
  if (!normalizedEnvironment || typeof originalTransactionId !== 'string' || originalTransactionId.trim() === '') {
    return null;
  }

  return `apple:${normalizedEnvironment}:${originalTransactionId.trim()}`;
}

module.exports = {
  APPLE_ENVIRONMENTS,
  APPLE_PURCHASE_INTENT_TOKEN_STATES,
  APPLE_INTENT_VERIFICATION_STATUSES,
  generateAppAccountToken,
  isValidAppAccountToken,
  normalizeAppleEnvironment,
  mapAppleProductIdToPlan,
  validateApplePurchaseIntentForVerification,
  mapVerifiedAppleTransactionToEntitlementInput,
  isAppleTransactionCurrentlyEntitled,
  getAppleProviderSubscriptionId,
  getAppleOriginalTransactionBindingKey,
  validateAppleProductConfiguration,
};