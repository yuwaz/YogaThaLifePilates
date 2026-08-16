const {
  sequelize,
  Studio,
  StudioSubscriptionEntitlement,
  StudioManualSubscriptionOverride,
  AppleSubscriptionTransaction,
  GooglePlaySubscriptionTransaction,
} = require('../models');
const { resolveSubscriptionAccessDecision } = require('./subscriptionAccessService');

function createValidationError(message) {
  const error = new Error(message);
  error.code = 'BACKOFFICE_VALIDATION_ERROR';
  return error;
}

function parsePositiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createValidationError(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function sanitizeEntitlement(entitlementLike) {
  if (!entitlementLike) return null;
  const entitlement = entitlementLike && typeof entitlementLike.get === 'function'
    ? entitlementLike.get({ plain: true })
    : entitlementLike;

  return {
    provider: entitlement.provider,
    plan: entitlement.plan,
    normalizedStatus: entitlement.normalizedStatus,
    environment: entitlement.environment,
    currentPeriodStart: entitlement.currentPeriodStart,
    currentPeriodEnd: entitlement.currentPeriodEnd,
    autoRenew: entitlement.autoRenewEnabled,
    sourceLastUpdate: entitlement.sourceLastUpdate,
    providerEventTime: entitlement.providerEventTime,
    updatedAt: entitlement.updatedAt,
  };
}

function sanitizeAppleTransaction(transactionLike) {
  if (!transactionLike) return null;
  const transaction = transactionLike && typeof transactionLike.get === 'function'
    ? transactionLike.get({ plain: true })
    : transactionLike;

  return {
    id: transaction.id,
    studioId: transaction.studioId,
    environment: transaction.environment,
    originalTransactionId: transaction.originalTransactionId,
    transactionId: transaction.transactionId,
    productId: transaction.productId,
    subscriptionGroupIdentifier: transaction.subscriptionGroupIdentifier,
    purchaseDate: transaction.purchaseDate,
    originalPurchaseDate: transaction.originalPurchaseDate,
    expiresDate: transaction.expiresDate,
    revocationDate: transaction.revocationDate,
    autoRenewStatus: transaction.autoRenewStatus,
    notificationType: transaction.notificationType,
    notificationSubtype: transaction.notificationSubtype,
    providerEventTime: transaction.providerEventTime,
    ingestedAt: transaction.ingestedAt,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
  };
}

function sanitizeGoogleTransaction(transactionLike) {
  if (!transactionLike) return null;
  const transaction = transactionLike && typeof transactionLike.get === 'function'
    ? transactionLike.get({ plain: true })
    : transactionLike;

  return {
    id: transaction.id,
    studioId: transaction.studioId,
    environment: transaction.environment,
    packageName: transaction.packageName,
    productId: transaction.productId,
    basePlanId: transaction.basePlanId,
    offerId: transaction.offerId,
    latestSuccessfulOrderId: transaction.latestSuccessfulOrderId,
    subscriptionState: transaction.subscriptionState,
    acknowledgementState: transaction.acknowledgementState,
    autoRenewEnabled: transaction.autoRenewEnabled,
    startTime: transaction.startTime,
    expiryTime: transaction.expiryTime,
    testPurchaseFlag: transaction.testPurchaseFlag,
    providerEventTime: transaction.providerEventTime,
    ingestedAt: transaction.ingestedAt,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
  };
}

function groupCountRows(rows, keyField, valueField) {
  const grouped = {};
  for (const row of rows || []) {
    const key = String(row[keyField]);
    grouped[key] = Number(row[valueField]);
  }
  return grouped;
}

function toDateOrNull(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function sanitizeManualOverride(overrideLike) {
  if (!overrideLike) return null;
  const override = overrideLike && typeof overrideLike.get === 'function'
    ? overrideLike.get({ plain: true })
    : overrideLike;

  return {
    id: override.id,
    studioId: override.studioId,
    subscriptionPlan: override.subscriptionPlan,
    subscriptionStatus: override.subscriptionStatus,
    effectiveFrom: override.effectiveFrom || null,
    expiresAt: override.expiresAt || null,
    reason: override.reason,
    createdByPlatformAdminId: override.createdByPlatformAdminId,
    revokedAt: override.revokedAt || null,
    revokedByPlatformAdminId: override.revokedByPlatformAdminId || null,
    revokeReason: override.revokeReason || null,
    createdAt: override.createdAt || null,
    updatedAt: override.updatedAt || null,
  };
}

function evaluateManualOverrideState(override, now = new Date()) {
  if (!override) {
    return 'none';
  }

  if (override.revokedAt) {
    return 'revoked';
  }

  const effectiveFrom = toDateOrNull(override.effectiveFrom);
  if (!effectiveFrom) {
    return 'invalid';
  }

  const expiresAt = toDateOrNull(override.expiresAt);
  if (override.expiresAt && !expiresAt) {
    return 'invalid';
  }

  if (effectiveFrom.getTime() > now.getTime()) {
    return 'scheduled';
  }

  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }

  return 'effective';
}

async function getAppleInboxHealthByStudio(studioId) {
  const [rows] = await sequelize.query(
    `
      SELECT inbox.processingState AS processingState, COUNT(*) AS count
      FROM apple_server_notification_inbox AS inbox
      INNER JOIN apple_subscription_transactions AS tx
        ON tx.studioId = :studioId
       AND (
            (inbox.transactionId IS NOT NULL AND inbox.transactionId = tx.transactionId)
         OR (inbox.originalTransactionId IS NOT NULL AND inbox.originalTransactionId = tx.originalTransactionId)
       )
      GROUP BY inbox.processingState
    `,
    {
      replacements: { studioId },
    }
  );

  return rows || [];
}

async function getGoogleInboxHealthByStudio(studioId) {
  const [rows] = await sequelize.query(
    `
      SELECT inbox.processingState AS processingState, COUNT(*) AS count
      FROM google_pubsub_notification_inbox AS inbox
      INNER JOIN google_play_subscription_transactions AS tx
        ON tx.studioId = :studioId
       AND inbox.purchaseToken IS NOT NULL
       AND inbox.purchaseToken = tx.purchaseToken
      GROUP BY inbox.processingState
    `,
    {
      replacements: { studioId },
    }
  );

  return rows || [];
}

async function getStudioSubscriptionOverview(studioId) {
  const normalizedStudioId = parsePositiveInteger(studioId, 'studioId');

  const studio = await Studio.findByPk(normalizedStudioId, {
    attributes: ['id', 'subscriptionStatus', 'subscriptionPlan', 'trialEndsAt'],
  });

  if (!studio) {
    return null;
  }

  const [
    entitlements,
    latestManualOverride,
    activeManualOverride,
    accessDecision,
    appleTransactionCount,
    latestAppleTransaction,
    appleInboxHealthRows,
    googleTransactionCount,
    latestGoogleTransaction,
    googleInboxHealthRows,
  ] = await Promise.all([
    StudioSubscriptionEntitlement.findAll({
      where: { studioId: normalizedStudioId },
      attributes: [
        'provider',
        'plan',
        'normalizedStatus',
        'environment',
        'currentPeriodStart',
        'currentPeriodEnd',
        'autoRenewEnabled',
        'sourceLastUpdate',
        'providerEventTime',
        'updatedAt',
      ],
      order: [
        ['updatedAt', 'DESC'],
        ['id', 'DESC'],
      ],
    }),
    StudioManualSubscriptionOverride.findOne({
      where: { studioId: normalizedStudioId },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
    }),
    StudioManualSubscriptionOverride.findOne({
      where: {
        studioId: normalizedStudioId,
        revokedAt: null,
      },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
    }),
    resolveSubscriptionAccessDecision({
      studioId: normalizedStudioId,
      now: new Date(),
    }),
    AppleSubscriptionTransaction.count({ where: { studioId: normalizedStudioId } }),
    AppleSubscriptionTransaction.findOne({
      where: { studioId: normalizedStudioId },
      attributes: [
        'id',
        'studioId',
        'environment',
        'originalTransactionId',
        'transactionId',
        'productId',
        'subscriptionGroupIdentifier',
        'purchaseDate',
        'originalPurchaseDate',
        'expiresDate',
        'revocationDate',
        'autoRenewStatus',
        'notificationType',
        'notificationSubtype',
        'providerEventTime',
        'ingestedAt',
        'createdAt',
        'updatedAt',
      ],
      order: [
        ['ingestedAt', 'DESC'],
        ['id', 'DESC'],
      ],
    }),
    getAppleInboxHealthByStudio(normalizedStudioId),
    GooglePlaySubscriptionTransaction.count({ where: { studioId: normalizedStudioId } }),
    GooglePlaySubscriptionTransaction.findOne({
      where: { studioId: normalizedStudioId },
      attributes: [
        'id',
        'studioId',
        'environment',
        'packageName',
        'productId',
        'basePlanId',
        'offerId',
        'latestSuccessfulOrderId',
        'subscriptionState',
        'acknowledgementState',
        'autoRenewEnabled',
        'startTime',
        'expiryTime',
        'testPurchaseFlag',
        'providerEventTime',
        'ingestedAt',
        'createdAt',
        'updatedAt',
      ],
      order: [
        ['ingestedAt', 'DESC'],
        ['id', 'DESC'],
      ],
    }),
    getGoogleInboxHealthByStudio(normalizedStudioId),
  ]);

  return {
    studioRuntime: {
      studioId: studio.id,
      subscriptionStatus: studio.subscriptionStatus,
      subscriptionPlan: studio.subscriptionPlan,
      trialEndsAt: studio.trialEndsAt,
    },
    entitlementSummary: (entitlements || []).map(sanitizeEntitlement),
    manualOverride: {
      latest: sanitizeManualOverride(latestManualOverride),
      activeUnrevoked: sanitizeManualOverride(activeManualOverride),
      latestState: evaluateManualOverrideState(latestManualOverride, new Date()),
    },
    accessDecision: {
      decisionSource: accessDecision ? accessDecision.decisionSource : null,
      operationalAccess: accessDecision ? Boolean(accessDecision.operationalAccess) : false,
      normalizedStatus: accessDecision && typeof accessDecision.normalizedStatus === 'string'
        ? accessDecision.normalizedStatus
        : null,
      subscriptionStatus: accessDecision && typeof accessDecision.subscriptionStatus === 'string'
        ? accessDecision.subscriptionStatus
        : null,
      trialExpired: accessDecision && typeof accessDecision.trialExpired === 'boolean'
        ? accessDecision.trialExpired
        : null,
    },
    apple: {
      transactionCount: Number(appleTransactionCount || 0),
      latestTransaction: sanitizeAppleTransaction(latestAppleTransaction),
      notificationInboxHealth: groupCountRows(appleInboxHealthRows, 'processingState', 'count'),
    },
    googlePlay: {
      transactionCount: Number(googleTransactionCount || 0),
      latestTransaction: sanitizeGoogleTransaction(latestGoogleTransaction),
      notificationInboxHealth: groupCountRows(googleInboxHealthRows, 'processingState', 'count'),
    },
  };
}

module.exports = {
  getStudioSubscriptionOverview,
  sanitizeEntitlement,
  sanitizeAppleTransaction,
  sanitizeGoogleTransaction,
};