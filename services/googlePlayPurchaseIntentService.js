const { Op } = require('sequelize');
const {
  sequelize,
  SubscriptionPurchaseIntent,
  StudioSubscriptionEntitlement,
} = require('../models');
const subscriptionService = require('./subscriptionService');
const {
  generateGoogleObfuscatedAccountId,
} = require('./googlePlaySubscriptionService');

const DEFAULT_GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES = 15;
const MIN_GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES = 5;
const MAX_GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES = 60;
const MIN_GOOGLE_PLAY_ACCOUNT_HASH_SECRET_LENGTH = 32;
const REUSABLE_PURCHASE_INTENT_STATUSES = Object.freeze(['created', 'started']);
const CREATE_INTENT_MAX_RETRIES = 3;

class GooglePlayPurchaseIntentError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = 'GooglePlayPurchaseIntentError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function resolveGooglePlayPurchaseIntentTtlMinutes() {
  const raw = process.env.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES;
  if (typeof raw === 'undefined' || raw === null || String(raw).trim() === '') {
    return DEFAULT_GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new GooglePlayPurchaseIntentError(
      'GOOGLE_PLAY_PURCHASE_INTENT_CREATION_FAILED',
      'Invalid Google Play purchase intent configuration',
      500
    );
  }

  if (parsed < MIN_GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES || parsed > MAX_GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES) {
    throw new GooglePlayPurchaseIntentError(
      'GOOGLE_PLAY_PURCHASE_INTENT_CREATION_FAILED',
      'Invalid Google Play purchase intent configuration',
      500
    );
  }

  return parsed;
}

function resolveGooglePlayAccountHashSecret() {
  const raw = process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GooglePlayPurchaseIntentError(
      'GOOGLE_PLAY_ACCOUNT_CONFIGURATION_FAILED',
      'Google Play account configuration is invalid',
      500
    );
  }

  const normalized = raw.trim();
  if (normalized.length < MIN_GOOGLE_PLAY_ACCOUNT_HASH_SECRET_LENGTH) {
    throw new GooglePlayPurchaseIntentError(
      'GOOGLE_PLAY_ACCOUNT_CONFIGURATION_FAILED',
      'Google Play account configuration is invalid',
      500
    );
  }

  return normalized;
}

function buildExpiryDate(now = new Date()) {
  const ttlMinutes = resolveGooglePlayPurchaseIntentTtlMinutes();
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

async function expireReusableGooglePlayPurchaseIntents({ studioId, now, transaction }) {
  await SubscriptionPurchaseIntent.update(
    {
      status: 'expired',
      updatedAt: now,
    },
    {
      where: {
        studioId,
        provider: 'google_play',
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

function toSafeGooglePlayPurchaseIntentDto(purchaseIntent) {
  return {
    id: purchaseIntent.id,
    provider: purchaseIntent.provider,
    plan: purchaseIntent.targetPlan,
    obfuscatedAccountId: purchaseIntent.googleObfuscatedAccountId,
    expiresAt: purchaseIntent.expiresAt.toISOString(),
  };
}

function isReusableIntentUniqueConstraintError(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const message = typeof error.message === 'string' ? error.message : '';
  const indexName = 'subscription_purchase_intents_one_reusable_per_studio_provider_unique';
  return message.includes(indexName) || message.includes('SubscriptionPurchaseIntents.studioId') || message.includes('UNIQUE constraint failed');
}

async function createGooglePlayPurchaseIntentForStudio({
  studioId,
  userId,
  targetPlan,
  now = new Date(),
}) {
  if (!Number.isInteger(studioId) || studioId <= 0) {
    throw new GooglePlayPurchaseIntentError(
      'GOOGLE_PLAY_PURCHASE_INTENT_CREATION_FAILED',
      'Studio context is invalid',
      403
    );
  }

  if (!subscriptionService.isValidProviderBackedPlan(targetPlan)) {
    throw new GooglePlayPurchaseIntentError('INVALID_SUBSCRIPTION_PLAN', 'Invalid subscription plan', 400);
  }

  const safeUserId = Number.isInteger(userId) && userId > 0 ? userId : null;

  for (let attempt = 0; attempt < CREATE_INTENT_MAX_RETRIES; attempt += 1) {
    try {
      const result = await sequelize.transaction(async (transaction) => {
        const effectiveEntitlement = await findEffectiveEntitlementForStudio({
          studioId,
          transaction,
        });

        if (effectiveEntitlement) {
          if (effectiveEntitlement.provider === 'google_play') {
            throw new GooglePlayPurchaseIntentError(
              'GOOGLE_PLAY_ENTITLEMENT_ALREADY_ACTIVE',
              'An active Google Play entitlement already exists for this studio',
              409
            );
          }

          throw new GooglePlayPurchaseIntentError(
            'OTHER_PROVIDER_ENTITLEMENT_ACTIVE',
            'Another provider entitlement is already active for this studio',
            409
          );
        }

        const secret = resolveGooglePlayAccountHashSecret();
        const obfuscatedAccountId = generateGoogleObfuscatedAccountId({
          studioId,
          secret,
        });
        const expiresAt = buildExpiryDate(now);

        await expireReusableGooglePlayPurchaseIntents({
          studioId,
          now,
          transaction,
        });

        const createdIntent = await SubscriptionPurchaseIntent.create({
          studioId,
          provider: 'google_play',
          targetPlan,
          appAccountToken: null,
          googleObfuscatedAccountId: obfuscatedAccountId,
          googleObfuscatedProfileId: null,
          status: 'created',
          expiresAt,
          consumedAt: null,
          createdByUserId: safeUserId,
          metadataJson: null,
        }, { transaction });

        return toSafeGooglePlayPurchaseIntentDto(createdIntent);
      });

      return result;
    } catch (error) {
      if (error instanceof GooglePlayPurchaseIntentError) {
        throw error;
      }

      if (isReusableIntentUniqueConstraintError(error) && attempt < CREATE_INTENT_MAX_RETRIES - 1) {
        continue;
      }

      throw new GooglePlayPurchaseIntentError(
        'GOOGLE_PLAY_PURCHASE_INTENT_CREATION_FAILED',
        'Failed to create Google Play purchase intent',
        500
      );
    }
  }

  throw new GooglePlayPurchaseIntentError(
    'GOOGLE_PLAY_PURCHASE_INTENT_CREATION_FAILED',
    'Failed to create Google Play purchase intent',
    500
  );
}

module.exports = {
  GooglePlayPurchaseIntentError,
  DEFAULT_GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES,
  MIN_GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES,
  MAX_GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES,
  MIN_GOOGLE_PLAY_ACCOUNT_HASH_SECRET_LENGTH,
  REUSABLE_PURCHASE_INTENT_STATUSES,
  resolveGooglePlayPurchaseIntentTtlMinutes,
  resolveGooglePlayAccountHashSecret,
  buildExpiryDate,
  findEffectiveEntitlementForStudio,
  expireReusableGooglePlayPurchaseIntents,
  createGooglePlayPurchaseIntentForStudio,
  toSafeGooglePlayPurchaseIntentDto,
};
