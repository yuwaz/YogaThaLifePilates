const crypto = require('crypto');
const {
  isValidProviderBackedPlan,
} = require('./subscriptionService');
const {
  GOOGLE_PLAY_PURCHASE_INTENT_ALLOWED_STATUSES,
  GOOGLE_PLAY_SUPPORTED_SUBSCRIPTION_STATES,
  getGooglePlayProductConfiguration,
  getGooglePlayProductPlan,
  validateGooglePlayProductConfiguration,
} = require('../models/googlePlaySubscriptionMetadata');

const GOOGLE_PLAY_OBFUSCATED_ACCOUNT_ID_LENGTH = 64;

const GOOGLE_PLAY_TO_NORMALIZED_STATUS = Object.freeze({
  SUBSCRIPTION_STATE_PENDING: 'pending',
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace_period',
  SUBSCRIPTION_STATE_ON_HOLD: 'billing_retry',
  SUBSCRIPTION_STATE_CANCELED: 'cancelled',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'cancelled',
});

function normalizeString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseIsoDate(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function assertHashInputs(studioId, secret) {
  if (!Number.isInteger(studioId) || studioId <= 0) {
    throw new Error('studioId must be a positive integer');
  }

  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('secret must be a non-empty string');
  }
}

function buildGoogleHmacHex(value, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(value, 'utf8')
    .digest('hex');
}

function generateGoogleObfuscatedAccountId({ studioId, secret }) {
  assertHashInputs(studioId, secret);
  const material = `yogatha:google-play:studio:${studioId}`;
  return buildGoogleHmacHex(material, secret.trim());
}

function generateGoogleObfuscatedProfileId({ studioId, userId, secret }) {
  assertHashInputs(studioId, secret);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('userId must be a positive integer');
  }

  const material = `yogatha:google-play:studio:${studioId}:user:${userId}`;
  return buildGoogleHmacHex(material, secret.trim());
}

function isValidGoogleObfuscatedAccountId(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return false;
  }

  return /^[a-f0-9]{64}$/u.test(normalized);
}

function secureEquals(expected, received) {
  const left = normalizeString(expected);
  const right = normalizeString(received);
  if (!left || !right) {
    return false;
  }

  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function validateGooglePlayPurchaseIntentForVerification(intent, context = {}) {
  const now = context.now instanceof Date ? context.now : new Date();
  const studioId = Number.isInteger(context.studioId) ? context.studioId : null;

  if (!intent || typeof intent !== 'object') {
    return { isValid: false, code: 'GOOGLE_PLAY_INTENT_MISSING', message: 'Purchase intent is required' };
  }

  if (intent.provider !== 'google_play') {
    return { isValid: false, code: 'GOOGLE_PLAY_INTENT_PROVIDER_INVALID', message: 'Purchase intent provider must be google_play' };
  }

  if (!isValidProviderBackedPlan(intent.targetPlan)) {
    return { isValid: false, code: 'GOOGLE_PLAY_INTENT_PLAN_INVALID', message: 'Purchase intent plan must be basic or pro' };
  }

  if (!GOOGLE_PLAY_PURCHASE_INTENT_ALLOWED_STATUSES.includes(intent.status)) {
    return { isValid: false, code: 'GOOGLE_PLAY_INTENT_STATUS_INVALID', message: 'Purchase intent status is not eligible for verification' };
  }

  const expiresAt = intent.expiresAt instanceof Date ? intent.expiresAt : new Date(intent.expiresAt);
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return { isValid: false, code: 'GOOGLE_PLAY_INTENT_EXPIRED', message: 'Purchase intent is expired' };
  }

  if (intent.consumedAt) {
    return { isValid: false, code: 'GOOGLE_PLAY_INTENT_CONSUMED', message: 'Purchase intent is already consumed' };
  }

  if (!isValidGoogleObfuscatedAccountId(intent.googleObfuscatedAccountId)) {
    return {
      isValid: false,
      code: 'GOOGLE_PLAY_INTENT_ACCOUNT_ID_MISSING',
      message: 'Purchase intent must contain a valid obfuscated account identifier',
    };
  }

  if (!Number.isInteger(studioId) || studioId <= 0 || intent.studioId !== studioId) {
    return { isValid: false, code: 'GOOGLE_PLAY_INTENT_STUDIO_MISMATCH', message: 'Purchase intent does not belong to this studio' };
  }

  return { isValid: true };
}

function extractGooglePlaySubscriptionLineItems(response) {
  const lineItems = Array.isArray(response && response.lineItems) ? response.lineItems : [];

  return lineItems
    .map((lineItem) => {
      if (!lineItem || typeof lineItem !== 'object') {
        return null;
      }

      const productId = normalizeString(lineItem.productId);
      if (!productId) {
        return null;
      }

      const offerDetails = lineItem.offerDetails && typeof lineItem.offerDetails === 'object'
        ? lineItem.offerDetails
        : null;

      const basePlanId = normalizeString(offerDetails && offerDetails.basePlanId);
      const offerId = normalizeString(offerDetails && offerDetails.offerId);
      const expiryTime = parseIsoDate(lineItem.expiryTime);
      const autoRenewEnabled = Boolean(
        lineItem.autoRenewingPlan
        && typeof lineItem.autoRenewingPlan === 'object'
        && lineItem.autoRenewingPlan.autoRenewEnabled === true
      )
        ? true
        : (lineItem.autoRenewingPlan && typeof lineItem.autoRenewingPlan.autoRenewEnabled === 'boolean'
          ? false
          : null);

      const hasReliableFreeTrialEvidence = Boolean(
        lineItem.offerPhase
        && typeof lineItem.offerPhase === 'object'
        && lineItem.offerPhase.freeTrial
      );

      const latestSuccessfulOrderId = normalizeString(lineItem.latestSuccessfulOrderId);

      return {
        raw: lineItem,
        productId,
        basePlanId,
        offerId,
        expiryTime,
        autoRenewEnabled,
        latestSuccessfulOrderId,
        hasReliableFreeTrialEvidence,
      };
    })
    .filter(Boolean);
}

function selectEffectiveGooglePlayLineItem(response, now = new Date()) {
  const lineItems = extractGooglePlaySubscriptionLineItems(response);
  if (lineItems.length === 0) {
    return null;
  }

  const future = lineItems.filter((item) => item.expiryTime && item.expiryTime.getTime() > now.getTime());
  const pool = future.length > 0 ? future : lineItems;

  pool.sort((a, b) => {
    const aTime = a.expiryTime ? a.expiryTime.getTime() : Number.MIN_SAFE_INTEGER;
    const bTime = b.expiryTime ? b.expiryTime.getTime() : Number.MIN_SAFE_INTEGER;
    return bTime - aTime;
  });

  return pool[0] || null;
}

function getGooglePlayProviderSubscriptionId(response, purchaseToken) {
  const normalizedToken = normalizeString(purchaseToken);
  if (!normalizedToken) {
    throw new Error('purchaseToken is required');
  }

  return normalizedToken;
}

function getGoogleLinkedPurchaseToken(response) {
  return normalizeString(response && response.linkedPurchaseToken);
}

function isGoogleReplacementTransition(response) {
  const linkedToken = getGoogleLinkedPurchaseToken(response);
  if (linkedToken) {
    return true;
  }

  const lineItems = extractGooglePlaySubscriptionLineItems(response);
  return lineItems.some((item) => Boolean(item.raw && (item.raw.itemReplacement || item.raw.deferredItemReplacement)));
}

function validateGooglePurchaseTokenLineage({ currentPurchaseToken, linkedPurchaseToken, existingBinding }) {
  const current = normalizeString(currentPurchaseToken);
  const linked = normalizeString(linkedPurchaseToken);
  const existing = normalizeString(existingBinding);

  if (!current) {
    return {
      isValid: false,
      code: 'GOOGLE_PLAY_TOKEN_MISSING',
      message: 'Current purchase token is required',
    };
  }

  if (!existing) {
    return {
      isValid: true,
      requiresRebind: false,
    };
  }

  if (existing === current) {
    return {
      isValid: true,
      requiresRebind: false,
    };
  }

  if (linked && linked === existing) {
    return {
      isValid: true,
      requiresRebind: true,
    };
  }

  return {
    isValid: false,
    code: 'GOOGLE_PLAY_TOKEN_LINEAGE_MISMATCH',
    message: 'Linked purchase token does not match existing binding',
  };
}

function mapGooglePlaySubscriptionStateToNormalized({ subscriptionState, selectedLineItem, now }) {
  const mapped = GOOGLE_PLAY_TO_NORMALIZED_STATUS[subscriptionState] || null;
  if (!mapped) {
    return null;
  }

  if (subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE') {
    if (selectedLineItem && selectedLineItem.hasReliableFreeTrialEvidence) {
      return 'trialing';
    }
    return 'active';
  }

  if (subscriptionState === 'SUBSCRIPTION_STATE_CANCELED') {
    if (selectedLineItem && selectedLineItem.expiryTime && selectedLineItem.expiryTime.getTime() <= now.getTime()) {
      return 'expired';
    }
    return 'cancelled';
  }

  return mapped;
}

function mapGooglePlaySubscriptionV2ToEntitlementInput({
  response,
  purchaseToken,
  expectedPackageName,
  expectedObfuscatedAccountId,
  config,
  now = new Date(),
  environment,
}) {
  if (!response || typeof response !== 'object') {
    return {
      ok: false,
      code: 'GOOGLE_PLAY_RESPONSE_INVALID',
      message: 'Google Play subscription response is invalid',
    };
  }

  const packageName = normalizeString(expectedPackageName);
  if (!packageName) {
    return {
      ok: false,
      code: 'GOOGLE_PLAY_PACKAGE_NAME_REQUIRED',
      message: 'Package name context is required',
    };
  }

  const configValidation = validateGooglePlayProductConfiguration(config, { requireConfigured: true });
  if (!configValidation.isValid) {
    return {
      ok: false,
      code: 'GOOGLE_PLAY_PRODUCT_CONFIG_INVALID',
      message: 'Google Play product configuration is invalid',
      details: configValidation.errors,
    };
  }

  const configuration = configValidation.normalized;

  if (configuration.packageName && configuration.packageName !== packageName) {
    return {
      ok: false,
      code: 'GOOGLE_PLAY_PACKAGE_MISMATCH',
      message: 'Package name context does not match configured package',
    };
  }

  const externalAccountId = normalizeString(
    response.externalAccountIdentifiers
      && response.externalAccountIdentifiers.obfuscatedExternalAccountId
  );

  if (!externalAccountId) {
    return {
      ok: false,
      code: 'GOOGLE_PLAY_ACCOUNT_ID_MISSING',
      message: 'Google Play response did not include obfuscatedExternalAccountId',
    };
  }

  const expectedAccountId = normalizeString(expectedObfuscatedAccountId);
  if (!expectedAccountId || !secureEquals(expectedAccountId, externalAccountId)) {
    return {
      ok: false,
      code: 'GOOGLE_PLAY_ACCOUNT_ID_MISMATCH',
      message: 'Google Play account linkage did not match expected identifier',
    };
  }

  const selectedLineItem = selectEffectiveGooglePlayLineItem(response, now);
  if (!selectedLineItem) {
    return {
      ok: false,
      code: 'GOOGLE_PLAY_LINE_ITEM_MISSING',
      message: 'Google Play response did not include a valid subscription line item',
    };
  }

  const plan = getGooglePlayProductPlan({
    productId: selectedLineItem.productId,
    basePlanId: selectedLineItem.basePlanId,
    offerId: selectedLineItem.offerId,
  }, configuration);

  if (!plan) {
    return {
      ok: false,
      code: 'GOOGLE_PLAY_PRODUCT_MAPPING_INVALID',
      message: 'Google Play line item did not match configured plan mapping',
    };
  }

  const subscriptionState = normalizeString(response.subscriptionState);
  if (!subscriptionState || !GOOGLE_PLAY_SUPPORTED_SUBSCRIPTION_STATES.includes(subscriptionState)) {
    return {
      ok: false,
      code: 'GOOGLE_PLAY_SUBSCRIPTION_STATE_INVALID',
      message: 'Google Play subscriptionState is missing or unsupported',
    };
  }

  const normalizedStatus = mapGooglePlaySubscriptionStateToNormalized({
    subscriptionState,
    selectedLineItem,
    now,
  });

  if (!normalizedStatus) {
    return {
      ok: false,
      code: 'GOOGLE_PLAY_SUBSCRIPTION_STATE_UNMAPPED',
      message: 'Google Play subscriptionState could not be mapped',
    };
  }

  const derivedEnvironment = response.testPurchase ? 'test' : 'production';
  const expectedEnvironment = normalizeString(environment);
  if (expectedEnvironment && expectedEnvironment !== derivedEnvironment) {
    return {
      ok: false,
      code: 'GOOGLE_PLAY_ENVIRONMENT_MISMATCH',
      message: 'Google Play testPurchase environment mismatch',
      expectedEnvironment,
      actualEnvironment: derivedEnvironment,
    };
  }

  return {
    ok: true,
    value: {
      providerSubscriptionId: getGooglePlayProviderSubscriptionId(response, purchaseToken),
      linkedPurchaseToken: getGoogleLinkedPurchaseToken(response),
      packageName,
      plan,
      normalizedStatus,
      providerProductId: selectedLineItem.productId,
      basePlanId: selectedLineItem.basePlanId,
      offerId: selectedLineItem.offerId,
      currentPeriodStart: parseIsoDate(response.startTime),
      currentPeriodEnd: selectedLineItem.expiryTime,
      autoRenewEnabled: selectedLineItem.autoRenewEnabled,
      environment: derivedEnvironment,
      subscriptionState,
      acknowledgementState: normalizeString(response.acknowledgementState),
      latestSuccessfulOrderId: selectedLineItem.latestSuccessfulOrderId,
      testPurchaseFlag: Boolean(response.testPurchase),
      externalAccountIdentifier: externalAccountId,
      trialDetectedReliably: Boolean(selectedLineItem.hasReliableFreeTrialEvidence),
    },
  };
}

module.exports = {
  GOOGLE_PLAY_OBFUSCATED_ACCOUNT_ID_LENGTH,
  generateGoogleObfuscatedAccountId,
  generateGoogleObfuscatedProfileId,
  isValidGoogleObfuscatedAccountId,
  secureEquals,
  validateGooglePlayPurchaseIntentForVerification,
  extractGooglePlaySubscriptionLineItems,
  selectEffectiveGooglePlayLineItem,
  getGooglePlayProviderSubscriptionId,
  getGoogleLinkedPurchaseToken,
  isGoogleReplacementTransition,
  validateGooglePurchaseTokenLineage,
  mapGooglePlaySubscriptionV2ToEntitlementInput,
};
