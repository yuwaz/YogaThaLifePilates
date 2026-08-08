const GOOGLE_PLAY_ENVIRONMENTS = Object.freeze([
  'test',
  'production',
]);

const GOOGLE_PLAY_NOTIFICATION_INBOX_ENVIRONMENTS = Object.freeze([
  'unresolved',
  'test',
  'production',
]);

const GOOGLE_PLAY_NOTIFICATION_PROCESSING_STATES = Object.freeze([
  'pending',
  'processed',
  'failed',
]);

const GOOGLE_PLAY_PURCHASE_INTENT_ALLOWED_STATUSES = Object.freeze([
  'created',
  'started',
]);

const GOOGLE_PLAY_SUPPORTED_SUBSCRIPTION_STATES = Object.freeze([
  'SUBSCRIPTION_STATE_UNSPECIFIED',
  'SUBSCRIPTION_STATE_PENDING',
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_PAUSED',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  'SUBSCRIPTION_STATE_ON_HOLD',
  'SUBSCRIPTION_STATE_CANCELED',
  'SUBSCRIPTION_STATE_EXPIRED',
  'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED',
]);

const GOOGLE_PLAY_ACKNOWLEDGEMENT_STATES = Object.freeze([
  'ACKNOWLEDGEMENT_STATE_UNSPECIFIED',
  'ACKNOWLEDGEMENT_STATE_PENDING',
  'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
]);

function normalizeString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readConfigValue(source, key, envKey) {
  if (source && Object.prototype.hasOwnProperty.call(source, key)) {
    return normalizeString(source[key]);
  }

  return normalizeString(process.env[envKey]);
}

function getGooglePlayProductConfiguration(config = {}) {
  const source = config || {};
  const basicSource = source && typeof source.basic === 'object' ? source.basic : {};
  const proSource = source && typeof source.pro === 'object' ? source.pro : {};

  return {
    packageName: readConfigValue(source, 'packageName', 'GOOGLE_PLAY_PACKAGE_NAME'),
    basic: {
      productId: readConfigValue(source, 'basicProductId', 'GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID')
        || readConfigValue(basicSource, 'productId', 'GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID'),
      basePlanId: readConfigValue(source, 'basicBasePlanId', 'GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID')
        || readConfigValue(basicSource, 'basePlanId', 'GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID'),
      offerId: readConfigValue(source, 'basicOfferId', 'GOOGLE_PLAY_ALLOWED_BASIC_OFFER_ID')
        || readConfigValue(basicSource, 'offerId', 'GOOGLE_PLAY_ALLOWED_BASIC_OFFER_ID'),
    },
    pro: {
      productId: readConfigValue(source, 'proProductId', 'GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID')
        || readConfigValue(proSource, 'productId', 'GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID'),
      basePlanId: readConfigValue(source, 'proBasePlanId', 'GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID')
        || readConfigValue(proSource, 'basePlanId', 'GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID'),
      offerId: readConfigValue(source, 'proOfferId', 'GOOGLE_PLAY_ALLOWED_PRO_OFFER_ID')
        || readConfigValue(proSource, 'offerId', 'GOOGLE_PLAY_ALLOWED_PRO_OFFER_ID'),
    },
  };
}

function validateGooglePlayProductConfiguration(config = {}, options = {}) {
  const requireConfigured = Boolean(options.requireConfigured);
  const normalized = getGooglePlayProductConfiguration(config);
  const errors = [];

  if (requireConfigured && !normalized.packageName) {
    errors.push('GOOGLE_PLAY_PACKAGE_NAME is required for Google Play verification');
  }

  const plans = [
    { name: 'basic', config: normalized.basic },
    { name: 'pro', config: normalized.pro },
  ];

  const planKeys = [];

  for (const entry of plans) {
    const { name, config: planConfig } = entry;
    const hasAny = Boolean(planConfig.productId || planConfig.basePlanId || planConfig.offerId);

    if (!hasAny) {
      if (requireConfigured) {
        errors.push(`Google Play ${name} plan mapping is required`);
      }
      continue;
    }

    if (!planConfig.productId) {
      errors.push(`Google Play ${name} productId is required when plan mapping is configured`);
      continue;
    }

    if (!planConfig.basePlanId) {
      errors.push(`Google Play ${name} basePlanId is required when plan mapping is configured`);
      continue;
    }

    planKeys.push({
      plan: name,
      key: `${planConfig.productId}::${planConfig.basePlanId}`,
    });
  }

  if (planKeys.length === 2 && planKeys[0].key === planKeys[1].key) {
    errors.push('A Google Play productId/basePlanId combination cannot map to both basic and pro plans');
  }

  return {
    isValid: errors.length === 0,
    errors,
    normalized,
  };
}

function matchesConfiguredOffer(configuredOfferId, offerId) {
  if (!configuredOfferId) {
    return true;
  }

  return configuredOfferId === normalizeString(offerId);
}

function getGooglePlayProductPlan(input = {}, config = {}) {
  const normalizedProductId = normalizeString(input.productId);
  const normalizedBasePlanId = normalizeString(input.basePlanId);

  if (!normalizedProductId || !normalizedBasePlanId) {
    return null;
  }

  const offerId = normalizeString(input.offerId);
  const normalized = getGooglePlayProductConfiguration(config);

  const basicMatches = normalized.basic.productId === normalizedProductId
    && normalized.basic.basePlanId === normalizedBasePlanId
    && matchesConfiguredOffer(normalized.basic.offerId, offerId);
  if (basicMatches) {
    return 'basic';
  }

  const proMatches = normalized.pro.productId === normalizedProductId
    && normalized.pro.basePlanId === normalizedBasePlanId
    && matchesConfiguredOffer(normalized.pro.offerId, offerId);
  if (proMatches) {
    return 'pro';
  }

  return null;
}

function isAllowedGooglePlayProduct(input = {}, config = {}) {
  return getGooglePlayProductPlan(input, config) !== null;
}

function isSupportedGooglePlaySubscriptionState(value) {
  return typeof value === 'string' && GOOGLE_PLAY_SUPPORTED_SUBSCRIPTION_STATES.includes(value);
}

module.exports = {
  GOOGLE_PLAY_ENVIRONMENTS,
  GOOGLE_PLAY_NOTIFICATION_INBOX_ENVIRONMENTS,
  GOOGLE_PLAY_NOTIFICATION_PROCESSING_STATES,
  GOOGLE_PLAY_PURCHASE_INTENT_ALLOWED_STATUSES,
  GOOGLE_PLAY_SUPPORTED_SUBSCRIPTION_STATES,
  GOOGLE_PLAY_ACKNOWLEDGEMENT_STATES,
  getGooglePlayProductConfiguration,
  validateGooglePlayProductConfiguration,
  getGooglePlayProductPlan,
  isAllowedGooglePlayProduct,
  isSupportedGooglePlaySubscriptionState,
};
