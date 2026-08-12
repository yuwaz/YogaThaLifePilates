const { Op } = require('sequelize');
const {
  sequelize,
  StudioSubscriptionEntitlement,
  GooglePlaySubscriptionTransaction,
} = require('../models');
const subscriptionService = require('./subscriptionService');
const {
  mapGoogleApiError,
  normalizePurchaseToken,
  parseAllowedGooglePlayEnvironments,
  buildGooglePlayTransactionSnapshot,
  shouldApplyGooglePlayTransactionUpdate,
  shouldApplyGooglePlayEntitlementUpdate,
  GooglePlayPurchaseVerificationError,
} = require('./googlePlayPurchaseVerificationService');
const {
  getGooglePlayProductConfiguration,
  validateGooglePlayProductConfiguration,
} = require('../models/googlePlaySubscriptionMetadata');
const {
  getGooglePlayDeveloperClient,
} = require('./googlePlayDeveloperClient');
const {
  generateGoogleObfuscatedAccountId,
  mapGooglePlaySubscriptionV2ToEntitlementInput,
  secureEquals,
} = require('./googlePlaySubscriptionService');

class GooglePlayRestoreError extends Error {
  constructor(code, message, httpStatus = 400, retryable = false) {
    super(message);
    this.name = 'GooglePlayRestoreError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

function normalizeString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function extractGoogleApiData(apiResponse) {
  if (!apiResponse || typeof apiResponse !== 'object') {
    return null;
  }

  if (apiResponse.data && typeof apiResponse.data === 'object') {
    return apiResponse.data;
  }

  return apiResponse;
}

function resolveRuntimeConfiguration(override = null) {
  if (override && typeof override === 'object') {
    return override;
  }

  const source = getGooglePlayProductConfiguration();
  const validation = validateGooglePlayProductConfiguration(source, { requireConfigured: true });
  if (!validation.isValid) {
    throw new GooglePlayRestoreError(
      'GOOGLE_PLAY_RESTORE_CONFIGURATION_FAILED',
      'Google Play restore configuration is invalid',
      500
    );
  }

  const accountHashSecret = normalizeString(process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET);
  if (!accountHashSecret) {
    throw new GooglePlayRestoreError(
      'GOOGLE_PLAY_RESTORE_CONFIGURATION_FAILED',
      'Google Play restore configuration is invalid',
      500
    );
  }

  return {
    productConfiguration: validation.normalized,
    packageName: validation.normalized.packageName,
    accountHashSecret,
    allowedEnvironments: parseAllowedGooglePlayEnvironments(),
  };
}

function toSafeRestoredResponse({ entitlement, alreadyKnown }) {
  return {
    restored: true,
    alreadyKnown,
    provider: 'google_play',
    statusRefreshRequired: true,
    normalizedStatus: entitlement.normalizedStatus,
  };
}

function mapMappedFailureToRestoreError(mappedCode) {
  if (mappedCode === 'GOOGLE_PLAY_ENVIRONMENT_MISMATCH') {
    return new GooglePlayRestoreError('GOOGLE_PLAY_ENVIRONMENT_NOT_ALLOWED', 'Google Play purchase environment is not allowed', 400);
  }

  if (mappedCode === 'GOOGLE_PLAY_ACCOUNT_ID_MISMATCH') {
    return new GooglePlayRestoreError('GOOGLE_PLAY_ACCOUNT_IDENTIFIER_MISMATCH', 'Google Play account identifier does not match studio', 409);
  }

  if (mappedCode === 'GOOGLE_PLAY_ACCOUNT_ID_MISSING') {
    return new GooglePlayRestoreError('GOOGLE_PLAY_ACCOUNT_IDENTIFIER_MISSING', 'Google Play account identifier is missing', 409);
  }

  if (mappedCode === 'GOOGLE_PLAY_PRODUCT_MAPPING_INVALID') {
    return new GooglePlayRestoreError('GOOGLE_PLAY_PURCHASE_PLAN_MISMATCH', 'Google Play purchase plan is not allowed', 409);
  }

  if (mappedCode === 'GOOGLE_PLAY_SUBSCRIPTION_STATE_INVALID' || mappedCode === 'GOOGLE_PLAY_SUBSCRIPTION_STATE_UNMAPPED') {
    return new GooglePlayRestoreError('GOOGLE_PLAY_RESTORE_FAILED', 'Google Play subscription state is unsupported', 400);
  }

  return new GooglePlayRestoreError('GOOGLE_PLAY_RESTORE_FAILED', 'Google Play restore failed', 400);
}

async function restoreGooglePlaySubscriptionForStudio({
  studioId,
  body,
  now = new Date(),
  dependencies = {},
} = {}) {
  if (!Number.isInteger(studioId) || studioId <= 0) {
    throw new GooglePlayRestoreError('INVALID_RESTORE_REQUEST', 'Studio context is invalid', 403);
  }

  const source = body && typeof body === 'object' ? body : {};
  let purchaseToken;
  try {
    purchaseToken = normalizePurchaseToken(source.purchaseToken);
  } catch (error) {
    if (error instanceof GooglePlayPurchaseVerificationError) {
      throw new GooglePlayRestoreError('INVALID_RESTORE_REQUEST', 'purchaseToken is invalid', 400);
    }
    throw error;
  }

  const runtimeConfig = resolveRuntimeConfiguration(dependencies.runtimeConfig);
  const expectedObfuscatedAccountId = generateGoogleObfuscatedAccountId({
    studioId,
    secret: runtimeConfig.accountHashSecret,
  });

  const client = dependencies.googleClient || getGooglePlayDeveloperClient().client;

  let apiResponse;
  try {
    apiResponse = await client.purchases.subscriptionsv2.get({
      packageName: runtimeConfig.packageName,
      token: purchaseToken,
    });
  } catch (error) {
    const mapped = mapGoogleApiError(error);
    throw new GooglePlayRestoreError(mapped.code, 'Google Play restore failed', mapped.httpStatus, mapped.retryable);
  }

  const apiData = extractGoogleApiData(apiResponse);
  const mapped = mapGooglePlaySubscriptionV2ToEntitlementInput({
    response: apiData,
    purchaseToken,
    expectedPackageName: runtimeConfig.packageName,
    expectedObfuscatedAccountId,
    config: runtimeConfig.productConfiguration,
    now,
  });

  if (!mapped.ok) {
    throw mapMappedFailureToRestoreError(mapped.code);
  }

  if (!runtimeConfig.allowedEnvironments.has(mapped.value.environment)) {
    throw new GooglePlayRestoreError(
      'GOOGLE_PLAY_ENVIRONMENT_NOT_ALLOWED',
      'Google Play purchase environment is not allowed',
      400
    );
  }

  const candidateEffective = subscriptionService.isEffectiveEntitlementStatus(mapped.value.normalizedStatus);
  const candidateTransactionSnapshot = buildGooglePlayTransactionSnapshot({
    studioId,
    now,
    mapped: mapped.value,
    apiData,
    purchaseToken,
  });

  return sequelize.transaction(async (transaction) => {
    const existingTransaction = await GooglePlaySubscriptionTransaction.findOne({
      where: {
        environment: candidateTransactionSnapshot.environment,
        purchaseToken,
      },
      transaction,
    });

    if (existingTransaction && existingTransaction.studioId !== studioId) {
      throw new GooglePlayRestoreError('GOOGLE_PLAY_PURCHASE_ALREADY_BOUND', 'Google Play purchase is already bound', 409);
    }

    const existingEntitlement = await StudioSubscriptionEntitlement.findOne({
      where: {
        provider: 'google_play',
        environment: candidateTransactionSnapshot.environment,
        providerSubscriptionId: purchaseToken,
      },
      transaction,
    });

    if (existingEntitlement && existingEntitlement.studioId !== studioId) {
      throw new GooglePlayRestoreError('GOOGLE_PLAY_PURCHASE_ALREADY_BOUND', 'Google Play purchase is already bound', 409);
    }

    const ownedEffectiveEntitlement = await StudioSubscriptionEntitlement.findOne({
      where: {
        studioId,
        normalizedStatus: {
          [Op.in]: subscriptionService.getEffectiveEntitlementStatuses(),
        },
      },
      order: [['updatedAt', 'DESC']],
      transaction,
    });

    if (candidateEffective && ownedEffectiveEntitlement) {
      if (ownedEffectiveEntitlement.provider !== 'google_play') {
        throw new GooglePlayRestoreError(
          'OTHER_PROVIDER_ENTITLEMENT_ACTIVE',
          'Another provider entitlement is already active for this studio',
          409
        );
      }

      const sameTokenReplacement = normalizeString(ownedEffectiveEntitlement.providerSubscriptionId)
        && normalizeString(mapped.value.linkedPurchaseToken)
        && secureEquals(ownedEffectiveEntitlement.providerSubscriptionId, mapped.value.linkedPurchaseToken);

      const sameTokenBinding = normalizeString(ownedEffectiveEntitlement.providerSubscriptionId)
        && secureEquals(ownedEffectiveEntitlement.providerSubscriptionId, purchaseToken);

      if (!sameTokenBinding && !sameTokenReplacement) {
        throw new GooglePlayRestoreError(
          'GOOGLE_PLAY_OTHER_SUBSCRIPTION_ACTIVE',
          'Another Google Play subscription is already active for this studio',
          409
        );
      }

      if (sameTokenReplacement && ownedEffectiveEntitlement.providerSubscriptionId !== purchaseToken) {
        const replacementStatus = ownedEffectiveEntitlement.currentPeriodEnd
          && ownedEffectiveEntitlement.currentPeriodEnd.getTime() <= now.getTime()
          ? 'expired'
          : 'cancelled';

        await ownedEffectiveEntitlement.update({
          normalizedStatus: replacementStatus,
          sourceLastUpdate: 'reconciliation',
          providerEventTime: now,
          lastVerifiedAt: now,
        }, { transaction });
      }
    }

    if (existingTransaction) {
      if (shouldApplyGooglePlayTransactionUpdate(existingTransaction, candidateTransactionSnapshot)) {
        await existingTransaction.update(candidateTransactionSnapshot, { transaction });
      }
    } else {
      await GooglePlaySubscriptionTransaction.create(candidateTransactionSnapshot, { transaction });
    }

    const entitlementSnapshot = {
      studioId,
      provider: 'google_play',
      plan: mapped.value.plan,
      normalizedStatus: mapped.value.normalizedStatus,
      providerProductId: mapped.value.providerProductId,
      providerSubscriptionId: purchaseToken,
      currentPeriodStart: mapped.value.currentPeriodStart,
      currentPeriodEnd: mapped.value.currentPeriodEnd,
      trialEndsAt: mapped.value.trialDetectedReliably ? mapped.value.currentPeriodEnd : null,
      autoRenewEnabled: mapped.value.autoRenewEnabled,
      gracePeriodEndsAt: null,
      revokedAt: null,
      refundedAt: null,
      pausedAt: null,
      lastVerifiedAt: now,
      sourceLastUpdate: 'reconciliation',
      environment: mapped.value.environment,
      providerStateVersion: normalizeString(apiData && apiData.etag),
      providerEventTime: candidateTransactionSnapshot.providerEventTime,
    };

    let entitlement = existingEntitlement;
    let alreadyKnown = Boolean(existingEntitlement);

    if (entitlement) {
      if (shouldApplyGooglePlayEntitlementUpdate(entitlement, entitlementSnapshot)) {
        await entitlement.update(entitlementSnapshot, { transaction });
      }
    } else {
      entitlement = await StudioSubscriptionEntitlement.create(entitlementSnapshot, { transaction });
      alreadyKnown = false;
    }

    await entitlement.reload({ transaction });

    return toSafeRestoredResponse({
      entitlement,
      alreadyKnown,
    });
  });
}

module.exports = {
  GooglePlayRestoreError,
  restoreGooglePlaySubscriptionForStudio,
};
