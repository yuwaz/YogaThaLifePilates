const { Studio } = require('../models');
const subscriptionService = require('../services/subscriptionService');
const {
  ApplePurchaseIntentError,
  createApplePurchaseIntentForStudio,
} = require('../services/applePurchaseIntentService');
const {
  ApplePurchaseVerificationError,
  verifyApplePurchaseForStudio,
} = require('../services/applePurchaseVerificationService');
const {
  GooglePlayPurchaseIntentError,
  createGooglePlayPurchaseIntentForStudio,
} = require('../services/googlePlayPurchaseIntentService');
const {
  GooglePlayPurchaseVerificationError,
  normalizePurchaseToken,
  verifyGooglePlayPurchaseForStudio,
} = require('../services/googlePlayPurchaseVerificationService');
const {
  AppleRestoreError,
  restoreAppleSubscriptionForStudio,
} = require('../services/appleRestoreService');
const {
  GooglePlayRestoreError,
  restoreGooglePlaySubscriptionForStudio,
} = require('../services/googlePlayRestoreService');
const {
  SubscriptionCatalogConfigurationError,
  getSubscriptionCatalog,
} = require('../services/subscriptionCatalogService');

async function getStatus(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const studio = await Studio.findByPk(studioId);
    if (!studio) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json(subscriptionService.normalizeSubscriptionResponse(studio));
  } catch (error) {
    return res.status(500).json({ error: 'Server error' });
  }
}

async function getCatalog(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    return res.status(200).json(getSubscriptionCatalog());
  } catch (error) {
    if (error instanceof SubscriptionCatalogConfigurationError) {
      return res.status(error.httpStatus || 500).json({
        error: error.code,
      });
    }

    return res.status(500).json({
      error: 'SUBSCRIPTION_CATALOG_FETCH_FAILED',
    });
  }
}

async function getManagementStatus(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const studio = await Studio.findByPk(studioId);
    if (!studio) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json(subscriptionService.normalizeManagementResponse(studio));
  } catch (error) {
    return res.status(500).json({ error: 'Server error' });
  }
}

async function updateManagementStatus(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const studio = await Studio.findByPk(studioId);
    if (!studio) {
      return res.status(404).json({ error: 'Not found' });
    }

    const updates = {};
    const body = req && req.body && typeof req.body === 'object' ? req.body : {};

    if (Object.prototype.hasOwnProperty.call(body, 'subscriptionStatus')) {
      const status = body.subscriptionStatus;
      if (!subscriptionService.isValidSubscriptionStatus(status)) {
        return res.status(400).json({
          error: 'Validation error',
          details: [{ message: 'Invalid subscriptionStatus', path: 'subscriptionStatus', value: status }],
        });
      }
      if (status !== studio.subscriptionStatus) {
        updates.subscriptionStatus = status;
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'trialEndsAt')) {
      try {
        const normalizedTrialEndsAt = subscriptionService.normalizeTrialEndsAtInput(body.trialEndsAt);
        const currentTrialEndsAt = studio.trialEndsAt ? new Date(studio.trialEndsAt).toISOString() : null;
        const nextTrialEndsAt = normalizedTrialEndsAt ? normalizedTrialEndsAt.toISOString() : null;
        if (nextTrialEndsAt !== currentTrialEndsAt) {
          updates.trialEndsAt = normalizedTrialEndsAt;
        }
      } catch (error) {
        return res.status(400).json({
          error: 'Validation error',
          details: [{ message: error.message, path: 'trialEndsAt', value: body.trialEndsAt }],
        });
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'subscriptionPlan')) {
      try {
        const normalizedSubscriptionPlan = subscriptionService.normalizeSubscriptionPlanInput(body.subscriptionPlan);
        if (normalizedSubscriptionPlan !== studio.subscriptionPlan) {
          updates.subscriptionPlan = normalizedSubscriptionPlan;
        }
      } catch (error) {
        return res.status(400).json({
          error: 'Validation error',
          details: [{ message: error.message, path: 'subscriptionPlan', value: body.subscriptionPlan }],
        });
      }
    }

    if (Object.keys(updates).length > 0) {
      studio.set(updates);
      await studio.save({ fields: Object.keys(updates) });
    }

    await studio.reload();
    return res.json(subscriptionService.normalizeManagementResponse(studio));
  } catch (error) {
    return res.status(500).json({ error: 'Server error' });
  }
}

async function createApplePurchaseIntent(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const body = req && req.body && typeof req.body === 'object' ? req.body : {};
    const plan = body.plan;

    if (!subscriptionService.isValidProviderBackedPlan(plan)) {
      return res.status(400).json({
        error: 'INVALID_SUBSCRIPTION_PLAN',
      });
    }

    const userId = req && req.user && Number.isInteger(req.user.id) && req.user.id > 0
      ? req.user.id
      : null;

    const purchaseIntent = await createApplePurchaseIntentForStudio({
      studioId,
      userId,
      targetPlan: plan,
      now: new Date(),
    });

    return res.status(201).json({
      purchaseIntent,
    });
  } catch (error) {
    if (error instanceof ApplePurchaseIntentError) {
      return res.status(error.httpStatus || 400).json({
        error: error.code,
      });
    }

    return res.status(500).json({
      error: 'PURCHASE_INTENT_CREATION_FAILED',
    });
  }
}

async function verifyApplePurchase(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const userId = req && req.user && Number.isInteger(req.user.id) && req.user.id > 0
      ? req.user.id
      : null;

    const body = req && req.body && typeof req.body === 'object' ? req.body : {};
    const purchaseIntentId = body.purchaseIntentId;
    const signedTransactionInfo = body.signedTransactionInfo;

    const result = await verifyApplePurchaseForStudio({
      studioId,
      userId,
      purchaseIntentId,
      signedTransactionInfo,
      now: new Date(),
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof ApplePurchaseVerificationError) {
      return res.status(error.httpStatus || 400).json({
        error: error.code,
      });
    }

    return res.status(500).json({
      error: 'APPLE_PURCHASE_VERIFICATION_FAILED',
    });
  }
}

async function restoreAppleSubscription(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const result = await restoreAppleSubscriptionForStudio({
      studioId,
      body: req && req.body,
      now: new Date(),
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof AppleRestoreError) {
      return res.status(error.httpStatus || 400).json({
        error: error.code,
      });
    }

    return res.status(500).json({
      error: 'APPLE_RESTORE_FAILED',
    });
  }
}

async function createGooglePlayPurchaseIntent(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const body = req && req.body && typeof req.body === 'object' ? req.body : {};
    const plan = body.plan;

    if (!subscriptionService.isValidProviderBackedPlan(plan)) {
      return res.status(400).json({
        error: 'INVALID_SUBSCRIPTION_PLAN',
      });
    }

    const userId = req && req.user && Number.isInteger(req.user.id) && req.user.id > 0
      ? req.user.id
      : null;

    const purchaseIntent = await createGooglePlayPurchaseIntentForStudio({
      studioId,
      userId,
      targetPlan: plan,
      now: new Date(),
    });

    return res.status(201).json({
      purchaseIntent,
    });
  } catch (error) {
    if (error instanceof GooglePlayPurchaseIntentError) {
      return res.status(error.httpStatus || 400).json({
        error: error.code,
      });
    }

    return res.status(500).json({
      error: 'GOOGLE_PLAY_PURCHASE_INTENT_CREATION_FAILED',
    });
  }
}

async function verifyGooglePlayPurchase(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const body = req && req.body && typeof req.body === 'object' ? req.body : {};
    const purchaseIntentId = body.purchaseIntentId;

    if (!Number.isInteger(purchaseIntentId) || purchaseIntentId <= 0) {
      return res.status(400).json({
        error: 'INVALID_PURCHASE_VERIFICATION_REQUEST',
      });
    }

    const purchaseToken = normalizePurchaseToken(body.purchaseToken);
    const userId = req && req.user && Number.isInteger(req.user.id) && req.user.id > 0
      ? req.user.id
      : null;

    const result = await verifyGooglePlayPurchaseForStudio({
      studioId,
      userId,
      purchaseIntentId,
      purchaseToken,
      now: new Date(),
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof GooglePlayPurchaseVerificationError) {
      return res.status(error.httpStatus || 400).json({
        error: error.code,
      });
    }

    return res.status(500).json({
      error: 'GOOGLE_PLAY_PURCHASE_VERIFICATION_FAILED',
    });
  }
}

async function restoreGooglePlaySubscription(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const result = await restoreGooglePlaySubscriptionForStudio({
      studioId,
      body: req && req.body,
      now: new Date(),
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof GooglePlayRestoreError) {
      return res.status(error.httpStatus || 400).json({
        error: error.code,
      });
    }

    return res.status(500).json({
      error: 'GOOGLE_PLAY_RESTORE_FAILED',
    });
  }
}

module.exports = {
  getStatus,
  getCatalog,
  getManagementStatus,
  updateManagementStatus,
  createApplePurchaseIntent,
  verifyApplePurchase,
  restoreAppleSubscription,
  createGooglePlayPurchaseIntent,
  verifyGooglePlayPurchase,
  restoreGooglePlaySubscription,
};