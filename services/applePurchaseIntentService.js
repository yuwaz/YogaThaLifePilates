const { Op } = require('sequelize');
const {
  sequelize,
  SubscriptionPurchaseIntent,
  StudioSubscriptionEntitlement,
} = require('../models');
const subscriptionService = require('./subscriptionService');
const { generateAppAccountToken } = require('./appleSubscriptionService');

const DEFAULT_APPLE_PURCHASE_INTENT_TTL_MINUTES = 15;
const MIN_APPLE_PURCHASE_INTENT_TTL_MINUTES = 5;
const MAX_APPLE_PURCHASE_INTENT_TTL_MINUTES = 60;
const REUSABLE_PURCHASE_INTENT_STATUSES = Object.freeze(['created', 'started']);
const TOKEN_GENERATION_MAX_RETRIES = 3;

class ApplePurchaseIntentError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = 'ApplePurchaseIntentError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function resolveApplePurchaseIntentTtlMinutes() {
  const raw = process.env.APPLE_PURCHASE_INTENT_TTL_MINUTES;
  if (typeof raw === 'undefined' || raw === null || String(raw).trim() === '') {
    return DEFAULT_APPLE_PURCHASE_INTENT_TTL_MINUTES;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ApplePurchaseIntentError(
      'PURCHASE_INTENT_CREATION_FAILED',
      'Invalid purchase intent TTL configuration',
      500
    );
  }

  if (parsed < MIN_APPLE_PURCHASE_INTENT_TTL_MINUTES || parsed > MAX_APPLE_PURCHASE_INTENT_TTL_MINUTES) {
    throw new ApplePurchaseIntentError(
      'PURCHASE_INTENT_CREATION_FAILED',
      'Invalid purchase intent TTL configuration',
      500
    );
  }

  return parsed;
}

function buildExpiryDate(now = new Date()) {
  const ttlMinutes = resolveApplePurchaseIntentTtlMinutes();
  return new Date(now.getTime() + ttlMinutes * 60 * 1000);
}

async function findEffectiveEntitlementForStudio({ studioId, transaction }) {
  const effectiveStatuses = subscriptionService.getEffectiveEntitlementStatuses();
  return StudioSubscriptionEntitlement.findOne({
    where: {
      studioId,
      normalizedStatus: {
        [Op.in]: effectiveStatuses,
      },
    },
    order: [['updatedAt', 'DESC']],
    transaction,
  });
}

async function expireReusableApplePurchaseIntents({ studioId, now, transaction }) {
  await SubscriptionPurchaseIntent.update(
    {
      status: 'expired',
      updatedAt: now,
    },
    {
      where: {
        studioId,
        provider: 'apple',
        status: {
          [Op.in]: REUSABLE_PURCHASE_INTENT_STATUSES,
        },
        expiresAt: {
          [Op.gt]: now,
        },
      },
      transaction,
    }
  );
}

function toSafePurchaseIntentDto(purchaseIntent) {
  return {
    id: purchaseIntent.id,
    provider: purchaseIntent.provider,
    plan: purchaseIntent.targetPlan,
    appAccountToken: purchaseIntent.appAccountToken,
    expiresAt: purchaseIntent.expiresAt.toISOString(),
  };
}

function isAppAccountTokenUniqueConstraintError(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const message = typeof error.message === 'string' ? error.message : '';
  const indexName = 'subscription_purchase_intents_app_account_token_unique';
  return message.includes(indexName) || message.includes('appAccountToken');
}

async function createApplePurchaseIntentForStudio({
  studioId,
  userId,
  targetPlan,
  now = new Date(),
}) {
  if (!Number.isInteger(studioId) || studioId <= 0) {
    throw new ApplePurchaseIntentError('PURCHASE_INTENT_CREATION_FAILED', 'Studio context is invalid', 403);
  }

  if (!subscriptionService.isValidProviderBackedPlan(targetPlan)) {
    throw new ApplePurchaseIntentError('INVALID_SUBSCRIPTION_PLAN', 'Invalid subscription plan', 400);
  }

  const expiresAt = buildExpiryDate(now);
  const safeUserId = Number.isInteger(userId) && userId > 0 ? userId : null;

  for (let attempt = 0; attempt < TOKEN_GENERATION_MAX_RETRIES; attempt += 1) {
    const appAccountToken = generateAppAccountToken();

    try {
      const result = await sequelize.transaction(async (transaction) => {
        const effectiveEntitlement = await findEffectiveEntitlementForStudio({
          studioId,
          transaction,
        });

        if (effectiveEntitlement) {
          if (effectiveEntitlement.provider === 'apple') {
            throw new ApplePurchaseIntentError(
              'APPLE_ENTITLEMENT_ALREADY_ACTIVE',
              'An active Apple entitlement already exists for this studio',
              409
            );
          }

          throw new ApplePurchaseIntentError(
            'OTHER_PROVIDER_ENTITLEMENT_ACTIVE',
            'Another provider entitlement is already active for this studio',
            409
          );
        }

        await expireReusableApplePurchaseIntents({
          studioId,
          now,
          transaction,
        });

        const createdIntent = await SubscriptionPurchaseIntent.create(
          {
            studioId,
            provider: 'apple',
            targetPlan,
            appAccountToken,
            googleObfuscatedAccountId: null,
            googleObfuscatedProfileId: null,
            status: 'created',
            expiresAt,
            consumedAt: null,
            createdByUserId: safeUserId,
            metadataJson: null,
          },
          { transaction }
        );

        return toSafePurchaseIntentDto(createdIntent);
      });

      return result;
    } catch (error) {
      if (error instanceof ApplePurchaseIntentError) {
        throw error;
      }

      if (isAppAccountTokenUniqueConstraintError(error) && attempt < TOKEN_GENERATION_MAX_RETRIES - 1) {
        continue;
      }

      throw new ApplePurchaseIntentError(
        'PURCHASE_INTENT_CREATION_FAILED',
        'Failed to create purchase intent',
        500
      );
    }
  }

  throw new ApplePurchaseIntentError(
    'PURCHASE_INTENT_CREATION_FAILED',
    'Failed to create purchase intent',
    500
  );
}

module.exports = {
  ApplePurchaseIntentError,
  DEFAULT_APPLE_PURCHASE_INTENT_TTL_MINUTES,
  MIN_APPLE_PURCHASE_INTENT_TTL_MINUTES,
  MAX_APPLE_PURCHASE_INTENT_TTL_MINUTES,
  REUSABLE_PURCHASE_INTENT_STATUSES,
  resolveApplePurchaseIntentTtlMinutes,
  findEffectiveEntitlementForStudio,
  expireReusableApplePurchaseIntents,
  createApplePurchaseIntentForStudio,
};