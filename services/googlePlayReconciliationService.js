const { Op } = require('sequelize');
const {
  sequelize,
  StudioSubscriptionEntitlement,
  GooglePlaySubscriptionTransaction,
  GooglePubSubNotificationInbox,
} = require('../models');
const subscriptionService = require('./subscriptionService');
const {
  getGooglePlayProductConfiguration,
  validateGooglePlayProductConfiguration,
} = require('../models/googlePlaySubscriptionMetadata');
const {
  generateGoogleObfuscatedAccountId,
  mapGooglePlaySubscriptionV2ToEntitlementInput,
  secureEquals,
} = require('./googlePlaySubscriptionService');
const {
  mapGoogleApiError,
  buildGooglePlayTransactionSnapshot,
  shouldApplyGooglePlayTransactionUpdate,
  shouldApplyGooglePlayEntitlementUpdate,
} = require('./googlePlayPurchaseVerificationService');
const {
  GooglePlayRtdnError,
  validateGoogleDeveloperNotification,
  processGooglePlayRtdnInboxRecord,
  resolveGooglePlayRtdnConfiguration,
  loadRetryConfiguration,
  markInboxFailed,
} = require('./googlePlayRtdnService');
const {
  getGooglePlayDeveloperClient,
} = require('./googlePlayDeveloperClient');

const DEFAULT_RECONCILE_BATCH_SIZE = 25;
const MAX_RECONCILE_BATCH_SIZE = 100;
const DEFAULT_RECONCILE_LOOKBACK_DAYS = 7;
const MAX_RECONCILE_LOOKBACK_DAYS = 180;
const DEFAULT_RETRY_BATCH_SIZE = 25;
const MAX_RETRY_BATCH_SIZE = 100;

const entitlementLocks = new Map();

class GooglePlayReconciliationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'GooglePlayReconciliationError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
  }
}

function normalizeString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parsePositiveInteger(value, fallback, min, max) {
  if (typeof value === 'undefined' || value === null || String(value).trim() === '') {
    return fallback;
  }

  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    throw new GooglePlayReconciliationError('GOOGLE_PLAY_RECONCILIATION_INVALID_REQUEST', 'Numeric argument is invalid', {
      retryable: false,
    });
  }

  if (numeric < min || numeric > max) {
    throw new GooglePlayReconciliationError('GOOGLE_PLAY_RECONCILIATION_INVALID_REQUEST', 'Numeric argument is out of range', {
      retryable: false,
    });
  }

  return numeric;
}

function resolveReconcileBatchSize(value) {
  return parsePositiveInteger(
    typeof value !== 'undefined' ? value : process.env.GOOGLE_PLAY_RECONCILE_BATCH_SIZE,
    DEFAULT_RECONCILE_BATCH_SIZE,
    1,
    MAX_RECONCILE_BATCH_SIZE
  );
}

function resolveReconcileLookbackDays(value) {
  return parsePositiveInteger(
    typeof value !== 'undefined' ? value : process.env.GOOGLE_PLAY_RECONCILE_LOOKBACK_DAYS,
    DEFAULT_RECONCILE_LOOKBACK_DAYS,
    1,
    MAX_RECONCILE_LOOKBACK_DAYS
  );
}

function resolveRetryBatchSize(value) {
  return parsePositiveInteger(
    typeof value !== 'undefined' ? value : process.env.GOOGLE_PLAY_NOTIFICATION_RETRY_BATCH_SIZE,
    DEFAULT_RETRY_BATCH_SIZE,
    1,
    MAX_RETRY_BATCH_SIZE
  );
}

function resolveGoogleReconciliationConfig(dependencies = {}) {
  const configSource = dependencies.googlePlayProductConfiguration || getGooglePlayProductConfiguration();
  const validation = validateGooglePlayProductConfiguration(configSource, { requireConfigured: true });
  if (!validation.isValid) {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RECONCILIATION_CONFIGURATION_INVALID',
      'Google Play reconciliation configuration is invalid',
      { retryable: false }
    );
  }

  const packageName = normalizeString(validation.normalized.packageName);
  if (!packageName) {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RECONCILIATION_CONFIGURATION_INVALID',
      'Google Play reconciliation configuration is invalid',
      { retryable: false }
    );
  }

  const accountHashSecret = normalizeString(dependencies.googlePlayAccountHashSecret || process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET);
  if (!accountHashSecret) {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RECONCILIATION_ACCOUNT_SECRET_REQUIRED',
      'Google Play reconciliation configuration is invalid',
      { retryable: false }
    );
  }

  return {
    productConfiguration: validation.normalized,
    packageName,
    accountHashSecret,
  };
}

function resolveGoogleClient(dependencies = {}) {
  if (dependencies.googleClient) {
    return dependencies.googleClient;
  }

  if (typeof dependencies.googleClientFactory === 'function') {
    const created = dependencies.googleClientFactory();
    if (!created || typeof created !== 'object') {
      throw new GooglePlayReconciliationError(
        'GOOGLE_PLAY_RECONCILIATION_CONFIGURATION_INVALID',
        'Google Play reconciliation configuration is invalid',
        { retryable: false }
      );
    }
    return created;
  }

  return getGooglePlayDeveloperClient().client;
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

function isEffectiveStatus(value) {
  return subscriptionService.isEffectiveEntitlementStatus(value);
}

function mapReconciliationErrorFromGoogleApi(entitlement, now, mappedError) {
  if (mappedError.httpStatus === 404) {
    const periodEnd = entitlement.currentPeriodEnd instanceof Date
      ? entitlement.currentPeriodEnd
      : (entitlement.currentPeriodEnd ? new Date(entitlement.currentPeriodEnd) : null);

    const recentOrEffective = isEffectiveStatus(entitlement.normalizedStatus)
      || !periodEnd
      || Number.isNaN(periodEnd.getTime())
      || periodEnd.getTime() >= now.getTime() - (24 * 60 * 60 * 1000);

    return new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RECONCILIATION_NOT_FOUND',
      'Google Play reconciliation failed',
      { retryable: recentOrEffective }
    );
  }

  return new GooglePlayReconciliationError(
    mappedError.code || 'GOOGLE_PLAY_RECONCILIATION_FAILED',
    'Google Play reconciliation failed',
    { retryable: Boolean(mappedError.retryable) }
  );
}

function buildEntitlementCandidate({ entitlement, mappedValue, apiData, now, providerEventTime }) {
  return {
    studioId: entitlement.studioId,
    provider: 'google_play',
    plan: mappedValue.plan,
    normalizedStatus: mappedValue.normalizedStatus,
    providerProductId: mappedValue.providerProductId,
    providerSubscriptionId: entitlement.providerSubscriptionId,
    currentPeriodStart: mappedValue.currentPeriodStart,
    currentPeriodEnd: mappedValue.currentPeriodEnd,
    trialEndsAt: mappedValue.trialDetectedReliably ? mappedValue.currentPeriodEnd : null,
    autoRenewEnabled: mappedValue.autoRenewEnabled,
    gracePeriodEndsAt: null,
    revokedAt: mappedValue.normalizedStatus === 'revoked' ? providerEventTime : null,
    refundedAt: mappedValue.normalizedStatus === 'refunded' ? providerEventTime : null,
    pausedAt: mappedValue.normalizedStatus === 'paused' ? mappedValue.currentPeriodEnd : null,
    lastVerifiedAt: now,
    sourceLastUpdate: 'reconciliation',
    environment: entitlement.environment,
    providerStateVersion: normalizeString(apiData && apiData.etag),
    providerEventTime,
  };
}

function toSafeReconcileResult({ entitlement, updated, staleSkipped, transactionUpdated }) {
  return {
    entitlementId: entitlement.id,
    provider: entitlement.provider,
    status: entitlement.normalizedStatus,
    environment: entitlement.environment,
    updated,
    staleSkipped,
    transactionUpdated,
  };
}

function parseStoredNotification(rawPayloadJson) {
  if (typeof rawPayloadJson !== 'string' || rawPayloadJson.trim() === '') {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RTDN_RETRY_PAYLOAD_INVALID',
      'Stored Google RTDN payload is invalid',
      { retryable: false }
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawPayloadJson);
  } catch (error) {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RTDN_RETRY_PAYLOAD_INVALID',
      'Stored Google RTDN payload is invalid',
      { retryable: false }
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RTDN_RETRY_PAYLOAD_INVALID',
      'Stored Google RTDN payload is invalid',
      { retryable: false }
    );
  }

  if (!parsed.notification || typeof parsed.notification !== 'object' || Array.isArray(parsed.notification)) {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RTDN_RETRY_PAYLOAD_INVALID',
      'Stored Google RTDN payload is invalid',
      { retryable: false }
    );
  }

  return parsed.notification;
}

async function withEntitlementLock(entitlementId, operation) {
  const previous = entitlementLocks.get(entitlementId) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  entitlementLocks.set(entitlementId, current);

  try {
    await previous;
    return await operation();
  } finally {
    releaseCurrent();
    if (entitlementLocks.get(entitlementId) === current) {
      entitlementLocks.delete(entitlementId);
    }
  }
}

function validateEntitlementIdentity(entitlement) {
  if (!entitlement) {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RECONCILIATION_ENTITLEMENT_NOT_FOUND',
      'Google Play entitlement was not found',
      { retryable: false }
    );
  }

  if (entitlement.provider !== 'google_play') {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RECONCILIATION_PROVIDER_INVALID',
      'Google Play entitlement was not found',
      { retryable: false }
    );
  }

  if (entitlement.environment !== 'test' && entitlement.environment !== 'production') {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RECONCILIATION_ENVIRONMENT_INVALID',
      'Google Play entitlement cannot be reconciled',
      { retryable: false }
    );
  }

  if (!Number.isInteger(entitlement.studioId) || entitlement.studioId <= 0) {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RECONCILIATION_BINDING_INVALID',
      'Google Play entitlement cannot be reconciled',
      { retryable: false }
    );
  }

  if (!subscriptionService.isValidProviderBackedPlan(entitlement.plan)) {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RECONCILIATION_PLAN_INVALID',
      'Google Play entitlement cannot be reconciled',
      { retryable: false }
    );
  }

  const purchaseToken = normalizeString(entitlement.providerSubscriptionId);
  if (!purchaseToken) {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RECONCILIATION_BINDING_INVALID',
      'Google Play entitlement cannot be reconciled',
      { retryable: false }
    );
  }

  return purchaseToken;
}

async function reconcileGooglePlayEntitlement({
  entitlementId,
  now = new Date(),
  options = {},
  dependencies = {},
} = {}) {
  if (!Number.isInteger(entitlementId) || entitlementId <= 0) {
    throw new GooglePlayReconciliationError(
      'GOOGLE_PLAY_RECONCILIATION_INVALID_REQUEST',
      'entitlementId must be a positive integer',
      { retryable: false }
    );
  }

  return withEntitlementLock(entitlementId, async () => {
    const entitlement = await StudioSubscriptionEntitlement.findByPk(entitlementId);
    const purchaseToken = validateEntitlementIdentity(entitlement);

    const dryRun = Boolean(options.dryRun);
    if (dryRun) {
      return {
        entitlementId: entitlement.id,
        provider: entitlement.provider,
        status: entitlement.normalizedStatus,
        environment: entitlement.environment,
        updated: false,
        staleSkipped: false,
        transactionUpdated: false,
      };
    }

    const runtimeConfig = resolveGoogleReconciliationConfig(dependencies);

    const expectedAccountId = generateGoogleObfuscatedAccountId({
      studioId: entitlement.studioId,
      secret: runtimeConfig.accountHashSecret,
    });

    const client = resolveGoogleClient(dependencies);

    let apiResponse;
    try {
      apiResponse = await client.purchases.subscriptionsv2.get({
        packageName: runtimeConfig.packageName,
        token: purchaseToken,
      });
    } catch (error) {
      const mapped = mapGoogleApiError(error);
      throw mapReconciliationErrorFromGoogleApi(entitlement, now, mapped);
    }

    const apiData = extractGoogleApiData(apiResponse);
    const mapped = mapGooglePlaySubscriptionV2ToEntitlementInput({
      response: apiData,
      purchaseToken,
      expectedPackageName: runtimeConfig.packageName,
      expectedObfuscatedAccountId: expectedAccountId,
      config: runtimeConfig.productConfiguration,
      now,
      environment: entitlement.environment,
    });

    if (!mapped.ok) {
      const code = mapped.code || 'GOOGLE_PLAY_RECONCILIATION_FAILED';
      throw new GooglePlayReconciliationError(code, 'Google Play reconciliation failed', { retryable: false });
    }

    if (mapped.value.providerSubscriptionId !== purchaseToken) {
      throw new GooglePlayReconciliationError(
        'GOOGLE_PLAY_RECONCILIATION_BINDING_CONFLICT',
        'Google Play reconciliation failed',
        { retryable: false }
      );
    }

    if (!secureEquals(expectedAccountId, mapped.value.externalAccountIdentifier)) {
      throw new GooglePlayReconciliationError(
        'GOOGLE_PLAY_RECONCILIATION_ACCOUNT_MISMATCH',
        'Google Play reconciliation failed',
        { retryable: false }
      );
    }

    const candidateTransactionSnapshot = buildGooglePlayTransactionSnapshot({
      studioId: entitlement.studioId,
      now,
      mapped: mapped.value,
      apiData,
      purchaseToken,
    });

    const candidate = buildEntitlementCandidate({
      entitlement,
      mappedValue: mapped.value,
      apiData,
      now,
      providerEventTime: candidateTransactionSnapshot.providerEventTime,
    });

    return sequelize.transaction(async (transaction) => {
      const lockedEntitlement = await StudioSubscriptionEntitlement.findByPk(entitlement.id, { transaction });
      const lockedPurchaseToken = validateEntitlementIdentity(lockedEntitlement);

      if (lockedPurchaseToken !== purchaseToken || lockedEntitlement.environment !== entitlement.environment || lockedEntitlement.studioId !== entitlement.studioId) {
        throw new GooglePlayReconciliationError(
          'GOOGLE_PLAY_RECONCILIATION_BINDING_CONFLICT',
          'Google Play reconciliation failed',
          { retryable: true }
        );
      }

      const existingTransaction = await GooglePlaySubscriptionTransaction.findOne({
        where: {
          environment: lockedEntitlement.environment,
          purchaseToken,
        },
        transaction,
      });

      if (existingTransaction && existingTransaction.studioId !== lockedEntitlement.studioId) {
        throw new GooglePlayReconciliationError(
          'GOOGLE_PLAY_RECONCILIATION_BINDING_CONFLICT',
          'Google Play reconciliation failed',
          { retryable: false }
        );
      }

      const effectiveStatuses = subscriptionService.getEffectiveEntitlementStatuses();
      const currentEffectiveEntitlement = await StudioSubscriptionEntitlement.findOne({
        where: {
          studioId: lockedEntitlement.studioId,
          normalizedStatus: {
            [Op.in]: effectiveStatuses,
          },
        },
        order: [['updatedAt', 'DESC']],
        transaction,
      });

      const candidateEffective = subscriptionService.isEffectiveEntitlementStatus(candidate.normalizedStatus);
      if (candidateEffective && currentEffectiveEntitlement && currentEffectiveEntitlement.id !== lockedEntitlement.id) {
        if (currentEffectiveEntitlement.provider !== 'google_play') {
          throw new GooglePlayReconciliationError(
            'GOOGLE_PLAY_RECONCILIATION_OTHER_PROVIDER_ACTIVE',
            'Google Play reconciliation failed',
            { retryable: false }
          );
        }

        const currentToken = normalizeString(currentEffectiveEntitlement.providerSubscriptionId);
        const linkedToken = normalizeString(mapped.value.linkedPurchaseToken);
        const isSameToken = currentToken && secureEquals(currentToken, purchaseToken);
        const isKnownReplacement = currentToken && linkedToken && secureEquals(currentToken, linkedToken);

        if (!isSameToken && !isKnownReplacement) {
          throw new GooglePlayReconciliationError(
            'GOOGLE_PLAY_RECONCILIATION_ACTIVE_CONFLICT',
            'Google Play reconciliation failed',
            { retryable: false }
          );
        }

        if (isKnownReplacement && currentEffectiveEntitlement.providerSubscriptionId !== purchaseToken) {
          const replacementStatus = currentEffectiveEntitlement.currentPeriodEnd
            && currentEffectiveEntitlement.currentPeriodEnd.getTime() <= now.getTime()
            ? 'expired'
            : 'cancelled';

          await currentEffectiveEntitlement.update({
            normalizedStatus: replacementStatus,
            sourceLastUpdate: 'reconciliation',
            providerEventTime: candidateTransactionSnapshot.providerEventTime,
            lastVerifiedAt: now,
          }, { transaction });
        }
      }

      let transactionUpdated = false;
      if (existingTransaction) {
        if (shouldApplyGooglePlayTransactionUpdate(existingTransaction, candidateTransactionSnapshot)) {
          await existingTransaction.update(candidateTransactionSnapshot, { transaction });
          transactionUpdated = true;
        }
      } else {
        await GooglePlaySubscriptionTransaction.create(candidateTransactionSnapshot, { transaction });
        transactionUpdated = true;
      }

      const shouldUpdateEntitlement = shouldApplyGooglePlayEntitlementUpdate(lockedEntitlement, candidate);
      if (shouldUpdateEntitlement) {
        await lockedEntitlement.update(candidate, { transaction });
      }

      return toSafeReconcileResult({
        entitlement: lockedEntitlement,
        updated: shouldUpdateEntitlement,
        staleSkipped: !shouldUpdateEntitlement,
        transactionUpdated,
      });
    });
  });
}

function normalizeBatchResultError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'GOOGLE_PLAY_RECONCILIATION_FAILED',
    retryable: Boolean(error && error.retryable),
  };
}

async function reconcileGooglePlayEntitlementBatch({
  limit,
  now = new Date(),
  lookbackDays,
  dryRun = false,
  dependencies = {},
} = {}) {
  const boundedLimit = resolveReconcileBatchSize(limit);
  const boundedLookbackDays = resolveReconcileLookbackDays(lookbackDays);
  const cutoff = new Date(now.getTime() - (boundedLookbackDays * 24 * 60 * 60 * 1000));

  const failedRows = await GooglePubSubNotificationInbox.findAll({
    where: {
      processingState: 'failed',
      createdAt: {
        [Op.gte]: cutoff,
      },
      purchaseToken: {
        [Op.not]: null,
      },
    },
    attributes: ['purchaseToken'],
    limit: boundedLimit * 4,
    order: [['createdAt', 'DESC']],
  });
  const failedTokens = Array.from(new Set(failedRows
    .map((row) => normalizeString(row.purchaseToken))
    .filter(Boolean)));

  const where = {
    provider: 'google_play',
    providerSubscriptionId: {
      [Op.not]: null,
    },
    [Op.or]: [
      {
        normalizedStatus: {
          [Op.in]: subscriptionService.getEffectiveEntitlementStatuses(),
        },
      },
      {
        normalizedStatus: 'expired',
        currentPeriodEnd: {
          [Op.gte]: cutoff,
        },
      },
      {
        lastVerifiedAt: null,
      },
      {
        lastVerifiedAt: {
          [Op.lt]: cutoff,
        },
      },
    ],
  };

  if (failedTokens.length > 0) {
    where[Op.or].push({
      providerSubscriptionId: {
        [Op.in]: failedTokens,
      },
    });
  }

  const selectedRows = await StudioSubscriptionEntitlement.findAll({
    where,
    order: [
      [sequelize.literal('CASE WHEN lastVerifiedAt IS NULL THEN 0 ELSE 1 END'), 'ASC'],
      ['lastVerifiedAt', 'ASC'],
      ['id', 'ASC'],
    ],
    limit: boundedLimit,
  });

  const summary = {
    selected: selectedRows.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };

  if (dryRun) {
    summary.skipped = selectedRows.length;
    summary.results = selectedRows.map((row) => ({ entitlementId: row.id, status: 'dry_run' }));
    return summary;
  }

  for (const entitlement of selectedRows) {
    try {
      const result = await reconcileGooglePlayEntitlement({
        entitlementId: entitlement.id,
        now,
        options: { dryRun: false },
        dependencies,
      });
      summary.succeeded += 1;
      summary.results.push({ entitlementId: result.entitlementId, status: 'ok' });
    } catch (error) {
      summary.failed += 1;
      const safe = normalizeBatchResultError(error);
      summary.results.push({
        entitlementId: entitlement.id,
        status: 'failed',
        errorCode: safe.code,
        retryable: safe.retryable,
      });
    }
  }

  return summary;
}

async function retryDueGoogleRtdnInbox({
  limit,
  now = new Date(),
  dependencies = {},
} = {}) {
  const boundedLimit = resolveRetryBatchSize(limit);
  const retryConfig = loadRetryConfiguration(dependencies);

  const dueRows = await GooglePubSubNotificationInbox.findAll({
    where: {
      processingState: 'failed',
      nextAttemptAt: {
        [Op.lte]: now,
      },
      attemptCount: {
        [Op.lt]: retryConfig.maxAttempts,
      },
    },
    order: [['nextAttemptAt', 'ASC'], ['createdAt', 'ASC']],
    limit: boundedLimit,
  });

  const result = {
    selected: dueRows.length,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  const runtimeConfig = resolveGooglePlayRtdnConfiguration(dependencies);

  for (const row of dueRows) {
    result.attempted += 1;

    try {
      const notification = parseStoredNotification(row.rawPayloadJson);
      const validation = validateGoogleDeveloperNotification(notification);

      if (validation.packageName !== runtimeConfig.packageName) {
        await markInboxFailed({
          inbox: row,
          now,
          retryConfig,
          code: 'GOOGLE_PLAY_NOTIFICATION_PACKAGE_MISMATCH',
          retryable: false,
        });
        result.failed += 1;
        continue;
      }

      const processingResult = await processGooglePlayRtdnInboxRecord({
        inbox: row,
        notification,
        validation,
        now,
        dependencies,
      });

      if (processingResult && processingResult.retryable) {
        throw new GooglePlayRtdnError(
          processingResult.code || 'GOOGLE_PLAY_NOTIFICATION_PROCESSING_FAILED',
          'Notification processing failed',
          503,
          true
        );
      }

      result.succeeded += 1;
    } catch (error) {
      if (error instanceof GooglePlayRtdnError) {
        await markInboxFailed({
          inbox: row,
          now,
          retryConfig,
          code: error.code,
          retryable: Boolean(error.retryable),
        });
        result.failed += 1;
        continue;
      }

      if (error instanceof GooglePlayReconciliationError) {
        await markInboxFailed({
          inbox: row,
          now,
          retryConfig,
          code: error.code,
          retryable: false,
        });
        result.failed += 1;
        continue;
      }

      await markInboxFailed({
        inbox: row,
        now,
        retryConfig,
        code: 'GOOGLE_PLAY_NOTIFICATION_PROCESSING_FAILED',
        retryable: true,
      });
      result.failed += 1;
    }
  }

  return result;
}

module.exports = {
  GooglePlayReconciliationError,
  resolveReconcileBatchSize,
  resolveReconcileLookbackDays,
  resolveRetryBatchSize,
  reconcileGooglePlayEntitlement,
  reconcileGooglePlayEntitlementBatch,
  retryDueGoogleRtdnInbox,
};
