const { Op } = require('sequelize');
const {
  sequelize,
  StudioSubscriptionEntitlement,
  GooglePlaySubscriptionTransaction,
  GooglePubSubNotificationInbox,
} = require('../models');
const subscriptionService = require('./subscriptionService');
const {
  GooglePlayConfigurationError,
  GooglePlayNotFoundError,
  GooglePlayRateLimitError,
  GooglePlayRetryableError,
  GooglePlayNonRetryableError,
  getGooglePlayDeveloperClient,
} = require('./googlePlayDeveloperClient');
const {
  getGooglePlayProductConfiguration,
  validateGooglePlayProductConfiguration,
  GOOGLE_PLAY_NOTIFICATION_PROCESSING_STATES,
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
  GooglePubSubAuthError,
  GooglePubSubConfigurationError,
  verifyGooglePubSubPushRequest,
} = require('./googlePubSubPushAuthenticator');

const GOOGLE_PLAY_RTDN_NOTIFICATION_TYPES = Object.freeze({
  1: 'SUBSCRIPTION_RECOVERED',
  2: 'SUBSCRIPTION_RENEWED',
  3: 'SUBSCRIPTION_CANCELED',
  4: 'SUBSCRIPTION_PURCHASED',
  5: 'SUBSCRIPTION_ON_HOLD',
  6: 'SUBSCRIPTION_IN_GRACE_PERIOD',
  7: 'SUBSCRIPTION_RESTARTED',
  8: 'SUBSCRIPTION_PRICE_CHANGE_CONFIRMED',
  9: 'SUBSCRIPTION_DEFERRED',
  10: 'SUBSCRIPTION_PAUSED',
  11: 'SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED',
  12: 'SUBSCRIPTION_REVOKED',
  13: 'SUBSCRIPTION_EXPIRED',
  14: 'SUBSCRIPTION_PENDING_PURCHASE_CANCELED',
  15: 'SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED',
});

const GOOGLE_PLAY_ONE_TIME_PRODUCT_NOTIFICATION_TYPES = Object.freeze({
  1: 'ONE_TIME_PRODUCT_PURCHASED',
  2: 'ONE_TIME_PRODUCT_CANCELED',
});

const GOOGLE_PLAY_VOIDED_PURCHASE_PRODUCT_TYPES = Object.freeze({
  1: 'PRODUCT_TYPE_SUBSCRIPTION',
  2: 'PRODUCT_TYPE_ONE_TIME',
});

const GOOGLE_PLAY_VOIDED_PURCHASE_REFUND_TYPES = Object.freeze({
  1: 'REFUND_TYPE_FULL_REFUND',
  2: 'REFUND_TYPE_QUANTITY_BASED_PARTIAL_REFUND',
});

const GOOGLE_PLAY_PENDING_REFUND_REASONS = Object.freeze({
  7: 'CHARGEBACK',
});

const MAX_PUBSUB_MESSAGE_DATA_LENGTH = 65536;
const MAX_DEVELOPER_NOTIFICATION_LENGTH = 65536;
const MAX_PURCHASE_TOKEN_LENGTH = 1024;
const MAX_LAST_ERROR_LENGTH = 160;
const DEFAULT_RETRY_BASE_MINUTES = 5;
const DEFAULT_RETRY_MAX_MINUTES = 360;
const DEFAULT_MAX_ATTEMPTS = 10;

class GooglePlayRtdnError extends Error {
  constructor(code, message, httpStatus = 400, retryable = false) {
    super(message);
    this.name = 'GooglePlayRtdnError';
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

function normalizeInteger(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric) || !Number.isSafeInteger(numeric)) {
    return null;
  }

  return numeric;
}

function normalizeDate(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric) || !Number.isSafeInteger(numeric)) {
    return null;
  }

  const parsed = new Date(numeric);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toSafeErrorToken(code) {
  const normalized = normalizeString(code) || 'GOOGLE_PLAY_NOTIFICATION_PROCESSING_FAILED';
  return normalized.length > MAX_LAST_ERROR_LENGTH ? normalized.slice(0, MAX_LAST_ERROR_LENGTH) : normalized;
}

function normalizeMessageData(data) {
  if (typeof data !== 'string') {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'message.data is required', 400);
  }

  const normalized = data.trim();
  if (!normalized) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'message.data is required', 400);
  }

  if (normalized.length > MAX_PUBSUB_MESSAGE_DATA_LENGTH) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'message.data is too large', 400);
  }

  return normalized;
}

function validateGooglePubSubEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'Request body must be a JSON object', 400);
  }

  const message = body.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'message is required', 400);
  }

  const messageId = normalizeString(message.messageId) || normalizeString(message.message_id);
  if (!messageId) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'message.messageId is required', 400);
  }

  const data = normalizeMessageData(message.data);
  const subscription = normalizeString(body.subscription);
  if (!subscription) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'subscription is required', 400);
  }

  return {
    subscription,
    message: {
      messageId,
      data,
      publishTime: normalizeString(message.publishTime) || normalizeString(message.publish_time) || null,
      attributes: message.attributes && typeof message.attributes === 'object' && !Array.isArray(message.attributes)
        ? { ...message.attributes }
        : null,
    },
  };
}

function decodeGooglePubSubMessageData(data) {
  const normalized = normalizeMessageData(data);
  const compact = normalized.replace(/\s+/gu, '');
  const decoded = Buffer.from(compact, 'base64');

  if (decoded.length > MAX_DEVELOPER_NOTIFICATION_LENGTH) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'Decoded notification is too large', 400);
  }

  const reencoded = decoded.toString('base64').replace(/=+$/u, '');
  const inputToken = compact.replace(/=+$/u, '');
  if (reencoded !== inputToken) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'message.data is malformed', 400);
  }

  const text = decoded.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_DEVELOPER_NOTIFICATION_LENGTH) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'Decoded notification is too large', 400);
  }

  return text;
}

function validateGoogleSubscriptionNotification(notification) {
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'subscriptionNotification is invalid', 400);
  }

  const version = normalizeString(notification.version);
  const notificationType = normalizeInteger(notification.notificationType);
  const purchaseToken = normalizeString(notification.purchaseToken);

  if (!version || !purchaseToken) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'subscriptionNotification is invalid', 400);
  }

  if (!notificationType || !Object.prototype.hasOwnProperty.call(GOOGLE_PLAY_RTDN_NOTIFICATION_TYPES, notificationType)) {
    return {
      kind: 'unsupported',
      notificationKind: 'subscription',
      version,
      notificationType,
      purchaseToken,
    };
  }

  return {
    kind: 'subscription',
    notificationKind: 'subscription',
    version,
    notificationType,
    notificationTypeName: GOOGLE_PLAY_RTDN_NOTIFICATION_TYPES[notificationType],
    purchaseToken,
  };
}

function validateGoogleOneTimeProductNotification(notification) {
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'oneTimeProductNotification is invalid', 400);
  }

  const version = normalizeString(notification.version);
  const notificationType = normalizeInteger(notification.notificationType);
  const purchaseToken = normalizeString(notification.purchaseToken);
  const sku = normalizeString(notification.sku);

  if (!version || !purchaseToken || !sku || !notificationType) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'oneTimeProductNotification is invalid', 400);
  }

  if (!Object.prototype.hasOwnProperty.call(GOOGLE_PLAY_ONE_TIME_PRODUCT_NOTIFICATION_TYPES, notificationType)) {
    return {
      kind: 'unsupported',
      notificationKind: 'one_time_product',
      version,
      notificationType,
      purchaseToken,
      sku,
    };
  }

  return {
    kind: 'one_time_product',
    notificationKind: 'one_time_product',
    version,
    notificationType,
    notificationTypeName: GOOGLE_PLAY_ONE_TIME_PRODUCT_NOTIFICATION_TYPES[notificationType],
    purchaseToken,
    sku,
  };
}

function validateGoogleVoidedPurchaseNotification(notification) {
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'voidedPurchaseNotification is invalid', 400);
  }

  const purchaseToken = normalizeString(notification.purchaseToken);
  const orderId = normalizeString(notification.orderId);
  const productType = normalizeInteger(notification.productType);
  const refundType = normalizeInteger(notification.refundType);

  if (!purchaseToken || !orderId || !productType || !refundType) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'voidedPurchaseNotification is invalid', 400);
  }

  if (!Object.prototype.hasOwnProperty.call(GOOGLE_PLAY_VOIDED_PURCHASE_PRODUCT_TYPES, productType)
    || !Object.prototype.hasOwnProperty.call(GOOGLE_PLAY_VOIDED_PURCHASE_REFUND_TYPES, refundType)) {
    return {
      kind: 'unsupported',
      notificationKind: 'voided_purchase',
      purchaseToken,
      orderId,
      productType,
      refundType,
    };
  }

  return {
    kind: productType === 1 ? 'voided_purchase_subscription' : 'voided_purchase_one_time',
    notificationKind: 'voided_purchase',
    purchaseToken,
    orderId,
    productType,
    productTypeName: GOOGLE_PLAY_VOIDED_PURCHASE_PRODUCT_TYPES[productType],
    refundType,
    refundTypeName: GOOGLE_PLAY_VOIDED_PURCHASE_REFUND_TYPES[refundType],
  };
}

function validateGooglePendingRefundReviewNotification(notification) {
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'pendingRefundReviewNotification is invalid', 400);
  }

  const pendingRefundToken = normalizeString(notification.pendingRefundToken);
  const orderId = normalizeString(notification.orderId);
  const refundReason = normalizeInteger(notification.refundReason);

  if (!pendingRefundToken || !orderId || !refundReason) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'pendingRefundReviewNotification is invalid', 400);
  }

  return {
    kind: 'pending_refund_review',
    notificationKind: 'pending_refund_review',
    pendingRefundToken,
    orderId,
    refundReason,
    refundReasonName: GOOGLE_PLAY_PENDING_REFUND_REASONS[refundReason] || 'UNKNOWN',
  };
}

function validateGoogleTestNotification(notification) {
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'testNotification is invalid', 400);
  }

  const version = normalizeString(notification.version);
  if (!version) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'testNotification.version is required', 400);
  }

  return {
    kind: 'test',
    notificationKind: 'test',
    version,
  };
}

function validateGoogleDeveloperNotification(notification) {
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'DeveloperNotification is invalid', 400);
  }

  const version = normalizeString(notification.version);
  const packageName = normalizeString(notification.packageName);
  const eventTimeMillis = normalizeInteger(notification.eventTimeMillis);
  const eventTime = normalizeDate(notification.eventTimeMillis);

  if (!version || !packageName || !eventTimeMillis || !eventTime) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'DeveloperNotification is invalid', 400);
  }

  const payloads = [
    ['subscriptionNotification', notification.subscriptionNotification],
    ['oneTimeProductNotification', notification.oneTimeProductNotification],
    ['voidedPurchaseNotification', notification.voidedPurchaseNotification],
    ['pendingRefundReviewNotification', notification.pendingRefundReviewNotification],
    ['testNotification', notification.testNotification],
  ].filter(([, value]) => typeof value !== 'undefined' && value !== null);

  if (payloads.length > 1) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'DeveloperNotification payload is mixed', 400);
  }

  if (payloads.length === 0) {
    return {
      kind: 'unsupported',
      version,
      packageName,
      eventTimeMillis,
      eventTime,
    };
  }

  const [payloadName, payload] = payloads[0];
  let validatedPayload;

  switch (payloadName) {
    case 'subscriptionNotification':
      validatedPayload = validateGoogleSubscriptionNotification(payload);
      break;
    case 'oneTimeProductNotification':
      validatedPayload = validateGoogleOneTimeProductNotification(payload);
      break;
    case 'voidedPurchaseNotification':
      validatedPayload = validateGoogleVoidedPurchaseNotification(payload);
      break;
    case 'pendingRefundReviewNotification':
      validatedPayload = validateGooglePendingRefundReviewNotification(payload);
      break;
    case 'testNotification':
      validatedPayload = validateGoogleTestNotification(payload);
      break;
    default:
      throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'DeveloperNotification payload is invalid', 400);
  }

  return {
    kind: validatedPayload.kind,
    notificationKind: validatedPayload.notificationKind,
    version,
    packageName,
    eventTimeMillis,
    eventTime,
    [payloadName]: payload,
    validatedPayload,
  };
}

function classifyGoogleDeveloperNotification(notification) {
  return validateGoogleDeveloperNotification(notification).kind;
}

function normalizeGoogleRtdnEventTime(value) {
  return normalizeDate(value);
}

function loadRetryConfiguration(dependencies = {}) {
  const baseMinutes = Number(normalizeString(dependencies.retryBaseMinutes) || process.env.GOOGLE_PLAY_NOTIFICATION_RETRY_BASE_MINUTES || DEFAULT_RETRY_BASE_MINUTES);
  const maxMinutes = Number(normalizeString(dependencies.retryMaxMinutes) || process.env.GOOGLE_PLAY_NOTIFICATION_RETRY_MAX_MINUTES || DEFAULT_RETRY_MAX_MINUTES);
  const maxAttempts = Number(normalizeString(dependencies.retryMaxAttempts) || process.env.GOOGLE_PLAY_NOTIFICATION_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS);

  if (!Number.isInteger(baseMinutes) || baseMinutes <= 0 || !Number.isInteger(maxMinutes) || maxMinutes < baseMinutes || !Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new GooglePubSubConfigurationError('GOOGLE_PLAY_NOTIFICATION_RETRY_CONFIGURATION_INVALID', 'Google Play notification retry configuration is invalid');
  }

  return {
    baseMinutes,
    maxMinutes,
    maxAttempts,
  };
}

function calculateRetryDelayMinutes(attemptCount, retryConfig) {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(retryConfig.maxMinutes, retryConfig.baseMinutes * (2 ** exponent));
}

function toRetryAt(now, retryConfig, attemptCount) {
  return new Date(now.getTime() + calculateRetryDelayMinutes(attemptCount, retryConfig) * 60 * 1000);
}

function buildRawPayloadJson({ envelope, notification, validation }) {
  return JSON.stringify({
    subscription: envelope.subscription,
    message: {
      messageId: envelope.message.messageId,
      publishTime: envelope.message.publishTime,
      attributes: envelope.message.attributes,
    },
    notification: {
      version: notification.version,
      packageName: notification.packageName,
      eventTimeMillis: notification.eventTimeMillis,
      kind: validation.kind,
      subscriptionNotification: notification.subscriptionNotification || null,
      oneTimeProductNotification: notification.oneTimeProductNotification || null,
      voidedPurchaseNotification: notification.voidedPurchaseNotification || null,
      pendingRefundReviewNotification: notification.pendingRefundReviewNotification || null,
      testNotification: notification.testNotification || null,
    },
  });
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

async function getGooglePlayDeveloperApiClient(dependencies = {}) {
  if (dependencies.googleClient) {
    return dependencies.googleClient;
  }

  if (typeof dependencies.googleClientFactory === 'function') {
    const client = dependencies.googleClientFactory();
    if (client && typeof client === 'object') {
      return client;
    }
  }

  return getGooglePlayDeveloperClient().client;
}

function resolveGooglePlayRtdnConfiguration(dependencies = {}) {
  const config = dependencies.googlePlayProductConfiguration || getGooglePlayProductConfiguration();
  const validation = validateGooglePlayProductConfiguration(config, { requireConfigured: true });

  if (!validation.isValid) {
    throw new GooglePubSubConfigurationError('GOOGLE_PLAY_NOTIFICATION_CONFIGURATION_INVALID', 'Google Play notification configuration is invalid');
  }

  const packageName = normalizeString(validation.normalized.packageName);
  if (!packageName) {
    throw new GooglePubSubConfigurationError('GOOGLE_PLAY_NOTIFICATION_PACKAGE_REQUIRED', 'Google Play package configuration is invalid');
  }

  const accountHashSecret = normalizeString(dependencies.googlePlayAccountHashSecret || process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET);
  if (!accountHashSecret) {
    throw new GooglePubSubConfigurationError('GOOGLE_PLAY_NOTIFICATION_ACCOUNT_SECRET_REQUIRED', 'Google Play account hash configuration is invalid');
  }

  return {
    productConfiguration: validation.normalized,
    packageName,
    accountHashSecret,
    retryConfig: loadRetryConfiguration(dependencies),
    expectedAudience: normalizeString(dependencies.pushAudience || process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE),
    expectedServiceAccountEmail: normalizeString(dependencies.pushServiceAccountEmail || process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL),
    expectedIssuers: dependencies.pushIssuers,
  };
}

async function getInboxRecord({ envelope, notification, validation, now }) {
  const rawPayloadJson = buildRawPayloadJson({ envelope, notification, validation });

  return sequelize.transaction(async (transaction) => {
    const existing = await GooglePubSubNotificationInbox.findOne({
      where: {
        packageName: notification.packageName,
        pubsubMessageId: envelope.message.messageId,
      },
      transaction,
    });

    if (existing) {
      if (existing.processingState === 'processed') {
        return { inbox: existing, alreadyProcessed: true };
      }

      return { inbox: existing, alreadyProcessed: false };
    }

    const inbox = await GooglePubSubNotificationInbox.create({
      environment: 'unresolved',
      pubsubMessageId: envelope.message.messageId,
      publishTime: envelope.message.publishTime ? new Date(envelope.message.publishTime) : null,
      packageName: notification.packageName,
      purchaseToken: validation.validatedPayload && validation.validatedPayload.purchaseToken ? validation.validatedPayload.purchaseToken : null,
      subscriptionNotificationType: validation.notificationKind === 'subscription' || validation.notificationKind === 'voided_purchase'
        ? String(validation.validatedPayload.notificationType)
        : null,
      oneTimeProductNotificationType: validation.notificationKind === 'one_time_product'
        ? String(validation.validatedPayload.notificationType)
        : null,
      testNotificationFlag: validation.kind === 'test',
      rawPayloadJson,
      processingState: 'pending',
      processedAt: null,
      lastError: null,
      attemptCount: 0,
      nextAttemptAt: null,
    }, { transaction });

    return { inbox, alreadyProcessed: false };
  });
}

async function resolveGoogleRtdnStudioBinding({ purchaseToken, linkedPurchaseToken, transaction }) {
  const directTransactionRows = await GooglePlaySubscriptionTransaction.findAll({
    where: { purchaseToken },
    transaction,
  });
  const directEntitlementRows = await StudioSubscriptionEntitlement.findAll({
    where: { provider: 'google_play', providerSubscriptionId: purchaseToken },
    transaction,
  });

  const studioIds = new Set();
  for (const row of directTransactionRows) {
    if (Number.isInteger(row.studioId)) {
      studioIds.add(row.studioId);
    }
  }
  for (const row of directEntitlementRows) {
    if (Number.isInteger(row.studioId)) {
      studioIds.add(row.studioId);
    }
  }

  if (studioIds.size > 1) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_BINDING_CONFLICT', 'Google Play binding is ambiguous', 500, false);
  }

  let studioId = studioIds.size === 1 ? Array.from(studioIds)[0] : null;
  let lineageStudioId = null;

  if (linkedPurchaseToken) {
    const linkedTransactions = await GooglePlaySubscriptionTransaction.findAll({
      where: { purchaseToken: linkedPurchaseToken },
      transaction,
    });
    const linkedEntitlements = await StudioSubscriptionEntitlement.findAll({
      where: { provider: 'google_play', providerSubscriptionId: linkedPurchaseToken },
      transaction,
    });

    const linkedStudioIds = new Set();
    for (const row of linkedTransactions) {
      if (Number.isInteger(row.studioId)) {
        linkedStudioIds.add(row.studioId);
      }
    }
    for (const row of linkedEntitlements) {
      if (Number.isInteger(row.studioId)) {
        linkedStudioIds.add(row.studioId);
      }
    }

    if (linkedStudioIds.size > 1) {
      throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_BINDING_CONFLICT', 'Google Play linked lineage is ambiguous', 500, false);
    }

    lineageStudioId = linkedStudioIds.size === 1 ? Array.from(linkedStudioIds)[0] : null;

    if (studioId && lineageStudioId && studioId !== lineageStudioId) {
      throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_BINDING_CONFLICT', 'Google Play linked lineage belongs to another studio', 500, false);
    }

    if (!studioId) {
      studioId = lineageStudioId;
    }
  }

  return {
    studioId,
    lineageStudioId,
    directTransactionRows,
    directEntitlementRows,
  };
}

function toSafeNoopResult() {
  return { acknowledged: true, status: 'noop' };
}

function toSafeProcessedResult() {
  return { acknowledged: true, status: 'processed' };
}

function toPublicError() {
  return { error: 'Notification processing failed' };
}

function mapInboxFailureAttemptCount(inbox, retryConfig) {
  const attemptCount = Number(inbox.attemptCount || 0);
  return attemptCount >= retryConfig.maxAttempts ? null : attemptCount;
}

async function markInboxFailed({ inbox, now, retryConfig, code, retryable }) {
  inbox.processingState = 'failed';
  inbox.processedAt = null;
  inbox.lastError = toSafeErrorToken(code);
  const nextAttemptAt = retryable && Number(inbox.attemptCount || 0) < retryConfig.maxAttempts
    ? toRetryAt(now, retryConfig, Number(inbox.attemptCount || 0) + 1)
    : null;
  inbox.nextAttemptAt = nextAttemptAt;
  await inbox.save();

  return { acknowledged: false, retryable, code };
}

async function markInboxProcessed({ inbox, now }) {
  inbox.processingState = 'processed';
  inbox.processedAt = now;
  inbox.lastError = null;
  inbox.nextAttemptAt = null;
  await inbox.save();
  return toSafeProcessedResult();
}

async function applyAuthoritativeSubscriptionUpdate({
  studioId,
  apiData,
  mapped,
  inbox,
  now,
  transaction,
}) {
  const candidateTransactionSnapshot = buildGooglePlayTransactionSnapshot({
    studioId,
    now,
    mapped: mapped.value,
    apiData,
    purchaseToken: mapped.value.providerSubscriptionId,
  });

  const effectiveStatuses = subscriptionService.getEffectiveEntitlementStatuses();
  const currentEffectiveEntitlement = await StudioSubscriptionEntitlement.findOne({
    where: {
      studioId,
      normalizedStatus: {
        [Op.in]: effectiveStatuses,
      },
    },
    order: [['updatedAt', 'DESC']],
    transaction,
  });

  if (currentEffectiveEntitlement && currentEffectiveEntitlement.provider !== 'google_play') {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_OTHER_PROVIDER_ACTIVE', 'Another provider entitlement is already active for this studio', 409, false);
  }

  const existingTransaction = await GooglePlaySubscriptionTransaction.findOne({
    where: {
      purchaseToken: candidateTransactionSnapshot.purchaseToken,
      environment: candidateTransactionSnapshot.environment,
    },
    transaction,
  });

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
    providerSubscriptionId: mapped.value.providerSubscriptionId,
    currentPeriodStart: mapped.value.currentPeriodStart,
    currentPeriodEnd: mapped.value.currentPeriodEnd,
    trialEndsAt: mapped.value.trialDetectedReliably ? mapped.value.currentPeriodEnd : null,
    autoRenewEnabled: mapped.value.autoRenewEnabled,
    gracePeriodEndsAt: null,
    revokedAt: mapped.value.normalizedStatus === 'revoked' ? candidateTransactionSnapshot.providerEventTime : null,
    refundedAt: mapped.value.normalizedStatus === 'refunded' ? candidateTransactionSnapshot.providerEventTime : null,
    pausedAt: mapped.value.normalizedStatus === 'paused' ? mapped.value.currentPeriodEnd : null,
    lastVerifiedAt: now,
    sourceLastUpdate: 'notification',
    environment: mapped.value.environment,
    providerStateVersion: normalizeString(apiData.etag),
    providerEventTime: candidateTransactionSnapshot.providerEventTime,
  };

  if (mapped.value.linkedPurchaseToken) {
    const linkedEntitlement = await StudioSubscriptionEntitlement.findOne({
      where: {
        studioId,
        provider: 'google_play',
        providerSubscriptionId: mapped.value.linkedPurchaseToken,
      },
      transaction,
    });

    if (linkedEntitlement && linkedEntitlement.providerSubscriptionId !== mapped.value.providerSubscriptionId) {
      const retirementStatus = linkedEntitlement.currentPeriodEnd && linkedEntitlement.currentPeriodEnd.getTime() <= now.getTime()
        ? 'expired'
        : 'cancelled';

      if (subscriptionService.isEffectiveEntitlementStatus(linkedEntitlement.normalizedStatus)) {
        await linkedEntitlement.update({
          normalizedStatus: retirementStatus,
          sourceLastUpdate: 'notification',
          providerEventTime: candidateTransactionSnapshot.providerEventTime,
          lastVerifiedAt: now,
        }, { transaction });
      }
    }
  }

  const existingEntitlement = await StudioSubscriptionEntitlement.findOne({
    where: {
      studioId,
      provider: 'google_play',
      providerSubscriptionId: mapped.value.providerSubscriptionId,
      environment: mapped.value.environment,
    },
    transaction,
  });

  if (existingEntitlement) {
    if (shouldApplyGooglePlayEntitlementUpdate(existingEntitlement, entitlementSnapshot)) {
      await existingEntitlement.update(entitlementSnapshot, { transaction });
    }
  } else {
    await StudioSubscriptionEntitlement.create(entitlementSnapshot, { transaction });
  }

  inbox.environment = mapped.value.environment;
  inbox.processingState = 'processed';
  inbox.processedAt = now;
  inbox.lastError = null;
  inbox.nextAttemptAt = null;
  await inbox.save({ transaction });

  return toSafeProcessedResult();
}

async function processGooglePlayRtdnInboxRecord({
  inbox,
  notification,
  validation,
  now,
  dependencies = {},
}) {
  if (validation.kind === 'test' || validation.kind === 'one_time_product' || validation.kind === 'voided_purchase_one_time' || validation.kind === 'pending_refund_review' || validation.kind === 'unsupported') {
    inbox.attemptCount = Number(inbox.attemptCount || 0) + 1;
    await inbox.save();
    return markInboxProcessed({ inbox, now });
  }

  const runtimeConfig = resolveGooglePlayRtdnConfiguration(dependencies);
  const client = await getGooglePlayDeveloperApiClient(dependencies);

  let apiResponse;
  try {
    apiResponse = await client.purchases.subscriptionsv2.get({
      packageName: runtimeConfig.packageName,
      token: validation.validatedPayload.purchaseToken,
    });
  } catch (error) {
    const mappedError = mapGoogleApiError(error);
    if (mappedError.httpStatus === 404) {
      return markInboxFailed({
        inbox,
        now,
        retryConfig: runtimeConfig.retryConfig,
        code: mappedError.code,
        retryable: true,
      });
    }

    throw new GooglePlayRtdnError(mappedError.code, mappedError.message, mappedError.httpStatus, Boolean(mappedError.retryable));
  }

  const apiData = extractGoogleApiData(apiResponse);
  const binding = await resolveGoogleRtdnStudioBinding({
    purchaseToken: validation.validatedPayload.purchaseToken,
    linkedPurchaseToken: normalizeString(apiData.linkedPurchaseToken),
    transaction: null,
  });

  if (!binding.studioId) {
    return markInboxFailed({
      inbox,
      now,
      retryConfig: runtimeConfig.retryConfig,
      code: 'GOOGLE_PLAY_NOTIFICATION_BINDING_NOT_FOUND',
      retryable: true,
    });
  }

  const expectedAccountId = generateGoogleObfuscatedAccountId({
    studioId: binding.studioId,
    secret: runtimeConfig.accountHashSecret,
  });

  const mapped = mapGooglePlaySubscriptionV2ToEntitlementInput({
    response: apiData,
    purchaseToken: validation.validatedPayload.purchaseToken,
    expectedPackageName: runtimeConfig.packageName,
    expectedObfuscatedAccountId: expectedAccountId,
    config: runtimeConfig.productConfiguration,
    now,
  });

  if (!mapped.ok) {
    if (mapped.code === 'GOOGLE_PLAY_ACCOUNT_ID_MISSING' || mapped.code === 'GOOGLE_PLAY_ACCOUNT_ID_MISMATCH') {
      throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_ACCOUNT_MISMATCH', mapped.message, 409, false);
    }

    if (mapped.code === 'GOOGLE_PLAY_PRODUCT_MAPPING_INVALID') {
      throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_PLAN_MISMATCH', mapped.message, 409, false);
    }

    if (mapped.code === 'GOOGLE_PLAY_ENVIRONMENT_MISMATCH') {
      throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_ENVIRONMENT_MISMATCH', mapped.message, 400, false);
    }

    throw new GooglePlayRtdnError(mapped.code || 'GOOGLE_PLAY_NOTIFICATION_FAILED', mapped.message || 'Google Play notification processing failed', 400, false);
  }

  if (!secureEquals(expectedAccountId, mapped.value.externalAccountIdentifier)) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_ACCOUNT_MISMATCH', 'Google Play account linkage did not match expected identifier', 409, false);
  }

  const result = await sequelize.transaction(async (transaction) => {
    const lockedInbox = await GooglePubSubNotificationInbox.findByPk(inbox.id, { transaction });
    if (!lockedInbox) {
      throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_STORAGE_FAILED', 'Inbox record is missing', 500, true);
    }

    if (lockedInbox.processingState === 'processed') {
      return toSafeNoopResult();
    }

    lockedInbox.attemptCount = Number(lockedInbox.attemptCount || 0) + 1;
    await lockedInbox.save({ transaction });

    return applyAuthoritativeSubscriptionUpdate({
      studioId: binding.studioId,
      apiData,
      mapped,
      inbox: lockedInbox,
      now,
      transaction,
    });
  });

  return result;
}

async function ingestGooglePlayNotification({
  authorizationHeader,
  body,
  now = new Date(),
  dependencies = {},
} = {}) {
  const authResult = await verifyGooglePubSubPushRequest({
    authorizationHeader,
    expectedAudience: dependencies.pushAudience,
    expectedServiceAccountEmail: dependencies.pushServiceAccountEmail,
    expectedIssuers: dependencies.pushIssuers,
    dependencies: dependencies.pushAuthDependencies || {},
  });

  if (!authResult || authResult.verified !== true) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_AUTH_FAILED', 'Google Pub/Sub push authentication failed', 403, false);
  }

  const envelope = validateGooglePubSubEnvelope(body);
  const decodedText = decodeGooglePubSubMessageData(envelope.message.data);

  let notification;
  try {
    notification = JSON.parse(decodedText);
  } catch (error) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_INVALID_REQUEST', 'message.data is not valid JSON', 400, false);
  }

  const validation = validateGoogleDeveloperNotification(notification);
  const runtimeConfig = resolveGooglePlayRtdnConfiguration(dependencies);

  if (validation.packageName !== runtimeConfig.packageName) {
    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_PACKAGE_MISMATCH', 'Notification package does not match configured package', 400, false);
  }

  const inboxResult = await getInboxRecord({
    envelope,
    notification,
    validation,
    now,
  });

  if (inboxResult.alreadyProcessed) {
    return toSafeNoopResult();
  }

  if (validation.kind === 'test' || validation.kind === 'one_time_product' || validation.kind === 'voided_purchase_one_time' || validation.kind === 'pending_refund_review' || validation.kind === 'unsupported') {
    inboxResult.inbox.attemptCount = Number(inboxResult.inbox.attemptCount || 0) + 1;
    await inboxResult.inbox.save();
    return markInboxProcessed({ inbox: inboxResult.inbox, now });
  }

  try {
    const result = await processGooglePlayRtdnInboxRecord({
      inbox: inboxResult.inbox,
      notification,
      validation,
      now,
      dependencies,
    });

    if (result && result.retryable) {
      throw new GooglePlayRtdnError(result.code || 'GOOGLE_PLAY_NOTIFICATION_PROCESSING_FAILED', 'Notification processing failed', 503, true);
    }

    return result;
  } catch (error) {
    if (error instanceof GooglePlayRtdnError) {
      if (error.retryable) {
        const retryConfig = loadRetryConfiguration(dependencies);
        await markInboxFailed({
          inbox: inboxResult.inbox,
          now,
          retryConfig,
          code: error.code,
          retryable: true,
        });
      }

      throw error;
    }

    throw new GooglePlayRtdnError('GOOGLE_PLAY_NOTIFICATION_PROCESSING_FAILED', 'Notification processing failed', 500, true);
  }
}

module.exports = {
  GooglePlayRtdnError,
  GOOGLE_PLAY_RTDN_NOTIFICATION_TYPES,
  GOOGLE_PLAY_ONE_TIME_PRODUCT_NOTIFICATION_TYPES,
  GOOGLE_PLAY_VOIDED_PURCHASE_PRODUCT_TYPES,
  GOOGLE_PLAY_VOIDED_PURCHASE_REFUND_TYPES,
  GOOGLE_PLAY_PENDING_REFUND_REASONS,
  validateGooglePubSubEnvelope,
  decodeGooglePubSubMessageData,
  validateGoogleDeveloperNotification,
  validateGoogleSubscriptionNotification,
  validateGoogleOneTimeProductNotification,
  validateGoogleVoidedPurchaseNotification,
  validateGooglePendingRefundReviewNotification,
  validateGoogleTestNotification,
  classifyGoogleDeveloperNotification,
  normalizeGoogleRtdnEventTime,
  loadRetryConfiguration,
  calculateRetryDelayMinutes,
  processGooglePlayRtdnInboxRecord,
  ingestGooglePlayNotification,
  resolveGooglePlayRtdnConfiguration,
  resolveGoogleRtdnStudioBinding,
  applyAuthoritativeSubscriptionUpdate,
  markInboxProcessed,
  markInboxFailed,
  toSafeNoopResult,
  toSafeProcessedResult,
  toPublicError,
};