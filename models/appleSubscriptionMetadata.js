const APPLE_ENVIRONMENTS = Object.freeze([
  'Sandbox',
  'Production',
]);

const APPLE_NOTIFICATION_PROCESSING_STATES = Object.freeze([
  'pending',
  'processed',
  'failed',
]);

const APPLE_PURCHASE_INTENT_TOKEN_STATES = Object.freeze([
  'created',
  'started',
]);

function normalizeDelimitedList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0);
  }

  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function getAppleProductConfiguration(config = {}) {
  const source = config || {};
  const basicProductIds = normalizeDelimitedList(
    Object.prototype.hasOwnProperty.call(source, 'basicProductIds')
      ? source.basicProductIds
      : process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_BASIC
  );
  const proProductIds = normalizeDelimitedList(
    Object.prototype.hasOwnProperty.call(source, 'proProductIds')
      ? source.proProductIds
      : process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_PRO
  );

  return {
    basicProductIds,
    proProductIds,
  };
}

function validateAppleProductConfiguration(config = {}, options = {}) {
  const requireConfigured = Boolean(options.requireConfigured);
  const { basicProductIds, proProductIds } = getAppleProductConfiguration(config);
  const errors = [];

  if (requireConfigured) {
    if (basicProductIds.length === 0) {
      errors.push('APPLE_IAP_ALLOWED_PRODUCT_IDS_BASIC is required for verification');
    }
    if (proProductIds.length === 0) {
      errors.push('APPLE_IAP_ALLOWED_PRODUCT_IDS_PRO is required for verification');
    }
  }

  const basicSet = new Set(basicProductIds);
  const duplicateAcrossPlans = proProductIds.find((productId) => basicSet.has(productId));
  if (duplicateAcrossPlans) {
    errors.push('A product ID cannot be configured for both basic and pro plans');
  }

  return {
    isValid: errors.length === 0,
    errors,
    normalized: {
      basicProductIds,
      proProductIds,
    },
  };
}

function getAppleProductPlan(productId, config = {}) {
  if (typeof productId !== 'string' || productId.trim() === '') {
    return null;
  }

  const normalizedProductId = productId.trim();
  const { basicProductIds, proProductIds } = getAppleProductConfiguration(config);

  if (basicProductIds.includes(normalizedProductId)) {
    return 'basic';
  }

  if (proProductIds.includes(normalizedProductId)) {
    return 'pro';
  }

  return null;
}

function isAllowedAppleProductId(productId, config = {}) {
  return getAppleProductPlan(productId, config) !== null;
}

module.exports = {
  APPLE_ENVIRONMENTS,
  APPLE_NOTIFICATION_PROCESSING_STATES,
  APPLE_PURCHASE_INTENT_TOKEN_STATES,
  getAppleProductConfiguration,
  validateAppleProductConfiguration,
  getAppleProductPlan,
  isAllowedAppleProductId,
};