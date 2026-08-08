const { Op } = require('sequelize');
const {
  sequelize,
  StudioSubscriptionEntitlement,
  AppleSubscriptionTransaction,
  AppleServerNotificationInbox,
} = require('../models');
const {
  getAppleProductConfiguration,
  getAppleProductPlan,
  validateAppleProductConfiguration,
} = require('../models/appleSubscriptionMetadata');
const {
  normalizeAppleEnvironment,
} = require('./appleSubscriptionService');
const {
  shouldApplyEntitlementUpdate,
} = require('./applePurchaseVerificationService');
const {
  verifyAndDecodeTransaction,
  verifyAndDecodeRenewalInfo,
} = require('./appleSignedDataVerifier');
const {
  ingestAppleSignedPayload,
} = require('./appleNotificationService');
const {
  getAppleAppStoreServerApiClient,
  AppleAppStoreServerClientConfigurationError,
} = require('./appleAppStoreServerClient');

const DEFAULT_HISTORY_PAGE_LIMIT = 10;
const MAX_HISTORY_PAGE_LIMIT = 50;
const DEFAULT_HISTORY_TRANSACTION_LIMIT = 500;
const MAX_HISTORY_TRANSACTION_LIMIT = 5000;
const DEFAULT_NOTIFICATION_PAGE_LIMIT = 10;
const MAX_NOTIFICATION_PAGE_LIMIT = 50;
const DEFAULT_NOTIFICATION_COUNT_LIMIT = 200;
const MAX_NOTIFICATION_COUNT_LIMIT = 2000;
const DEFAULT_RETRY_LIMIT = 25;
const MAX_RETRY_LIMIT = 200;
const DEFAULT_BATCH_LIMIT = 10;
const MAX_BATCH_LIMIT = 500;
const DEFAULT_BATCH_EXPIRED_LOOKBACK_DAYS = 30;
const MAX_BATCH_EXPIRED_LOOKBACK_DAYS = 180;
const DEFAULT_NOTIFICATION_LOOKBACK_DAYS = 7;
const SANDBOX_NOTIFICATION_MAX_LOOKBACK_DAYS = 30;
const PRODUCTION_NOTIFICATION_MAX_LOOKBACK_DAYS = 180;

class AppleReconciliationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppleReconciliationError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
  }
}

function toDateFromMillis(value) {
  if (value === null || typeof value === 'undefined') {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const parsed = new Date(numeric);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function normalizeVerifierEnvironmentFromEntitlement(value) {
  if (value === 'sandbox') {
    return 'Sandbox';
  }
  if (value === 'production') {
    return 'Production';
  }
  throw new AppleReconciliationError(
    'APPLE_RECONCILIATION_ENVIRONMENT_INVALID',
    'Unsupported entitlement environment',
    { retryable: false }
  );
}

function toLedgerEnvironmentName(value) {
  if (value === 'sandbox') {
    return 'Sandbox';
  }
  if (value === 'production') {
    return 'Production';
  }
  throw new AppleReconciliationError(
    'APPLE_RECONCILIATION_ENVIRONMENT_INVALID',
    'Unsupported entitlement environment',
    { retryable: false }
  );
}

function normalizeInteger(value, fallbackValue, min, max) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    return fallbackValue;
  }
  if (numeric < min) {
    return min;
  }
  if (numeric > max) {
    return max;
  }
  return numeric;
}

function parseNotificationMaxAttempts() {
  const raw = process.env.APPLE_NOTIFICATION_MAX_ATTEMPTS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return 10;
  }
  if (parsed < 1) {
    return 1;
  }
  if (parsed > 100) {
    return 100;
  }
  return parsed;
}

function resolveBatchExpiredLookbackDays() {
  const raw = process.env.APPLE_RECONCILIATION_BATCH_EXPIRED_LOOKBACK_DAYS;
  return normalizeInteger(raw, DEFAULT_BATCH_EXPIRED_LOOKBACK_DAYS, 1, MAX_BATCH_EXPIRED_LOOKBACK_DAYS);
}

function resolveNotificationLookbackDays(environment) {
  const raw = process.env.APPLE_RECONCILIATION_NOTIFICATION_LOOKBACK_DAYS;
  const defaultMax = environment === 'sandbox'
    ? SANDBOX_NOTIFICATION_MAX_LOOKBACK_DAYS
    : PRODUCTION_NOTIFICATION_MAX_LOOKBACK_DAYS;

  return normalizeInteger(raw, DEFAULT_NOTIFICATION_LOOKBACK_DAYS, 1, defaultMax);
}

function subtractDays(dateValue, days) {
  return new Date(dateValue.getTime() - (days * 24 * 60 * 60 * 1000));
}

function mapStatusToNormalized(status) {
  if (status === 1 || status === '1') {
    return 'active';
  }
  if (status === 2 || status === '2') {
    return 'expired';
  }
  if (status === 3 || status === '3') {
    return 'billing_retry';
  }
  if (status === 4 || status === '4') {
    return 'grace_period';
  }
  if (status === 5 || status === '5') {
    return 'revoked';
  }
  return null;
}

function mapTransactionToBaseStatus(verifiedTransaction, now) {
  if (!verifiedTransaction) {
    return null;
  }

  if (verifiedTransaction.revocationDate) {
    return 'revoked';
  }

  if (verifiedTransaction.expiresDate && verifiedTransaction.expiresDate.getTime() <= now.getTime()) {
    return 'expired';
  }

  if (verifiedTransaction.expiresDate && verifiedTransaction.expiresDate.getTime() > now.getTime()) {
    if (verifiedTransaction.offerDiscountType === 'FREE_TRIAL') {
      return 'trialing';
    }
    return 'active';
  }

  return null;
}

function mapRenewalAutoRenewStatus(autoRenewStatus) {
  if (autoRenewStatus === 1 || autoRenewStatus === '1') {
    return true;
  }
  if (autoRenewStatus === 0 || autoRenewStatus === '0') {
    return false;
  }
  return null;
}

function normalizeVerifiedTransaction(decodedTransaction, expectedEnvironment) {
  if (!decodedTransaction || typeof decodedTransaction !== 'object') {
    return null;
  }

  const environment = normalizeAppleEnvironment(decodedTransaction.environment);
  if (!environment || environment !== expectedEnvironment) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_VERIFICATION_FAILED', 'Transaction environment mismatch', {
      retryable: false,
    });
  }

  const transactionId = typeof decodedTransaction.transactionId === 'string'
    ? decodedTransaction.transactionId.trim()
    : '';
  const originalTransactionId = typeof decodedTransaction.originalTransactionId === 'string'
    ? decodedTransaction.originalTransactionId.trim()
    : '';
  const productId = typeof decodedTransaction.productId === 'string'
    ? decodedTransaction.productId.trim()
    : '';

  if (!transactionId || !originalTransactionId || !productId) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_VERIFICATION_FAILED', 'Transaction identifiers are invalid', {
      retryable: false,
    });
  }

  return {
    environment,
    transactionId,
    originalTransactionId,
    productId,
    purchaseDate: toDateFromMillis(decodedTransaction.purchaseDate),
    originalPurchaseDate: toDateFromMillis(decodedTransaction.originalPurchaseDate),
    expiresDate: toDateFromMillis(decodedTransaction.expiresDate),
    revocationDate: toDateFromMillis(decodedTransaction.revocationDate),
    signedDate: toDateFromMillis(decodedTransaction.signedDate),
    offerDiscountType: typeof decodedTransaction.offerDiscountType === 'string' ? decodedTransaction.offerDiscountType : null,
    subscriptionGroupIdentifier: typeof decodedTransaction.subscriptionGroupIdentifier === 'string'
      ? decodedTransaction.subscriptionGroupIdentifier.trim() || null
      : null,
    appAccountToken: typeof decodedTransaction.appAccountToken === 'string'
      ? decodedTransaction.appAccountToken.trim().toLowerCase()
      : null,
  };
}

function normalizeVerifiedRenewal(decodedRenewal, expectedEnvironment) {
  if (!decodedRenewal || typeof decodedRenewal !== 'object') {
    return null;
  }

  const environment = normalizeAppleEnvironment(decodedRenewal.environment);
  if (!environment || environment !== expectedEnvironment) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_VERIFICATION_FAILED', 'Renewal environment mismatch', {
      retryable: false,
    });
  }

  const originalTransactionId = typeof decodedRenewal.originalTransactionId === 'string'
    ? decodedRenewal.originalTransactionId.trim()
    : '';
  if (!originalTransactionId) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_VERIFICATION_FAILED', 'Renewal originalTransactionId is invalid', {
      retryable: false,
    });
  }

  return {
    environment,
    originalTransactionId,
    productId: typeof decodedRenewal.productId === 'string' ? decodedRenewal.productId.trim() : null,
    autoRenewProductId: typeof decodedRenewal.autoRenewProductId === 'string' ? decodedRenewal.autoRenewProductId.trim() : null,
    signedDate: toDateFromMillis(decodedRenewal.signedDate),
    gracePeriodExpiresDate: toDateFromMillis(decodedRenewal.gracePeriodExpiresDate),
    renewalDate: toDateFromMillis(decodedRenewal.renewalDate),
    recentSubscriptionStartDate: toDateFromMillis(decodedRenewal.recentSubscriptionStartDate),
    isInBillingRetryPeriod: typeof decodedRenewal.isInBillingRetryPeriod === 'boolean'
      ? decodedRenewal.isInBillingRetryPeriod
      : null,
    autoRenewEnabled: mapRenewalAutoRenewStatus(decodedRenewal.autoRenewStatus),
    expirationIntent: typeof decodedRenewal.expirationIntent === 'number'
      ? decodedRenewal.expirationIntent
      : null,
  };
}

function toSafeCode(value, fallback = 'APPLE_RECONCILIATION_API_FAILED') {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim();
  return normalized || fallback;
}

function mapApiErrorToFailure(appleLib, error) {
  const APIException = appleLib && appleLib.APIException;
  const APIError = appleLib && appleLib.APIError;

  const looksLikeApiException = Boolean(
    error
    && (
      (APIException && error instanceof APIException)
      || (Object.prototype.hasOwnProperty.call(error, 'httpStatusCode')
        && Object.prototype.hasOwnProperty.call(error, 'apiError'))
    )
  );

  if (!looksLikeApiException) {
    if (error instanceof AppleAppStoreServerClientConfigurationError) {
      return {
        code: 'APPLE_RECONCILIATION_CONFIG_INVALID',
        retryable: false,
      };
    }

    return {
      code: 'APPLE_RECONCILIATION_API_FAILED',
      retryable: true,
    };
  }

  const apiError = Number(error.apiError);
  const retryableApiErrors = new Set([
    APIError ? Number(APIError.RATE_LIMIT_EXCEEDED) : 4290000,
    APIError ? Number(APIError.GENERAL_INTERNAL_RETRYABLE) : 5000001,
    APIError ? Number(APIError.ACCOUNT_NOT_FOUND_RETRYABLE) : 4040002,
    APIError ? Number(APIError.APP_NOT_FOUND_RETRYABLE) : 4040004,
    APIError ? Number(APIError.ORIGINAL_TRANSACTION_ID_NOT_FOUND_RETRYABLE) : 4040006,
  ]);

  if (retryableApiErrors.has(apiError)) {
    return {
      code: 'APPLE_RECONCILIATION_API_RETRYABLE',
      retryable: true,
    };
  }

  if (
    apiError === (APIError ? Number(APIError.ORIGINAL_TRANSACTION_ID_NOT_FOUND) : 4040005)
    || apiError === (APIError ? Number(APIError.TRANSACTION_ID_NOT_FOUND) : 4040010)
    || apiError === (APIError ? Number(APIError.ACCOUNT_NOT_FOUND) : 4040001)
  ) {
    return {
      code: 'APPLE_RECONCILIATION_SUBSCRIPTION_NOT_FOUND',
      retryable: false,
    };
  }

  if (Number(error.httpStatusCode) >= 500) {
    return {
      code: 'APPLE_RECONCILIATION_API_RETRYABLE',
      retryable: true,
    };
  }

  return {
    code: 'APPLE_RECONCILIATION_API_FAILED',
    retryable: false,
  };
}

async function callAppleApi({ appleLib, operation }) {
  try {
    return await operation();
  } catch (error) {
    const mapped = mapApiErrorToFailure(appleLib, error);
    throw new AppleReconciliationError(mapped.code, 'Apple API reconciliation call failed', {
      retryable: mapped.retryable,
    });
  }
}

function parseProductPlanOrThrow(productId) {
  const productConfig = getAppleProductConfiguration();
  const configValidation = validateAppleProductConfiguration(productConfig, { requireConfigured: true });
  if (!configValidation.isValid) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_PRODUCT_CONFIG_INVALID', 'Apple product configuration is invalid', {
      retryable: false,
    });
  }

  const mappedPlan = getAppleProductPlan(productId, productConfig);
  if (!mappedPlan) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_PRODUCT_NOT_ALLOWED', 'Apple product is not allowed', {
      retryable: false,
    });
  }

  return mappedPlan;
}

function buildEntitlementCandidate({
  entitlement,
  statusItem,
  verifiedTransaction,
  verifiedRenewal,
  now,
  providerStateVersion,
}) {
  const statusFromTransaction = mapTransactionToBaseStatus(verifiedTransaction, now);
  const statusFromApi = mapStatusToNormalized(statusItem && statusItem.status);
  const normalizedStatus = statusFromTransaction || statusFromApi || entitlement.normalizedStatus;

  const providerProductId = verifiedTransaction
    ? verifiedTransaction.productId
    : entitlement.providerProductId;
  const plan = parseProductPlanOrThrow(providerProductId);

  const providerEventTime = (verifiedTransaction && (verifiedTransaction.signedDate || verifiedTransaction.expiresDate || verifiedTransaction.purchaseDate))
    || (verifiedRenewal && (verifiedRenewal.signedDate || verifiedRenewal.renewalDate))
    || entitlement.providerEventTime
    || null;

  const candidate = {
    studioId: entitlement.studioId,
    provider: entitlement.provider,
    plan,
    normalizedStatus,
    providerProductId,
    providerSubscriptionId: entitlement.providerSubscriptionId,
    currentPeriodStart: verifiedTransaction ? verifiedTransaction.purchaseDate : entitlement.currentPeriodStart,
    currentPeriodEnd: verifiedTransaction ? verifiedTransaction.expiresDate : entitlement.currentPeriodEnd,
    trialEndsAt: verifiedTransaction && verifiedTransaction.offerDiscountType === 'FREE_TRIAL'
      ? verifiedTransaction.expiresDate
      : null,
    autoRenewEnabled: verifiedRenewal && verifiedRenewal.autoRenewEnabled !== null
      ? verifiedRenewal.autoRenewEnabled
      : entitlement.autoRenewEnabled,
    gracePeriodEndsAt: verifiedRenewal && verifiedRenewal.gracePeriodExpiresDate
      ? verifiedRenewal.gracePeriodExpiresDate
      : entitlement.gracePeriodEndsAt,
    revokedAt: normalizedStatus === 'revoked'
      ? ((verifiedTransaction && verifiedTransaction.revocationDate) || providerEventTime || entitlement.revokedAt)
      : null,
    refundedAt: entitlement.refundedAt,
    pausedAt: entitlement.pausedAt,
    lastVerifiedAt: now,
    sourceLastUpdate: 'reconciliation',
    environment: entitlement.environment,
    providerStateVersion: providerStateVersion || entitlement.providerStateVersion,
    providerEventTime,
  };

  return candidate;
}

async function upsertTransactionLedger({
  entitlement,
  verifiedTransaction,
  signedTransactionInfo,
  signedRenewalInfo,
  now,
  transaction,
}) {
  const environment = toLedgerEnvironmentName(entitlement.environment);

  let row = await AppleSubscriptionTransaction.findOne({
    where: {
      environment,
      transactionId: verifiedTransaction.transactionId,
    },
    transaction,
  });

  if (row && row.studioId !== entitlement.studioId) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_TRANSACTION_CONFLICT', 'Transaction already belongs to another studio', {
      retryable: false,
    });
  }

  if (!row) {
    try {
      row = await AppleSubscriptionTransaction.create({
        studioId: entitlement.studioId,
        environment,
        originalTransactionId: verifiedTransaction.originalTransactionId,
        transactionId: verifiedTransaction.transactionId,
        productId: verifiedTransaction.productId,
        subscriptionGroupIdentifier: verifiedTransaction.subscriptionGroupIdentifier,
        purchaseDate: verifiedTransaction.purchaseDate,
        originalPurchaseDate: verifiedTransaction.originalPurchaseDate,
        expiresDate: verifiedTransaction.expiresDate,
        revocationDate: verifiedTransaction.revocationDate,
        autoRenewStatus: null,
        signedTransactionInfo,
        signedRenewalInfo: signedRenewalInfo || null,
        appAccountToken: verifiedTransaction.appAccountToken,
        notificationType: 'RECONCILIATION_HISTORY',
        notificationSubtype: null,
        providerEventTime: verifiedTransaction.signedDate || verifiedTransaction.expiresDate || verifiedTransaction.purchaseDate,
        ingestedAt: now,
      }, { transaction });
    } catch (error) {
      row = await AppleSubscriptionTransaction.findOne({
        where: {
          environment,
          transactionId: verifiedTransaction.transactionId,
        },
        transaction,
      });

      if (!row) {
        throw new AppleReconciliationError('APPLE_RECONCILIATION_LEDGER_WRITE_FAILED', 'Ledger write failed', {
          retryable: true,
        });
      }

      if (row.studioId !== entitlement.studioId) {
        throw new AppleReconciliationError('APPLE_RECONCILIATION_TRANSACTION_CONFLICT', 'Transaction already belongs to another studio', {
          retryable: false,
        });
      }
    }
  } else {
    row.originalTransactionId = verifiedTransaction.originalTransactionId;
    row.productId = verifiedTransaction.productId;
    row.subscriptionGroupIdentifier = verifiedTransaction.subscriptionGroupIdentifier;
    row.purchaseDate = verifiedTransaction.purchaseDate;
    row.originalPurchaseDate = verifiedTransaction.originalPurchaseDate;
    row.expiresDate = verifiedTransaction.expiresDate;
    row.revocationDate = verifiedTransaction.revocationDate;
    row.appAccountToken = verifiedTransaction.appAccountToken;
    row.providerEventTime = verifiedTransaction.signedDate || verifiedTransaction.expiresDate || verifiedTransaction.purchaseDate;

    if (typeof signedTransactionInfo === 'string' && signedTransactionInfo.trim() !== '') {
      row.signedTransactionInfo = signedTransactionInfo;
    }

    if (typeof signedRenewalInfo === 'string' && signedRenewalInfo.trim() !== '') {
      row.signedRenewalInfo = signedRenewalInfo;
    }

    await row.save({ transaction });
  }

  return row;
}

async function decodeStatusRows({ entitlement, statusResponse, verifyTransactionFn, verifyRenewalFn }) {
  const verifyTransaction = typeof verifyTransactionFn === 'function'
    ? verifyTransactionFn
    : verifyAndDecodeTransaction;
  const verifyRenewal = typeof verifyRenewalFn === 'function'
    ? verifyRenewalFn
    : verifyAndDecodeRenewalInfo;
  const rows = [];
  const groups = Array.isArray(statusResponse && statusResponse.data) ? statusResponse.data : [];
  const verifierEnvironment = normalizeVerifierEnvironmentFromEntitlement(entitlement.environment);

  for (const group of groups) {
    const lastTransactions = Array.isArray(group && group.lastTransactions) ? group.lastTransactions : [];

    for (const item of lastTransactions) {
      const signedTransactionInfo = typeof item.signedTransactionInfo === 'string'
        ? item.signedTransactionInfo.trim()
        : '';
      if (!signedTransactionInfo) {
        continue;
      }

      const decodedTransaction = await verifyTransaction(signedTransactionInfo, {
        environment: verifierEnvironment,
        environmentsAllowed: [verifierEnvironment],
      });
      const verifiedTransaction = normalizeVerifiedTransaction(decodedTransaction, entitlement.environment);

      if (verifiedTransaction.originalTransactionId !== entitlement.providerSubscriptionId) {
        continue;
      }

      let verifiedRenewal = null;
      const signedRenewalInfo = typeof item.signedRenewalInfo === 'string'
        ? item.signedRenewalInfo.trim()
        : '';
      if (signedRenewalInfo) {
          const decodedRenewal = await verifyRenewal(signedRenewalInfo, {
          environment: verifierEnvironment,
          environmentsAllowed: [verifierEnvironment],
        });
        verifiedRenewal = normalizeVerifiedRenewal(decodedRenewal, entitlement.environment);
        if (verifiedRenewal.originalTransactionId !== entitlement.providerSubscriptionId) {
          continue;
        }
      }

      const rankingDate = (verifiedTransaction.signedDate
        || verifiedTransaction.expiresDate
        || verifiedTransaction.purchaseDate
        || (verifiedRenewal && (verifiedRenewal.signedDate || verifiedRenewal.renewalDate))
        || null);

      rows.push({
        statusItem: item,
        signedTransactionInfo,
        signedRenewalInfo: signedRenewalInfo || null,
        verifiedTransaction,
        verifiedRenewal,
        rankingTime: rankingDate ? rankingDate.getTime() : Number.MIN_SAFE_INTEGER,
      });
    }
  }

  rows.sort((a, b) => b.rankingTime - a.rankingTime);
  return rows;
}

async function repairLedgerFromHistory({
  entitlement,
  client,
  appleLib,
  maxPages,
  maxTransactions,
  now,
  transaction,
  verifyTransactionFn,
}) {
  const pageLimit = normalizeInteger(maxPages, DEFAULT_HISTORY_PAGE_LIMIT, 1, MAX_HISTORY_PAGE_LIMIT);
  const transactionLimit = normalizeInteger(maxTransactions, DEFAULT_HISTORY_TRANSACTION_LIMIT, 1, MAX_HISTORY_TRANSACTION_LIMIT);
  let pages = 0;
  let revision = null;
  let hasMore = true;
  let upsertedCount = 0;
  let processedTransactionCount = 0;
  let lastRevision = null;
  const verifierEnvironment = normalizeVerifierEnvironmentFromEntitlement(entitlement.environment);

  while (hasMore && pages < pageLimit) {
    const historyResponse = await callAppleApi({
      appleLib,
      operation: () => client.getTransactionHistory(
        entitlement.providerSubscriptionId,
        revision,
        {
          productTypes: [appleLib.ProductType.AUTO_RENEWABLE],
          sort: appleLib.Order.DESCENDING,
        },
        appleLib.GetTransactionHistoryVersion.V2
      ),
    });

    lastRevision = typeof historyResponse.revision === 'string' ? historyResponse.revision : lastRevision;
    const signedTransactions = Array.isArray(historyResponse.signedTransactions) ? historyResponse.signedTransactions : [];

    for (const signedTransactionInfo of signedTransactions) {
      if (typeof signedTransactionInfo !== 'string' || signedTransactionInfo.trim() === '') {
        continue;
      }

      const decodeTx = typeof verifyTransactionFn === 'function' ? verifyTransactionFn : verifyAndDecodeTransaction;
      const decodedTransaction = await decodeTx(signedTransactionInfo, {
        environment: verifierEnvironment,
        environmentsAllowed: [verifierEnvironment],
      });
      const verifiedTransaction = normalizeVerifiedTransaction(decodedTransaction, entitlement.environment);

      if (verifiedTransaction.originalTransactionId !== entitlement.providerSubscriptionId) {
        continue;
      }

      await upsertTransactionLedger({
        entitlement,
        verifiedTransaction,
        signedTransactionInfo,
        signedRenewalInfo: null,
        now,
        transaction,
      });
      upsertedCount += 1;
      processedTransactionCount += 1;

      if (processedTransactionCount >= transactionLimit) {
        hasMore = false;
        break;
      }
    }

    const nextHasMore = Boolean(historyResponse.hasMore);
    const nextRevision = nextHasMore ? (historyResponse.revision || null) : null;
    if (nextHasMore && !nextRevision) {
      throw new AppleReconciliationError('APPLE_RECONCILIATION_HISTORY_PAGINATION_INVALID', 'History pagination response is invalid', {
        retryable: true,
      });
    }

    if (nextHasMore && revision && nextRevision === revision) {
      throw new AppleReconciliationError('APPLE_RECONCILIATION_HISTORY_PAGINATION_STALLED', 'History pagination stalled', {
        retryable: true,
      });
    }

    hasMore = nextHasMore;
    revision = nextRevision;
    pages += 1;
  }

  return {
    pages,
    upsertedCount,
    revision: lastRevision,
    truncated: hasMore,
  };
}

async function reconcileAppleEntitlementById({
  entitlementId,
  dryRun = false,
  repairLedger = true,
  historyMaxPages = DEFAULT_HISTORY_PAGE_LIMIT,
  historyMaxTransactions = DEFAULT_HISTORY_TRANSACTION_LIMIT,
  now = new Date(),
  dependencies = {},
}) {
  if (!Number.isInteger(entitlementId) || entitlementId <= 0) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_INVALID_REQUEST', 'entitlementId must be a positive integer', {
      retryable: false,
    });
  }

  const entitlement = await StudioSubscriptionEntitlement.findOne({
    where: {
      id: entitlementId,
      provider: 'apple',
    },
  });

  if (!entitlement) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_ENTITLEMENT_NOT_FOUND', 'Apple entitlement not found', {
      retryable: false,
    });
  }

  const providerSubscriptionId = typeof entitlement.providerSubscriptionId === 'string'
    ? entitlement.providerSubscriptionId.trim()
    : '';
  if (!providerSubscriptionId) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_BINDING_INVALID', 'Entitlement has no provider subscription binding', {
      retryable: false,
    });
  }

  const clientBundle = dependencies.clientBundle || getAppleAppStoreServerApiClient();
  const client = dependencies.client || clientBundle.client;
  const appleLib = dependencies.appleLib || clientBundle.appleLib;

  const statusResponse = await callAppleApi({
    appleLib,
    operation: () => client.getAllSubscriptionStatuses(providerSubscriptionId),
  });

  const decodedRows = await decodeStatusRows({
    entitlement,
    statusResponse,
    verifyTransactionFn: dependencies.verifyTransactionFn,
    verifyRenewalFn: dependencies.verifyRenewalFn,
  });

  const selected = decodedRows.length > 0 ? decodedRows[0] : null;

  if (!selected) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_NO_VERIFIED_STATUS', 'No verified status rows were available', {
      retryable: false,
    });
  }

  const candidate = buildEntitlementCandidate({
    entitlement,
    statusItem: selected.statusItem,
    verifiedTransaction: selected.verifiedTransaction,
    verifiedRenewal: selected.verifiedRenewal,
    now,
    providerStateVersion: null,
  });

  if (dryRun) {
    return {
      entitlementId: entitlement.id,
      studioId: entitlement.studioId,
      providerSubscriptionId,
      dryRun: true,
      wouldApply: shouldApplyEntitlementUpdate(entitlement, candidate),
      candidate,
      decodedStatusRows: decodedRows.length,
      ledgerRepair: {
        attempted: Boolean(repairLedger),
        skippedByDryRun: true,
      },
    };
  }

  return sequelize.transaction(async (transaction) => {
    const entitlementForUpdate = await StudioSubscriptionEntitlement.findByPk(entitlement.id, { transaction });
    if (!entitlementForUpdate) {
      throw new AppleReconciliationError('APPLE_RECONCILIATION_ENTITLEMENT_NOT_FOUND', 'Apple entitlement not found', {
        retryable: false,
      });
    }

    let ledgerRepairSummary = {
      attempted: false,
      pages: 0,
      upsertedCount: 0,
      revision: null,
      truncated: false,
    };

    if (repairLedger) {
      const repair = await repairLedgerFromHistory({
        entitlement: entitlementForUpdate,
        client,
        appleLib,
        maxPages: historyMaxPages,
        maxTransactions: historyMaxTransactions,
        now,
        transaction,
        verifyTransactionFn: dependencies.verifyTransactionFn,
      });

      ledgerRepairSummary = {
        attempted: true,
        pages: repair.pages,
        upsertedCount: repair.upsertedCount,
        revision: repair.revision,
        truncated: repair.truncated,
      };

      if (typeof repair.revision === 'string' && repair.revision.trim() !== '') {
        candidate.providerStateVersion = repair.revision;
      }
    }

    let applied = false;
    if (shouldApplyEntitlementUpdate(entitlementForUpdate, candidate)) {
      entitlementForUpdate.set(candidate);
      await entitlementForUpdate.save({ transaction });
      applied = true;
    }

    return {
      entitlementId: entitlementForUpdate.id,
      studioId: entitlementForUpdate.studioId,
      providerSubscriptionId,
      dryRun: false,
      applied,
      candidate,
      decodedStatusRows: decodedRows.length,
      ledgerRepair: ledgerRepairSummary,
    };
  });
}

async function recoverAppleNotificationHistoryForEntitlement({
  entitlementId,
  startDate,
  endDate,
  maxPages = DEFAULT_NOTIFICATION_PAGE_LIMIT,
  maxNotifications = DEFAULT_NOTIFICATION_COUNT_LIMIT,
  onlyFailures = false,
  now = new Date(),
  dependencies = {},
}) {
  if (!Number.isInteger(entitlementId) || entitlementId <= 0) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_INVALID_REQUEST', 'entitlementId must be a positive integer', {
      retryable: false,
    });
  }

  const entitlement = await StudioSubscriptionEntitlement.findOne({
    where: {
      id: entitlementId,
      provider: 'apple',
    },
  });

  if (!entitlement || !entitlement.providerSubscriptionId) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_ENTITLEMENT_NOT_FOUND', 'Apple entitlement not found', {
      retryable: false,
    });
  }

  const clientBundle = dependencies.clientBundle || getAppleAppStoreServerApiClient();
  const client = dependencies.client || clientBundle.client;
  const appleLib = dependencies.appleLib || clientBundle.appleLib;
  const ingestSignedPayloadFn = typeof dependencies.ingestSignedPayloadFn === 'function'
    ? dependencies.ingestSignedPayloadFn
    : ingestAppleSignedPayload;

  const defaultLookbackDays = resolveNotificationLookbackDays(entitlement.environment);
  const start = startDate instanceof Date ? startDate : subtractDays(now, defaultLookbackDays);
  const end = endDate instanceof Date ? endDate : now;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_INVALID_REQUEST', 'Notification history date range is invalid', {
      retryable: false,
    });
  }

  const pageLimit = normalizeInteger(maxPages, DEFAULT_NOTIFICATION_PAGE_LIMIT, 1, MAX_NOTIFICATION_PAGE_LIMIT);
  const notificationLimit = normalizeInteger(maxNotifications, DEFAULT_NOTIFICATION_COUNT_LIMIT, 1, MAX_NOTIFICATION_COUNT_LIMIT);
  const maxLookbackDays = entitlement.environment === 'sandbox'
    ? SANDBOX_NOTIFICATION_MAX_LOOKBACK_DAYS
    : PRODUCTION_NOTIFICATION_MAX_LOOKBACK_DAYS;
  const earliestAllowed = subtractDays(end, maxLookbackDays);

  if (start.getTime() < earliestAllowed.getTime()) {
    throw new AppleReconciliationError('APPLE_RECONCILIATION_NOTIFICATION_LOOKBACK_TOO_OLD', 'Notification history lookback exceeds allowed window', {
      retryable: false,
    });
  }

  let pages = 0;
  let paginationToken = null;
  let hasMore = true;
  let processedCount = 0;
  let ingestedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  while (hasMore && pages < pageLimit) {
    const response = await callAppleApi({
      appleLib,
      operation: () => client.getNotificationHistory(paginationToken, {
        startDate: start.getTime(),
        endDate: end.getTime(),
        transactionId: entitlement.providerSubscriptionId,
        onlyFailures: Boolean(onlyFailures),
      }),
    });

    const items = Array.isArray(response.notificationHistory) ? response.notificationHistory : [];
    for (const item of items) {
      const signedPayload = typeof item.signedPayload === 'string' ? item.signedPayload.trim() : '';
      if (!signedPayload) {
        skippedCount += 1;
        processedCount += 1;
        if (processedCount >= notificationLimit) {
          hasMore = false;
          break;
        }
        continue;
      }

      try {
        await ingestSignedPayloadFn({
          signedPayload,
          now,
          dependencies,
        });
        ingestedCount += 1;
      } catch (error) {
        failedCount += 1;
      }

      processedCount += 1;
      if (processedCount >= notificationLimit) {
        hasMore = false;
        break;
      }
    }

    const nextHasMore = Boolean(response.hasMore);
    const nextToken = nextHasMore ? (response.paginationToken || null) : null;
    if (nextHasMore && !nextToken) {
      throw new AppleReconciliationError('APPLE_RECONCILIATION_NOTIFICATION_PAGINATION_INVALID', 'Notification pagination response is invalid', {
        retryable: true,
      });
    }

    if (nextHasMore && paginationToken && nextToken === paginationToken) {
      throw new AppleReconciliationError('APPLE_RECONCILIATION_NOTIFICATION_PAGINATION_STALLED', 'Notification pagination stalled', {
        retryable: true,
      });
    }

    hasMore = nextHasMore && processedCount < notificationLimit;
    paginationToken = hasMore ? nextToken : null;
    pages += 1;
  }

  return {
    entitlementId: entitlement.id,
    pages,
    ingestedCount,
    failedCount,
    skippedCount,
    truncated: hasMore,
  };
}

async function retryDueFailedAppleNotificationInbox({
  limit = DEFAULT_RETRY_LIMIT,
  now = new Date(),
  dependencies = {},
}) {
  const boundedLimit = normalizeInteger(limit, DEFAULT_RETRY_LIMIT, 1, MAX_RETRY_LIMIT);
  const maxAttempts = parseNotificationMaxAttempts();
  const ingestSignedPayloadFn = typeof dependencies.ingestSignedPayloadFn === 'function'
    ? dependencies.ingestSignedPayloadFn
    : ingestAppleSignedPayload;

  const dueRows = await AppleServerNotificationInbox.findAll({
    where: {
      processingState: 'failed',
      attemptCount: {
        [Op.lt]: maxAttempts,
      },
      signedPayload: {
        [Op.not]: null,
      },
      nextAttemptAt: {
        [Op.lte]: now,
      },
    },
    order: [['nextAttemptAt', 'ASC'], ['id', 'ASC']],
    limit: boundedLimit,
  });

  const results = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of dueRows) {
    const signedPayload = typeof row.signedPayload === 'string' ? row.signedPayload.trim() : '';
    if (!signedPayload) {
      results.skipped += 1;
      continue;
    }

    results.attempted += 1;
    try {
      await ingestSignedPayloadFn({
        signedPayload,
        now,
        dependencies,
      });
      results.succeeded += 1;
    } catch (error) {
      results.failed += 1;
      row.lastError = toSafeCode(error && error.code, 'APPLE_RECONCILIATION_RETRY_FAILED');
      await row.save({ fields: ['lastError'] });
    }
  }

  return results;
}

async function reconcileAppleEntitlementsBatch({
  limit = DEFAULT_BATCH_LIMIT,
  dryRun = false,
  repairLedger = true,
  historyMaxPages = DEFAULT_HISTORY_PAGE_LIMIT,
  historyMaxTransactions = DEFAULT_HISTORY_TRANSACTION_LIMIT,
  now = new Date(),
  dependencies = {},
}) {
  const boundedLimit = normalizeInteger(limit, DEFAULT_BATCH_LIMIT, 1, MAX_BATCH_LIMIT);
  const lookbackDays = resolveBatchExpiredLookbackDays();
  const cutoffDate = subtractDays(now, lookbackDays);

  const entitlements = await StudioSubscriptionEntitlement.findAll({
    where: {
      provider: 'apple',
      providerSubscriptionId: {
        [Op.not]: null,
      },
      [Op.or]: [
        {
          normalizedStatus: {
            [Op.in]: ['trialing', 'active', 'grace_period', 'billing_retry', 'paused'],
          },
        },
        {
          normalizedStatus: 'expired',
          currentPeriodEnd: {
            [Op.gte]: cutoffDate,
          },
        },
      ],
    },
    order: [['lastVerifiedAt', 'ASC'], ['id', 'ASC']],
    limit: boundedLimit,
  });

  const summary = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    results: [],
  };

  for (const entitlement of entitlements) {
    summary.attempted += 1;
    try {
      const result = await reconcileAppleEntitlementById({
        entitlementId: entitlement.id,
        dryRun,
        repairLedger,
        historyMaxPages,
        historyMaxTransactions,
        now,
        dependencies,
      });
      summary.succeeded += 1;
      summary.results.push(result);
    } catch (error) {
      summary.failed += 1;
      summary.results.push({
        entitlementId: entitlement.id,
        errorCode: toSafeCode(error && error.code),
        retryable: Boolean(error && error.retryable),
      });
    }
  }

  return summary;
}

module.exports = {
  AppleReconciliationError,
  reconcileAppleEntitlementById,
  reconcileAppleEntitlementsBatch,
  recoverAppleNotificationHistoryForEntitlement,
  retryDueFailedAppleNotificationInbox,
};
