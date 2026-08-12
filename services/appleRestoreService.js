const { Op } = require('sequelize');
const {
  sequelize,
  SubscriptionPurchaseIntent,
  StudioSubscriptionEntitlement,
  AppleSubscriptionTransaction,
} = require('../models');
const subscriptionService = require('./subscriptionService');
const {
  getAppleProductConfiguration,
  getAppleProductPlan,
  validateAppleProductConfiguration,
} = require('../models/appleSubscriptionMetadata');
const {
  verifyAndDecodeTransaction,
  AppleVerifierConfigurationError,
  AppleVerifierError,
} = require('./appleSignedDataVerifier');
const {
  normalizeVerifiedTransaction,
  shouldApplyEntitlementUpdate,
  MAX_SIGNED_TRANSACTION_INFO_LENGTH,
} = require('./applePurchaseVerificationService');

class AppleRestoreError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = 'AppleRestoreError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function isCompactJws(value) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function normalizeRestoreRequest(body) {
  const source = body && typeof body === 'object' ? body : {};
  const signedTransactionInfo = typeof source.signedTransactionInfo === 'string'
    ? source.signedTransactionInfo.trim()
    : '';

  if (!signedTransactionInfo) {
    throw new AppleRestoreError('INVALID_RESTORE_REQUEST', 'signedTransactionInfo is required', 400);
  }

  if (signedTransactionInfo.length > MAX_SIGNED_TRANSACTION_INFO_LENGTH) {
    throw new AppleRestoreError('INVALID_RESTORE_REQUEST', 'signedTransactionInfo is too large', 400);
  }

  if (!isCompactJws(signedTransactionInfo)) {
    throw new AppleRestoreError('INVALID_RESTORE_REQUEST', 'signedTransactionInfo must be compact JWS', 400);
  }

  return signedTransactionInfo;
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
    return new Set(['sandbox', 'production']);
  }

  const values = raw
    .split(',')
    .map((value) => normalizeAllowedEnvironmentValue(value))
    .filter(Boolean);

  if (values.length === 0) {
    throw new AppleRestoreError(
      'APPLE_RESTORE_CONFIGURATION_FAILED',
      'Apple restore configuration is invalid',
      500
    );
  }

  return new Set(values);
}

function resolveApplePlan(productId) {
  const validation = validateAppleProductConfiguration(getAppleProductConfiguration(), {
    requireConfigured: true,
  });

  if (!validation.isValid) {
    throw new AppleRestoreError(
      'APPLE_RESTORE_CONFIGURATION_FAILED',
      'Apple restore configuration is invalid',
      500
    );
  }

  const plan = getAppleProductPlan(productId, validation.normalized);
  if (!plan) {
    throw new AppleRestoreError('APPLE_PRODUCT_NOT_ALLOWED', 'Apple product is not allowed', 400);
  }

  return plan;
}

function mapVerifierError(error) {
  if (error instanceof AppleVerifierConfigurationError) {
    return new AppleRestoreError('APPLE_RESTORE_CONFIGURATION_FAILED', 'Apple restore configuration is invalid', 500);
  }

  if (error instanceof AppleVerifierError) {
    const mapped = {
      APPLE_BUNDLE_ID_MISMATCH: ['APPLE_TRANSACTION_APP_MISMATCH', 400],
      APPLE_APP_ID_MISMATCH: ['APPLE_TRANSACTION_APP_MISMATCH', 400],
      APPLE_ENVIRONMENT_NOT_ALLOWED: ['APPLE_TRANSACTION_ENVIRONMENT_NOT_ALLOWED', 400],
      APPLE_PRODUCT_NOT_ALLOWED: ['APPLE_PRODUCT_NOT_ALLOWED', 400],
      APPLE_APP_ACCOUNT_TOKEN_INVALID: ['APPLE_APP_ACCOUNT_TOKEN_INVALID', 400],
      APPLE_TRANSACTION_ID_INVALID: ['APPLE_TRANSACTION_VERIFICATION_FAILED', 400],
      APPLE_ORIGINAL_TRANSACTION_ID_INVALID: ['APPLE_TRANSACTION_VERIFICATION_FAILED', 400],
      APPLE_TRANSACTION_VERIFICATION_FAILED: ['APPLE_TRANSACTION_VERIFICATION_FAILED', 400],
      APPLE_SIGNED_TRANSACTION_REQUIRED: ['INVALID_RESTORE_REQUEST', 400],
    };

    const [code, status] = mapped[error.code] || ['APPLE_TRANSACTION_VERIFICATION_FAILED', 400];
    return new AppleRestoreError(code, 'Apple transaction verification failed', status);
  }

  return new AppleRestoreError('APPLE_RESTORE_FAILED', 'Apple restore failed', 500);
}

function toLedgerEnvironment(environment) {
  return environment === 'sandbox' ? 'Sandbox' : 'Production';
}

async function resolveStudioOwnership({ studioId, verified, transaction }) {
  const ledgerEnvironment = toLedgerEnvironment(verified.environment);

  const transactionBinding = await AppleSubscriptionTransaction.findOne({
    where: {
      environment: ledgerEnvironment,
      transactionId: verified.transactionId,
    },
    transaction,
  });

  if (transactionBinding && transactionBinding.studioId !== studioId) {
    throw new AppleRestoreError('APPLE_TRANSACTION_ALREADY_BOUND', 'Apple transaction is already bound', 409);
  }

  const subscriptionBinding = await StudioSubscriptionEntitlement.findOne({
    where: {
      provider: 'apple',
      environment: verified.environment,
      providerSubscriptionId: verified.originalTransactionId,
    },
    transaction,
  });

  if (subscriptionBinding && subscriptionBinding.studioId !== studioId) {
    throw new AppleRestoreError('APPLE_SUBSCRIPTION_ALREADY_BOUND', 'Apple subscription is already bound', 409);
  }

  const tokenBindings = await SubscriptionPurchaseIntent.findAll({
    where: {
      provider: 'apple',
      appAccountToken: verified.appAccountToken,
    },
    attributes: ['id', 'studioId'],
    transaction,
  });

  const boundStudios = new Set(tokenBindings.map((row) => row.studioId).filter((id) => Number.isInteger(id) && id > 0));
  if (boundStudios.size > 1) {
    throw new AppleRestoreError('APPLE_RESTORE_BINDING_CONFLICT', 'Apple restore binding is ambiguous', 409);
  }

  if (boundStudios.size === 1 && !boundStudios.has(studioId)) {
    throw new AppleRestoreError('APPLE_APP_ACCOUNT_TOKEN_MISMATCH', 'Apple appAccountToken does not match studio', 409);
  }

  if (boundStudios.size === 0 && !transactionBinding && !subscriptionBinding) {
    throw new AppleRestoreError('APPLE_RESTORE_OWNERSHIP_NOT_FOUND', 'Apple restore ownership cannot be proven', 404);
  }

  return {
    transactionBinding,
    subscriptionBinding,
    ownershipByToken: boundStudios.has(studioId),
  };
}

function toSafeRestoredResponse({ entitlement, alreadyKnown }) {
  return {
    restored: true,
    alreadyKnown,
    provider: 'apple',
    statusRefreshRequired: true,
    normalizedStatus: entitlement.normalizedStatus,
  };
}

async function restoreAppleSubscriptionForStudio({
  studioId,
  body,
  now = new Date(),
  dependencies = {},
} = {}) {
  if (!Number.isInteger(studioId) || studioId <= 0) {
    throw new AppleRestoreError('INVALID_RESTORE_REQUEST', 'Studio context is invalid', 403);
  }

  const signedTransactionInfo = normalizeRestoreRequest(body);

  let decodedTransaction;
  const verifyTransactionFn = typeof dependencies.verifyTransactionFn === 'function'
    ? dependencies.verifyTransactionFn
    : verifyAndDecodeTransaction;
  try {
    decodedTransaction = await verifyTransactionFn(signedTransactionInfo);
  } catch (error) {
    throw mapVerifierError(error);
  }

  const verified = normalizeVerifiedTransaction(decodedTransaction, now);
  const allowedEnvironments = parseAllowedEnvironments();
  if (!allowedEnvironments.has(verified.environment)) {
    throw new AppleRestoreError(
      'APPLE_TRANSACTION_ENVIRONMENT_NOT_ALLOWED',
      'Apple transaction environment is not allowed',
      400
    );
  }

  const plan = resolveApplePlan(verified.productId);

  return sequelize.transaction(async (transaction) => {
    const ownership = await resolveStudioOwnership({
      studioId,
      verified,
      transaction,
    });

    const candidateEffective = subscriptionService.isEffectiveEntitlementStatus(verified.normalizedStatus);
    if (candidateEffective) {
      const effectiveStatuses = subscriptionService.getEffectiveEntitlementStatuses();
      const effectiveRows = await StudioSubscriptionEntitlement.findAll({
        where: {
          studioId,
          normalizedStatus: {
            [Op.in]: effectiveStatuses,
          },
        },
        transaction,
      });

      for (const row of effectiveRows) {
        const sameBinding = row.provider === 'apple'
          && row.environment === verified.environment
          && row.providerSubscriptionId === verified.originalTransactionId;

        if (sameBinding) {
          continue;
        }

        if (row.provider !== 'apple') {
          throw new AppleRestoreError('OTHER_PROVIDER_ENTITLEMENT_ACTIVE', 'Another provider entitlement is already active', 409);
        }

        throw new AppleRestoreError('APPLE_OTHER_SUBSCRIPTION_ACTIVE', 'Another Apple subscription entitlement is already active', 409);
      }
    }

    const ledgerEnvironment = toLedgerEnvironment(verified.environment);
    let ledgerRow = ownership.transactionBinding;
    if (!ledgerRow) {
      try {
        ledgerRow = await AppleSubscriptionTransaction.create({
          studioId,
          environment: ledgerEnvironment,
          originalTransactionId: verified.originalTransactionId,
          transactionId: verified.transactionId,
          productId: verified.productId,
          subscriptionGroupIdentifier: verified.subscriptionGroupIdentifier,
          purchaseDate: verified.purchaseDate,
          originalPurchaseDate: verified.originalPurchaseDate,
          expiresDate: verified.expiresDate,
          revocationDate: verified.revocationDate,
          autoRenewStatus: null,
          signedTransactionInfo,
          signedRenewalInfo: null,
          appAccountToken: verified.appAccountToken,
          notificationType: 'RESTORE',
          notificationSubtype: null,
          providerEventTime: verified.providerEventTime,
          ingestedAt: now,
        }, { transaction });
      } catch (error) {
        const rebound = await AppleSubscriptionTransaction.findOne({
          where: {
            environment: ledgerEnvironment,
            transactionId: verified.transactionId,
          },
          transaction,
        });

        if (!rebound) {
          throw new AppleRestoreError('APPLE_RESTORE_FAILED', 'Apple restore failed', 500);
        }

        if (rebound.studioId !== studioId) {
          throw new AppleRestoreError('APPLE_TRANSACTION_ALREADY_BOUND', 'Apple transaction is already bound', 409);
        }

        ledgerRow = rebound;
      }
    }

    if (ledgerRow.studioId !== studioId) {
      throw new AppleRestoreError('APPLE_TRANSACTION_ALREADY_BOUND', 'Apple transaction is already bound', 409);
    }

    const entitlementCandidate = {
      studioId,
      provider: 'apple',
      plan,
      normalizedStatus: verified.normalizedStatus,
      providerProductId: verified.productId,
      providerSubscriptionId: verified.originalTransactionId,
      currentPeriodStart: verified.purchaseDate,
      currentPeriodEnd: verified.expiresDate,
      trialEndsAt: verified.explicitFreeTrial ? verified.expiresDate : null,
      autoRenewEnabled: null,
      gracePeriodEndsAt: null,
      revokedAt: verified.revocationDate,
      refundedAt: null,
      pausedAt: null,
      lastVerifiedAt: now,
      sourceLastUpdate: 'reconciliation',
      environment: verified.environment,
      providerStateVersion: null,
      providerEventTime: verified.providerEventTime,
    };

    let entitlement = ownership.subscriptionBinding;
    let alreadyKnown = Boolean(entitlement);

    if (!entitlement) {
      try {
        entitlement = await StudioSubscriptionEntitlement.create(entitlementCandidate, { transaction });
        alreadyKnown = false;
      } catch (error) {
        const rebound = await StudioSubscriptionEntitlement.findOne({
          where: {
            provider: 'apple',
            environment: verified.environment,
            providerSubscriptionId: verified.originalTransactionId,
          },
          transaction,
        });

        if (!rebound) {
          throw new AppleRestoreError('APPLE_RESTORE_FAILED', 'Apple restore failed', 500);
        }

        if (rebound.studioId !== studioId) {
          throw new AppleRestoreError('APPLE_SUBSCRIPTION_ALREADY_BOUND', 'Apple subscription is already bound', 409);
        }

        entitlement = rebound;
        alreadyKnown = true;
      }
    }

    if (entitlement.studioId !== studioId) {
      throw new AppleRestoreError('APPLE_SUBSCRIPTION_ALREADY_BOUND', 'Apple subscription is already bound', 409);
    }

    if (shouldApplyEntitlementUpdate(entitlement, entitlementCandidate)) {
      entitlement.set(entitlementCandidate);
      await entitlement.save({ transaction });
    }

    await entitlement.reload({ transaction });

    return toSafeRestoredResponse({
      entitlement,
      alreadyKnown,
    });
  });
}

module.exports = {
  AppleRestoreError,
  restoreAppleSubscriptionForStudio,
};
