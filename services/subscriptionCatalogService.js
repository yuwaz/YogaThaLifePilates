const {
  PROVIDER_BACKED_SUBSCRIPTION_PLANS,
} = require('../models/subscriptionInfrastructureMetadata');
const {
  getAppleProductConfiguration,
  validateAppleProductConfiguration,
} = require('../models/appleSubscriptionMetadata');
const {
  getGooglePlayProductConfiguration,
  validateGooglePlayProductConfiguration,
} = require('../models/googlePlaySubscriptionMetadata');

class SubscriptionCatalogConfigurationError extends Error {
  constructor(code, message, httpStatus = 500) {
    super(message);
    this.name = 'SubscriptionCatalogConfigurationError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function ensureAppleCatalogConfiguration() {
  const validation = validateAppleProductConfiguration(getAppleProductConfiguration(), {
    requireConfigured: true,
  });

  if (!validation.isValid) {
    throw new SubscriptionCatalogConfigurationError(
      'SUBSCRIPTION_CATALOG_CONFIGURATION_INCOMPLETE',
      'Apple subscription catalog configuration is incomplete',
      503
    );
  }

  return validation.normalized;
}

function ensureGooglePlayCatalogConfiguration() {
  const validation = validateGooglePlayProductConfiguration(getGooglePlayProductConfiguration(), {
    requireConfigured: true,
  });

  if (!validation.isValid) {
    throw new SubscriptionCatalogConfigurationError(
      'SUBSCRIPTION_CATALOG_CONFIGURATION_INCOMPLETE',
      'Google Play subscription catalog configuration is incomplete',
      503
    );
  }

  return validation.normalized;
}

function buildPlanEntry(plan, appleConfig, googleConfig) {
  const appleProductIds = plan === 'basic'
    ? appleConfig.basicProductIds
    : appleConfig.proProductIds;

  const googlePlanConfig = plan === 'basic'
    ? googleConfig.basic
    : googleConfig.pro;

  return {
    plan,
    apple: {
      productIds: [...appleProductIds],
    },
    googlePlay: {
      productId: googlePlanConfig.productId,
      basePlanId: googlePlanConfig.basePlanId,
      offerId: googlePlanConfig.offerId || null,
    },
  };
}

function getSubscriptionCatalog() {
  const appleConfig = ensureAppleCatalogConfiguration();
  const googlePlayConfig = ensureGooglePlayCatalogConfiguration();

  const plans = PROVIDER_BACKED_SUBSCRIPTION_PLANS
    .map((plan) => buildPlanEntry(plan, appleConfig, googlePlayConfig))
    .filter((entry) => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }

      if (!entry.apple || !Array.isArray(entry.apple.productIds) || entry.apple.productIds.length === 0) {
        return false;
      }

      if (!entry.googlePlay || !entry.googlePlay.productId || !entry.googlePlay.basePlanId) {
        return false;
      }

      return true;
    });

  return { plans };
}

module.exports = {
  SubscriptionCatalogConfigurationError,
  getSubscriptionCatalog,
};
