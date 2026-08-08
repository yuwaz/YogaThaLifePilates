const {
  sequelize,
  AppleServerNotificationInbox,
  AppleSubscriptionTransaction,
  StudioSubscriptionEntitlement,
} = require('../models');
const {
  getAppleProductConfiguration,
  getAppleProductPlan,
  validateAppleProductConfiguration,
} = require('../models/appleSubscriptionMetadata');
const {
  verifyAndDecodeNotification,
  verifyAndDecodeTransaction,
  verifyAndDecodeRenewalInfo,
  AppleVerifierConfigurationError,
  AppleVerifierError,
} = require('./appleSignedDataVerifier');
const {
  normalizeAppleEnvironment,
} = require('./appleSubscriptionService');
const {
  shouldApplyEntitlementUpdate,
} = require('./applePurchaseVerificationService');

const APPLE_NOTIFICATION_PROCESSING_STATES = Object.freeze({
  pending: 'pending',
  processed: 'processed',
  failed: 'failed',
});

const SUPPORTED_LIFECYCLE_TYPES = new Set([
  'SUBSCRIBED',
  'DID_RENEW',
  'DID_CHANGE_RENEWAL_STATUS',
  'DID_CHANGE_RENEWAL_PREF',
  'DID_FAIL_TO_RENEW',
  'GRACE_PERIOD_EXPIRED',
  'EXPIRED',
  'REFUND',
  'REFUND_REVERSED',
  'REVOKE',
  'RENEWAL_EXTENDED',
  'OFFER_REDEEMED',
]);

const SAFE_NOOP_TYPES = new Set([
  'TEST',
  'CONSUMPTION_REQUEST',
  'ONE_TIME_CHARGE',
  'EXTERNAL_PURCHASE_TOKEN',
  'RESCIND_CONSENT',
  'PRICE_INCREASE',
  'REFUND_DECLINED',
  'METADATA_UPDATE',
  'MIGRATION',
  'PRICE_CHANGE',
  'RENEWAL_EXTENSION',
]);

const MUTATING_TYPES = new Set([
  'SUBSCRIBED',
  'DID_RENEW',
  'DID_CHANGE_RENEWAL_STATUS',
  'DID_CHANGE_RENEWAL_PREF',
  'DID_FAIL_TO_RENEW',
  'GRACE_PERIOD_EXPIRED',
  'EXPIRED',
  'REFUND',
  'REFUND_REVERSED',
  'REVOKE',
  'RENEWAL_EXTENDED',
  'OFFER_REDEEMED',
]);

const MAX_SIGNED_PAYLOAD_LENGTH = 32768;
const MAX_LAST_ERROR_LENGTH = 128;

class AppleNotificationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppleNotificationError';
    this.code = code;
    this.httpStatus = Number.isInteger(options.httpStatus) ? options.httpStatus : 400;
    this.retryable = Boolean(options.retryable);
    this.publicCode = options.publicCode || code;
  }
}

function isCompactJws(value) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
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

function toSafeErrorToken(code) {
  const normalized = typeof code === 'string' ? code.trim() : 'APPLE_NOTIFICATION_PROCESSING_FAILED';
  const limited = normalized.length > MAX_LAST_ERROR_LENGTH
    ? normalized.slice(0, MAX_LAST_ERROR_LENGTH)
    : normalized;
  return limited || 'APPLE_NOTIFICATION_PROCESSING_FAILED';
}

function normalizeAllowedEnvironmentValue(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'sandbox') {
    return 'sandbox';
  }
  if (normalized === 'production') {
    return 'production';
  }
  return null;
}

function parseAllowedEnvironments() {
  const raw = process.env.APPLE_IAP_ENVIRONMENTS_ALLOWED;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return ['production', 'sandbox'];
  }

  const allowedSet = new Set(
    raw
      .split(',')
      .map((item) => normalizeAllowedEnvironmentValue(item))
      .filter(Boolean)
  );

  if (allowedSet.size === 0) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_ENVIRONMENT_NOT_ALLOWED', 'No supported Apple environments are configured', {
      httpStatus: 500,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }

  const ordered = [];
  if (allowedSet.has('production')) ordered.push('production');
  if (allowedSet.has('sandbox')) ordered.push('sandbox');
  return ordered;
}

function toVerifierEnvironmentName(environment) {
  return environment === 'production' ? 'Production' : 'Sandbox';
}

function toLedgerEnvironmentName(environment) {
  return toVerifierEnvironmentName(environment);
}

function validateNotificationRequest(req) {
  const isJson = req && typeof req.is === 'function' ? req.is('application/json') : false;
  if (!isJson) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_INVALID_REQUEST', 'Content-Type must be application/json', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_INVALID_REQUEST',
    });
  }

  const body = req && req.body && typeof req.body === 'object' ? req.body : null;
  const signedPayload = body ? body.signedPayload : undefined;

  if (typeof signedPayload !== 'string') {
    throw new AppleNotificationError('APPLE_NOTIFICATION_INVALID_REQUEST', 'signedPayload must be a string', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_INVALID_REQUEST',
    });
  }

  const normalized = signedPayload.trim();
  if (!normalized) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_INVALID_REQUEST', 'signedPayload is required', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_INVALID_REQUEST',
    });
  }

  if (normalized.length > MAX_SIGNED_PAYLOAD_LENGTH) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_INVALID_REQUEST', 'signedPayload is too large', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_INVALID_REQUEST',
    });
  }

  if (!isCompactJws(normalized)) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_INVALID_REQUEST', 'signedPayload must be compact JWS', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_INVALID_REQUEST',
    });
  }

  return normalized;
}

function validateSignedPayloadString(signedPayload) {
  if (typeof signedPayload !== 'string') {
    throw new AppleNotificationError('APPLE_NOTIFICATION_INVALID_REQUEST', 'signedPayload must be a string', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_INVALID_REQUEST',
    });
  }

  const normalized = signedPayload.trim();
  if (!normalized) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_INVALID_REQUEST', 'signedPayload is required', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_INVALID_REQUEST',
    });
  }

  if (normalized.length > MAX_SIGNED_PAYLOAD_LENGTH) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_INVALID_REQUEST', 'signedPayload is too large', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_INVALID_REQUEST',
    });
  }

  if (!isCompactJws(normalized)) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_INVALID_REQUEST', 'signedPayload must be compact JWS', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_INVALID_REQUEST',
    });
  }

  return normalized;
}

function mapVerifierError(error) {
  if (error instanceof AppleVerifierConfigurationError) {
    return new AppleNotificationError('APPLE_NOTIFICATION_PROCESSING_FAILED', 'Verifier configuration error', {
      httpStatus: 500,
      retryable: true,
      publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }

  if (error instanceof AppleVerifierError) {
    const code = error.code;
    if (code === 'APPLE_BUNDLE_ID_MISMATCH' || code === 'APPLE_APP_ID_MISMATCH') {
      return new AppleNotificationError('APPLE_NOTIFICATION_APP_MISMATCH', 'Application identity mismatch', {
        httpStatus: 400,
        retryable: false,
        publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
      });
    }
    if (code === 'APPLE_ENVIRONMENT_NOT_ALLOWED') {
      return new AppleNotificationError('APPLE_NOTIFICATION_ENVIRONMENT_NOT_ALLOWED', 'Environment not allowed', {
        httpStatus: 400,
        retryable: false,
        publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
      });
    }

    return new AppleNotificationError('APPLE_NOTIFICATION_VERIFICATION_FAILED', 'Notification verification failed', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
    });
  }

  return new AppleNotificationError('APPLE_NOTIFICATION_PROCESSING_FAILED', 'Notification processing failed', {
    httpStatus: 500,
    retryable: true,
    publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
  });
}

async function verifyOuterNotificationAcrossAllowedEnvironments(signedPayload, dependencies = {}) {
  const allowedEnvironments = parseAllowedEnvironments();
  const verifyNotificationFn = typeof dependencies.verifyNotificationFn === 'function'
    ? dependencies.verifyNotificationFn
    : verifyAndDecodeNotification;
  let lastError = null;

  for (const environment of allowedEnvironments) {
    try {
      const decoded = await verifyNotificationFn(signedPayload, {
        environment: toVerifierEnvironmentName(environment),
        environmentsAllowed: [toVerifierEnvironmentName(environment)],
      });

      return {
        environment,
        decoded,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw mapVerifierError(lastError);
}

function extractVerifiedOuterFields(decodedOuter, verifiedEnvironment) {
  if (!decodedOuter || typeof decodedOuter !== 'object') {
    throw new AppleNotificationError('APPLE_NOTIFICATION_VERIFICATION_FAILED', 'Decoded notification payload is invalid', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
    });
  }

  const notificationUUID = typeof decodedOuter.notificationUUID === 'string'
    ? decodedOuter.notificationUUID.trim()
    : '';
  if (!notificationUUID) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_ID_MISSING', 'notificationUUID is missing', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
    });
  }

  const notificationType = typeof decodedOuter.notificationType === 'string'
    ? decodedOuter.notificationType.trim()
    : '';
  if (!notificationType) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_VERIFICATION_FAILED', 'notificationType is missing', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
    });
  }

  const notificationSubtype = typeof decodedOuter.subtype === 'string'
    ? decodedOuter.subtype.trim() || null
    : null;

  const signedDate = toDateFromMillis(decodedOuter.signedDate);
  if (typeof decodedOuter.signedDate !== 'undefined' && decodedOuter.signedDate !== null && !signedDate) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_VERIFICATION_FAILED', 'signedDate is invalid', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
    });
  }

  const data = decodedOuter.data && typeof decodedOuter.data === 'object' ? decodedOuter.data : null;
  if (data) {
    if (typeof data.environment !== 'undefined' && data.environment !== null) {
      const dataEnvironment = normalizeAppleEnvironment(data.environment);
      if (!dataEnvironment || dataEnvironment !== verifiedEnvironment) {
        throw new AppleNotificationError('APPLE_NOTIFICATION_VERIFICATION_FAILED', 'Notification data environment mismatch', {
          httpStatus: 400,
          retryable: false,
          publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
        });
      }
    }

    const expectedBundleId = String(process.env.APPLE_IAP_BUNDLE_ID || '').trim();
    if (expectedBundleId && typeof data.bundleId === 'string' && data.bundleId.trim() !== expectedBundleId) {
      throw new AppleNotificationError('APPLE_NOTIFICATION_APP_MISMATCH', 'Notification bundle mismatch', {
        httpStatus: 400,
        retryable: false,
        publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
      });
    }

    if (verifiedEnvironment === 'production') {
      const expectedAppAppleIdRaw = process.env.APPLE_IAP_APPLE_APP_ID;
      if (typeof expectedAppAppleIdRaw !== 'undefined' && expectedAppAppleIdRaw !== null && String(expectedAppAppleIdRaw).trim() !== '') {
        const expectedAppAppleId = Number(expectedAppAppleIdRaw);
        if (Number.isInteger(expectedAppAppleId) && typeof data.appAppleId !== 'undefined' && data.appAppleId !== null && Number(data.appAppleId) !== expectedAppAppleId) {
          throw new AppleNotificationError('APPLE_NOTIFICATION_APP_MISMATCH', 'Notification appAppleId mismatch', {
            httpStatus: 400,
            retryable: false,
            publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
          });
        }
      }
    }
  }

  return {
    environment: verifiedEnvironment,
    notificationUUID,
    notificationType,
    notificationSubtype,
    eventTime: signedDate,
    data,
  };
}

function parseRetryConfig() {
  const baseRaw = process.env.APPLE_NOTIFICATION_RETRY_BASE_MINUTES;
  const maxRaw = process.env.APPLE_NOTIFICATION_RETRY_MAX_MINUTES;
  const attemptsRaw = process.env.APPLE_NOTIFICATION_MAX_ATTEMPTS;

  const baseMinutes = Number.isFinite(Number(baseRaw)) ? Number(baseRaw) : 5;
  const maxMinutes = Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : 360;
  const maxAttempts = Number.isFinite(Number(attemptsRaw)) ? Number(attemptsRaw) : 10;

  const safeBase = Math.min(Math.max(Math.floor(baseMinutes), 1), 1440);
  const safeMax = Math.min(Math.max(Math.floor(maxMinutes), safeBase), 10080);
  const safeAttempts = Math.min(Math.max(Math.floor(maxAttempts), 1), 100);

  return {
    baseMinutes: safeBase,
    maxMinutes: safeMax,
    maxAttempts: safeAttempts,
  };
}

function computeNextAttemptAt(now, attemptCount) {
  const retryConfig = parseRetryConfig();
  if (attemptCount >= retryConfig.maxAttempts) {
    return null;
  }

  const multiplier = Math.pow(2, Math.max(attemptCount - 1, 0));
  const delayMinutes = Math.min(retryConfig.baseMinutes * multiplier, retryConfig.maxMinutes);
  return new Date(now.getTime() + delayMinutes * 60 * 1000);
}

async function upsertInboxRecord({
  environment,
  notificationUUID,
  notificationType,
  notificationSubtype,
  signedPayload,
  originalTransactionId,
  transactionId,
  eventTime,
}) {
  const ledgerEnvironment = toLedgerEnvironmentName(environment);

  let inbox = await AppleServerNotificationInbox.findOne({
    where: {
      environment: ledgerEnvironment,
      notificationUUID,
    },
  });

  if (!inbox) {
    try {
      inbox = await AppleServerNotificationInbox.create({
        environment: ledgerEnvironment,
        notificationUUID,
        notificationType,
        notificationSubtype,
        signedPayload,
        originalTransactionId: originalTransactionId || null,
        transactionId: transactionId || null,
        eventTime: eventTime || null,
        processingState: APPLE_NOTIFICATION_PROCESSING_STATES.pending,
        attemptCount: 0,
        processedAt: null,
        lastError: null,
        nextAttemptAt: null,
      });
    } catch (error) {
      inbox = await AppleServerNotificationInbox.findOne({
        where: {
          environment: ledgerEnvironment,
          notificationUUID,
        },
      });

      if (!inbox) {
        throw new AppleNotificationError('APPLE_NOTIFICATION_STORAGE_FAILED', 'Failed to store notification inbox record', {
          httpStatus: 500,
          retryable: true,
          publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
        });
      }
    }
  }

  return inbox;
}

async function incrementAttemptCount(inboxId) {
  await AppleServerNotificationInbox.update(
    {
      attemptCount: sequelize.literal('attemptCount + 1'),
      processingState: APPLE_NOTIFICATION_PROCESSING_STATES.pending,
      processedAt: null,
    },
    {
      where: { id: inboxId },
    }
  );

  return AppleServerNotificationInbox.findByPk(inboxId);
}

async function markInboxFailed(inboxId, errorCode, retryable, now = new Date()) {
  const inbox = await AppleServerNotificationInbox.findByPk(inboxId);
  if (!inbox) {
    return;
  }

  if (inbox.processingState === APPLE_NOTIFICATION_PROCESSING_STATES.processed) {
    return;
  }

  const nextAttemptAt = retryable ? computeNextAttemptAt(now, inbox.attemptCount || 0) : null;
  await inbox.update({
    processingState: APPLE_NOTIFICATION_PROCESSING_STATES.failed,
    processedAt: null,
    lastError: toSafeErrorToken(errorCode),
    nextAttemptAt,
  });
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
    throw new AppleNotificationError('APPLE_NOTIFICATION_VERIFICATION_FAILED', 'Nested transaction environment mismatch', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
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
    throw new AppleNotificationError('APPLE_NOTIFICATION_VERIFICATION_FAILED', 'Nested transaction identity fields are missing', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
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
    throw new AppleNotificationError('APPLE_NOTIFICATION_VERIFICATION_FAILED', 'Nested renewal environment mismatch', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
    });
  }

  const originalTransactionId = typeof decodedRenewal.originalTransactionId === 'string'
    ? decodedRenewal.originalTransactionId.trim()
    : '';
  if (!originalTransactionId) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_VERIFICATION_FAILED', 'Nested renewal originalTransactionId is missing', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
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

async function verifyNestedData({
  verifiedOuter,
  signedTransactionInfo,
  signedRenewalInfo,
  dependencies = {},
}) {
  const verifyTransactionFn = typeof dependencies.verifyTransactionFn === 'function'
    ? dependencies.verifyTransactionFn
    : verifyAndDecodeTransaction;
  const verifyRenewalFn = typeof dependencies.verifyRenewalFn === 'function'
    ? dependencies.verifyRenewalFn
    : verifyAndDecodeRenewalInfo;

  const verifierConfig = {
    environment: toVerifierEnvironmentName(verifiedOuter.environment),
    environmentsAllowed: [toVerifierEnvironmentName(verifiedOuter.environment)],
  };

  let transaction = null;
  let renewal = null;

  if (signedTransactionInfo) {
    let decoded;
    try {
      decoded = await verifyTransactionFn(signedTransactionInfo, verifierConfig);
    } catch (error) {
      throw mapVerifierError(error);
    }
    transaction = normalizeVerifiedTransaction(decoded, verifiedOuter.environment);
  }

  if (signedRenewalInfo) {
    let decoded;
    try {
      decoded = await verifyRenewalFn(signedRenewalInfo, verifierConfig);
    } catch (error) {
      throw mapVerifierError(error);
    }
    renewal = normalizeVerifiedRenewal(decoded, verifiedOuter.environment);
  }

  if (transaction && renewal && transaction.originalTransactionId !== renewal.originalTransactionId) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_VERIFICATION_FAILED', 'Transaction and renewal lineage mismatch', {
      httpStatus: 400,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_VERIFICATION_FAILED',
    });
  }

  return {
    transaction,
    renewal,
  };
}

function resolveLineageIds(outerFields, nested) {
  const fromTxOriginal = nested.transaction ? nested.transaction.originalTransactionId : null;
  const fromRenewalOriginal = nested.renewal ? nested.renewal.originalTransactionId : null;
  const originalTransactionId = fromTxOriginal || fromRenewalOriginal || null;
  const transactionId = nested.transaction ? nested.transaction.transactionId : null;
  const eventTime = outerFields.eventTime
    || (nested.transaction ? nested.transaction.signedDate : null)
    || (nested.renewal ? nested.renewal.signedDate : null)
    || null;

  return {
    originalTransactionId,
    transactionId,
    eventTime,
  };
}

async function resolveStudioBinding({
  environment,
  originalTransactionId,
  transaction,
}) {
  if (!originalTransactionId) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_BINDING_NOT_FOUND', 'Subscription lineage is missing', {
      httpStatus: 503,
      retryable: true,
      publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }

  const entitlementBinding = await StudioSubscriptionEntitlement.findOne({
    where: {
      provider: 'apple',
      environment,
      providerSubscriptionId: originalTransactionId,
    },
    transaction,
  });

  if (entitlementBinding) {
    return entitlementBinding.studioId;
  }

  const ledgerBindings = await AppleSubscriptionTransaction.findAll({
    where: {
      environment: toLedgerEnvironmentName(environment),
      originalTransactionId,
    },
    attributes: ['studioId'],
    group: ['studioId'],
    transaction,
  });

  if (!ledgerBindings || ledgerBindings.length === 0) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_BINDING_NOT_FOUND', 'No existing studio binding found for subscription lineage', {
      httpStatus: 503,
      retryable: true,
      publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }

  if (ledgerBindings.length > 1) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_BINDING_CONFLICT', 'Subscription lineage maps to multiple studios', {
      httpStatus: 500,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }

  return ledgerBindings[0].studioId;
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

function mapNotificationTypeStatus({
  notificationType,
  verifiedTransaction,
  verifiedRenewal,
  existingEntitlement,
  now,
}) {
  const baseFromTransaction = mapTransactionToBaseStatus(verifiedTransaction, now);

  if (notificationType === 'SUBSCRIBED' || notificationType === 'DID_RENEW' || notificationType === 'OFFER_REDEEMED') {
    return baseFromTransaction;
  }

  if (notificationType === 'DID_CHANGE_RENEWAL_STATUS' || notificationType === 'DID_CHANGE_RENEWAL_PREF') {
    return baseFromTransaction || (existingEntitlement ? existingEntitlement.normalizedStatus : null);
  }

  if (notificationType === 'DID_FAIL_TO_RENEW') {
    if (verifiedRenewal && verifiedRenewal.gracePeriodExpiresDate && verifiedRenewal.gracePeriodExpiresDate.getTime() > now.getTime()) {
      return 'grace_period';
    }
    if (verifiedRenewal && verifiedRenewal.isInBillingRetryPeriod === true) {
      return 'billing_retry';
    }
    return baseFromTransaction || (existingEntitlement ? existingEntitlement.normalizedStatus : null);
  }

  if (notificationType === 'GRACE_PERIOD_EXPIRED' || notificationType === 'EXPIRED') {
    return 'expired';
  }

  if (notificationType === 'REFUND') {
    return 'refunded';
  }

  if (notificationType === 'REFUND_REVERSED') {
    return baseFromTransaction || (existingEntitlement ? existingEntitlement.normalizedStatus : null);
  }

  if (notificationType === 'REVOKE') {
    return 'revoked';
  }

  if (notificationType === 'RENEWAL_EXTENDED') {
    return baseFromTransaction || (existingEntitlement ? existingEntitlement.normalizedStatus : null);
  }

  return null;
}

function deriveProviderEventTime({ outerEventTime, verifiedTransaction, verifiedRenewal }) {
  return outerEventTime
    || (verifiedTransaction ? verifiedTransaction.signedDate : null)
    || (verifiedRenewal ? verifiedRenewal.signedDate : null)
    || (verifiedTransaction ? verifiedTransaction.purchaseDate : null)
    || null;
}

function createEntitlementCandidate({
  studioId,
  environment,
  originalTransactionId,
  existingEntitlement,
  notificationType,
  verifiedTransaction,
  verifiedRenewal,
  eventTime,
  now,
}) {
  const status = mapNotificationTypeStatus({
    notificationType,
    verifiedTransaction,
    verifiedRenewal,
    existingEntitlement,
    now,
  });

  if (!status) {
    return null;
  }

  const candidate = {
    studioId,
    provider: 'apple',
    plan: existingEntitlement ? existingEntitlement.plan : 'basic',
    normalizedStatus: status,
    providerProductId: existingEntitlement ? existingEntitlement.providerProductId : (verifiedTransaction ? verifiedTransaction.productId : null),
    providerSubscriptionId: originalTransactionId,
    currentPeriodStart: existingEntitlement ? existingEntitlement.currentPeriodStart : null,
    currentPeriodEnd: existingEntitlement ? existingEntitlement.currentPeriodEnd : null,
    trialEndsAt: null,
    autoRenewEnabled: existingEntitlement ? existingEntitlement.autoRenewEnabled : null,
    gracePeriodEndsAt: existingEntitlement ? existingEntitlement.gracePeriodEndsAt : null,
    revokedAt: existingEntitlement ? existingEntitlement.revokedAt : null,
    refundedAt: existingEntitlement ? existingEntitlement.refundedAt : null,
    pausedAt: existingEntitlement ? existingEntitlement.pausedAt : null,
    lastVerifiedAt: now,
    sourceLastUpdate: 'notification',
    environment,
    providerStateVersion: existingEntitlement ? existingEntitlement.providerStateVersion : null,
    providerEventTime: deriveProviderEventTime({ outerEventTime: eventTime, verifiedTransaction, verifiedRenewal }),
  };

  if (verifiedRenewal && verifiedRenewal.autoRenewEnabled !== null) {
    candidate.autoRenewEnabled = verifiedRenewal.autoRenewEnabled;
  }

  if (verifiedRenewal && verifiedRenewal.gracePeriodExpiresDate) {
    candidate.gracePeriodEndsAt = verifiedRenewal.gracePeriodExpiresDate;
  }

  if (verifiedTransaction) {
    candidate.currentPeriodStart = verifiedTransaction.purchaseDate || candidate.currentPeriodStart;
    candidate.currentPeriodEnd = verifiedTransaction.expiresDate || candidate.currentPeriodEnd;
    candidate.providerProductId = verifiedTransaction.productId;
    if (status === 'trialing' && verifiedTransaction.expiresDate) {
      candidate.trialEndsAt = verifiedTransaction.expiresDate;
    }
    if (status === 'revoked') {
      candidate.revokedAt = verifiedTransaction.revocationDate || candidate.providerEventTime;
    }
    if (status === 'refunded') {
      candidate.refundedAt = candidate.providerEventTime;
    }
  }

  if (notificationType === 'GRACE_PERIOD_EXPIRED' && existingEntitlement && existingEntitlement.currentPeriodEnd && existingEntitlement.currentPeriodEnd.getTime() > now.getTime()) {
    return null;
  }

  if (notificationType === 'EXPIRED' && existingEntitlement && existingEntitlement.currentPeriodEnd && existingEntitlement.currentPeriodEnd.getTime() > now.getTime()) {
    return null;
  }

  if (notificationType === 'DID_CHANGE_RENEWAL_PREF' && !verifiedTransaction) {
    return {
      ...candidate,
      plan: existingEntitlement ? existingEntitlement.plan : candidate.plan,
      providerProductId: existingEntitlement ? existingEntitlement.providerProductId : candidate.providerProductId,
    };
  }

  return candidate;
}

function enforceAllowedProductOrThrow(productId, retryable = true) {
  const productConfig = getAppleProductConfiguration();
  const configValidation = validateAppleProductConfiguration(productConfig, { requireConfigured: true });
  if (!configValidation.isValid) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_PRODUCT_NOT_ALLOWED', 'Apple product configuration is invalid', {
      httpStatus: 503,
      retryable,
      publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }

  const plan = getAppleProductPlan(productId, productConfig);
  if (!plan) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_PRODUCT_NOT_ALLOWED', 'Apple product is not allowed', {
      httpStatus: 503,
      retryable,
      publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }

  return plan;
}

async function persistVerifiedTransaction({
  studioId,
  environment,
  notificationType,
  notificationSubtype,
  eventTime,
  verifiedTransaction,
  signedTransactionInfo,
  signedRenewalInfo,
  transaction,
}) {
  if (!verifiedTransaction) {
    return null;
  }

  let ledgerRow = await AppleSubscriptionTransaction.findOne({
    where: {
      environment: toLedgerEnvironmentName(environment),
      transactionId: verifiedTransaction.transactionId,
    },
    transaction,
  });

  if (ledgerRow && ledgerRow.studioId !== studioId) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_TRANSACTION_CONFLICT', 'Transaction is already bound to another studio', {
      httpStatus: 500,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }

  if (!ledgerRow) {
    try {
      ledgerRow = await AppleSubscriptionTransaction.create({
        studioId,
        environment: toLedgerEnvironmentName(environment),
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
        notificationType,
        notificationSubtype,
        providerEventTime: eventTime,
        ingestedAt: new Date(),
      }, { transaction });
    } catch (error) {
      ledgerRow = await AppleSubscriptionTransaction.findOne({
        where: {
          environment: toLedgerEnvironmentName(environment),
          transactionId: verifiedTransaction.transactionId,
        },
        transaction,
      });

      if (!ledgerRow) {
        throw new AppleNotificationError('APPLE_NOTIFICATION_STORAGE_FAILED', 'Failed to store transaction ledger', {
          httpStatus: 500,
          retryable: true,
          publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
        });
      }

      if (ledgerRow.studioId !== studioId) {
        throw new AppleNotificationError('APPLE_NOTIFICATION_TRANSACTION_CONFLICT', 'Transaction is already bound to another studio', {
          httpStatus: 500,
          retryable: false,
          publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
        });
      }
    }
  } else {
    ledgerRow.notificationType = notificationType;
    ledgerRow.notificationSubtype = notificationSubtype;
    ledgerRow.providerEventTime = eventTime || ledgerRow.providerEventTime;
    if (signedRenewalInfo && !ledgerRow.signedRenewalInfo) {
      ledgerRow.signedRenewalInfo = signedRenewalInfo;
    }
    if (signedTransactionInfo && !ledgerRow.signedTransactionInfo) {
      ledgerRow.signedTransactionInfo = signedTransactionInfo;
    }
    await ledgerRow.save({ transaction });
  }

  return ledgerRow;
}

async function applyEntitlementUpdate({
  studioId,
  environment,
  originalTransactionId,
  notificationType,
  verifiedTransaction,
  verifiedRenewal,
  eventTime,
  transaction,
  now,
}) {
  const existingEntitlement = await StudioSubscriptionEntitlement.findOne({
    where: {
      provider: 'apple',
      environment,
      providerSubscriptionId: originalTransactionId,
    },
    transaction,
  });

  if (!existingEntitlement) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_BINDING_NOT_FOUND', 'No entitlement binding found', {
      httpStatus: 503,
      retryable: true,
      publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }

  if (existingEntitlement.studioId !== studioId) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_BINDING_CONFLICT', 'Entitlement binding conflict', {
      httpStatus: 500,
      retryable: false,
      publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }

  if (verifiedTransaction && MUTATING_TYPES.has(notificationType)) {
    const mappedPlan = enforceAllowedProductOrThrow(verifiedTransaction.productId, true);
    if (mappedPlan) {
      verifiedTransaction.mappedPlan = mappedPlan;
    }
  }

  const candidate = createEntitlementCandidate({
    studioId,
    environment,
    originalTransactionId,
    existingEntitlement,
    notificationType,
    verifiedTransaction,
    verifiedRenewal,
    eventTime,
    now,
  });

  if (!candidate) {
    return { applied: false };
  }

  if (verifiedTransaction && verifiedTransaction.mappedPlan) {
    candidate.plan = verifiedTransaction.mappedPlan;
  }

  if (!shouldApplyEntitlementUpdate(existingEntitlement, candidate)) {
    return { applied: false };
  }

  existingEntitlement.set(candidate);
  await existingEntitlement.save({ transaction });

  return { applied: true };
}

function classifyNotification(notificationType) {
  if (SUPPORTED_LIFECYCLE_TYPES.has(notificationType)) {
    return 'lifecycle';
  }
  if (SAFE_NOOP_TYPES.has(notificationType)) {
    return 'safe_noop';
  }
  return 'safe_noop';
}

async function processNotificationWithTransaction({
  inboxId,
  verifiedOuter,
  nested,
  signedPayload,
  signedTransactionInfo,
  signedRenewalInfo,
  now,
}) {
  return sequelize.transaction(async (transaction) => {
    const inbox = await AppleServerNotificationInbox.findByPk(inboxId, { transaction });
    if (!inbox) {
      throw new AppleNotificationError('APPLE_NOTIFICATION_STORAGE_FAILED', 'Inbox row not found', {
        httpStatus: 500,
        retryable: true,
        publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
      });
    }

    if (inbox.processingState === APPLE_NOTIFICATION_PROCESSING_STATES.processed) {
      return { status: 'already_processed' };
    }

    const lineage = resolveLineageIds(verifiedOuter, nested);

    const classification = classifyNotification(verifiedOuter.notificationType);
    if (classification === 'safe_noop') {
      inbox.processingState = APPLE_NOTIFICATION_PROCESSING_STATES.processed;
      inbox.processedAt = now;
      inbox.lastError = null;
      inbox.nextAttemptAt = null;
      if (!inbox.originalTransactionId && lineage.originalTransactionId) {
        inbox.originalTransactionId = lineage.originalTransactionId;
      }
      if (!inbox.transactionId && lineage.transactionId) {
        inbox.transactionId = lineage.transactionId;
      }
      if (!inbox.eventTime && lineage.eventTime) {
        inbox.eventTime = lineage.eventTime;
      }
      if (!inbox.signedPayload) {
        inbox.signedPayload = signedPayload;
      }
      await inbox.save({ transaction });
      return { status: 'processed_noop' };
    }

    const studioId = await resolveStudioBinding({
      environment: verifiedOuter.environment,
      originalTransactionId: lineage.originalTransactionId,
      transaction,
    });

    await persistVerifiedTransaction({
      studioId,
      environment: verifiedOuter.environment,
      notificationType: verifiedOuter.notificationType,
      notificationSubtype: verifiedOuter.notificationSubtype,
      eventTime: lineage.eventTime,
      verifiedTransaction: nested.transaction,
      signedTransactionInfo,
      signedRenewalInfo,
      transaction,
    });

    await applyEntitlementUpdate({
      studioId,
      environment: verifiedOuter.environment,
      originalTransactionId: lineage.originalTransactionId,
      notificationType: verifiedOuter.notificationType,
      verifiedTransaction: nested.transaction,
      verifiedRenewal: nested.renewal,
      eventTime: lineage.eventTime,
      transaction,
      now,
    });

    inbox.processingState = APPLE_NOTIFICATION_PROCESSING_STATES.processed;
    inbox.processedAt = now;
    inbox.lastError = null;
    inbox.nextAttemptAt = null;
    if (!inbox.originalTransactionId && lineage.originalTransactionId) {
      inbox.originalTransactionId = lineage.originalTransactionId;
    }
    if (!inbox.transactionId && lineage.transactionId) {
      inbox.transactionId = lineage.transactionId;
    }
    if (!inbox.eventTime && lineage.eventTime) {
      inbox.eventTime = lineage.eventTime;
    }
    await inbox.save({ transaction });

    return { status: 'processed' };
  });
}

async function ingestAppleNotification({ req, now = new Date(), dependencies = {} }) {
  const signedPayload = validateNotificationRequest(req);

  return ingestAppleSignedPayload({
    signedPayload,
    now,
    dependencies,
  });
}

async function ingestAppleSignedPayload({ signedPayload, now = new Date(), dependencies = {} }) {
  const normalizedSignedPayload = validateSignedPayloadString(signedPayload);

  const verifiedOuterRaw = await verifyOuterNotificationAcrossAllowedEnvironments(normalizedSignedPayload, dependencies);
  const verifiedOuter = extractVerifiedOuterFields(verifiedOuterRaw.decoded, verifiedOuterRaw.environment);

  const signedTransactionInfo = verifiedOuter.data && typeof verifiedOuter.data.signedTransactionInfo === 'string'
    ? verifiedOuter.data.signedTransactionInfo.trim() || null
    : null;
  const signedRenewalInfo = verifiedOuter.data && typeof verifiedOuter.data.signedRenewalInfo === 'string'
    ? verifiedOuter.data.signedRenewalInfo.trim() || null
    : null;

  const nested = await verifyNestedData({
    verifiedOuter,
    signedTransactionInfo,
    signedRenewalInfo,
    dependencies,
  });

  const lineage = resolveLineageIds(verifiedOuter, nested);

  const inbox = await upsertInboxRecord({
    environment: verifiedOuter.environment,
    notificationUUID: verifiedOuter.notificationUUID,
    notificationType: verifiedOuter.notificationType,
    notificationSubtype: verifiedOuter.notificationSubtype,
    signedPayload: normalizedSignedPayload,
    originalTransactionId: lineage.originalTransactionId,
    transactionId: lineage.transactionId,
    eventTime: lineage.eventTime,
  });

  if (!inbox) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_STORAGE_FAILED', 'Failed to store inbox row', {
      httpStatus: 500,
      retryable: true,
      publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }

  if (inbox.processingState === APPLE_NOTIFICATION_PROCESSING_STATES.processed) {
    return {
      acknowledged: true,
      httpStatus: 200,
    };
  }

  const attemptedInbox = await incrementAttemptCount(inbox.id);
  if (!attemptedInbox) {
    throw new AppleNotificationError('APPLE_NOTIFICATION_STORAGE_FAILED', 'Failed to update inbox attempt count', {
      httpStatus: 500,
      retryable: true,
      publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }

  try {
    await processNotificationWithTransaction({
      inboxId: inbox.id,
      verifiedOuter,
      nested,
      signedPayload: normalizedSignedPayload,
      signedTransactionInfo,
      signedRenewalInfo,
      now,
    });

    return {
      acknowledged: true,
      httpStatus: 200,
    };
  } catch (error) {
    const mapped = error instanceof AppleNotificationError
      ? error
      : new AppleNotificationError('APPLE_NOTIFICATION_PROCESSING_FAILED', 'Notification processing failed', {
        httpStatus: 500,
        retryable: true,
        publicCode: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
      });

    await markInboxFailed(inbox.id, mapped.code, mapped.retryable, now);
    throw mapped;
  }
}

function toPublicErrorResponse(error) {
  if (!(error instanceof AppleNotificationError)) {
    return {
      status: 500,
      body: { error: 'APPLE_NOTIFICATION_PROCESSING_FAILED' },
    };
  }

  return {
    status: error.httpStatus,
    body: { error: error.publicCode || 'APPLE_NOTIFICATION_PROCESSING_FAILED' },
  };
}

module.exports = {
  AppleNotificationError,
  MAX_SIGNED_PAYLOAD_LENGTH,
  ingestAppleNotification,
  ingestAppleSignedPayload,
  toPublicErrorResponse,
};
