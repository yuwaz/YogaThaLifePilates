const SUBSCRIPTION_PROVIDERS = Object.freeze([
  'apple',
  'google_play',
]);

const SUBSCRIPTION_ENVIRONMENTS = Object.freeze([
  'sandbox',
  'test',
  'production',
]);

const NORMALIZED_SUBSCRIPTION_STATUSES = Object.freeze([
  'none',
  'pending',
  'trialing',
  'active',
  'grace_period',
  'billing_retry',
  'paused',
  'cancelled',
  'expired',
  'revoked',
  'refunded',
]);

const PURCHASE_INTENT_STATUSES = Object.freeze([
  'created',
  'started',
  'verified',
  'consumed',
  'expired',
  'cancelled',
  'failed',
]);

const PURCHASE_INTENT_TARGET_PLANS = Object.freeze([
  'basic',
  'pro',
]);

const PROVIDER_BACKED_SUBSCRIPTION_PLANS = PURCHASE_INTENT_TARGET_PLANS;

const ENTITLEMENT_UPDATE_SOURCES = Object.freeze([
  'verify_endpoint',
  'notification',
  'reconciliation',
]);

const EFFECTIVE_ENTITLEMENT_STATUSES = Object.freeze([
  'trialing',
  'active',
  'grace_period',
  'billing_retry',
  'paused',
]);

function includes(list, value) {
  return typeof value === 'string' && list.includes(value);
}

function isValidSubscriptionProvider(value) {
  return includes(SUBSCRIPTION_PROVIDERS, value);
}

function isValidSubscriptionEnvironment(value) {
  return includes(SUBSCRIPTION_ENVIRONMENTS, value);
}

function isValidNormalizedSubscriptionStatus(value) {
  return includes(NORMALIZED_SUBSCRIPTION_STATUSES, value);
}

function isValidPurchaseIntentStatus(value) {
  return includes(PURCHASE_INTENT_STATUSES, value);
}

function isValidProviderBackedPlan(value) {
  return includes(PROVIDER_BACKED_SUBSCRIPTION_PLANS, value);
}

function isEffectiveEntitlementStatus(value) {
  return includes(EFFECTIVE_ENTITLEMENT_STATUSES, value);
}

module.exports = {
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_ENVIRONMENTS,
  NORMALIZED_SUBSCRIPTION_STATUSES,
  PURCHASE_INTENT_STATUSES,
  PURCHASE_INTENT_TARGET_PLANS,
  PROVIDER_BACKED_SUBSCRIPTION_PLANS,
  ENTITLEMENT_UPDATE_SOURCES,
  EFFECTIVE_ENTITLEMENT_STATUSES,
  isValidSubscriptionProvider,
  isValidSubscriptionEnvironment,
  isValidNormalizedSubscriptionStatus,
  isValidPurchaseIntentStatus,
  isValidProviderBackedPlan,
  isEffectiveEntitlementStatus,
};