const { Op } = require('sequelize');
const {
  sequelize,
  SubscriptionPurchaseIntent,
  StudioSubscriptionEntitlement,
  AppleSubscriptionTransaction,
} = require('../models');
const {
  getAppleProductConfiguration,
  validateAppleProductConfiguration,
  getAppleProductPlan,
} = require('../models/appleSubscriptionMetadata');
const {
  validateApplePurchaseIntentForVerification,
  isValidAppAccountToken,
  normalizeAppleEnvironment,
} = require('./appleSubscriptionService');
const subscriptionService = require('./subscriptionService');
const {
  verifyAndDecodeTransaction,
  AppleVerifierConfigurationError,
  AppleVerifierError,
} = require('./appleSignedDataVerifier');

const MAX_SIGNED_TRANSACTION_INFO_LENGTH = 32768;

class ApplePurchaseVerificationError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = 'ApplePurchaseVerificationError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function isCompactJws(value) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function validateVerifyRequest({ purchaseIntentId, signedTransactionInfo }) {
  if (!Number.isInteger(purchaseIntentId) || purchaseIntentId <= 0) {
    throw new ApplePurchaseVerificationError(
      'INVALID_PURCHASE_VERIFICATION_REQUEST',
      'purchaseIntentId must be a positive integer',
      400
    );
  }

  if (typeof signedTransactionInfo !== 'string') {
    throw new ApplePurchaseVerificationError(
      'INVALID_PURCHASE_VERIFICATION_REQUEST',
      'signedTransactionInfo must be a string',
      400
    );
  }

  const normalizedSigned = signedTransactionInfo.trim();
  if (!normalizedSigned) {
    throw new ApplePurchaseVerificationError(
      'INVALID_PURCHASE_VERIFICATION_REQUEST',
      'signedTransactionInfo is required',
      400
    );
  }

  if (normalizedSigned.length > MAX_SIGNED_TRANSACTION_INFO_LENGTH) {
    throw new ApplePurchaseVerificationError(
      'INVALID_PURCHASE_VERIFICATION_REQUEST',
      'signedTransactionInfo is too large',
      400
    );
  }

  if (!isCompactJws(normalizedSigned)) {
    throw new ApplePurchaseVerificationError(
      'APPLE_TRANSACTION_VERIFICATION_FAILED',
      'signedTransactionInfo is malformed',
      400
    );
  }

  return normalizedSigned;
}

function toDateFromMillis(value) {
  if (typeof value === 'undefined' || value === null) {
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

function toCanonicalUuid(value) {
  if (!isValidAppAccountToken(value)) {
    return null;
  }

  return value.trim().toLowerCase();
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

  const mapped = raw
    .split(',')
    .map((item) => normalizeAllowedEnvironmentValue(item))
    .filter(Boolean);

  if (mapped.length === 0) {
    throw new ApplePurchaseVerificationError(
      'APPLE_TRANSACTION_ENVIRONMENT_NOT_ALLOWED',
      'No valid Apple environments are allowed',
      400
    );
  }

  return new Set(mapped);
}

function normalizeVerifiedTransaction(decodedTransaction, now = new Date()) {
  const environment = normalizeAppleEnvironment(decodedTransaction.environment);
  if (!environment) {
    throw new ApplePurchaseVerificationError(
      'APPLE_TRANSACTION_ENVIRONMENT_NOT_ALLOWED',
      'Apple transaction environment is invalid',
      400
    );
  }

  const transactionId = typeof decodedTransaction.transactionId === 'string'
    ? decodedTransaction.transactionId.trim()
    : '';
  if (!transactionId) {
    throw new ApplePurchaseVerificationError(
      'APPLE_TRANSACTION_VERIFICATION_FAILED',
      'Apple transactionId is missing',
      400
    );
  }

  const originalTransactionId = typeof decodedTransaction.originalTransactionId === 'string'
    ? decodedTransaction.originalTransactionId.trim()
    : '';
  if (!originalTransactionId) {
    throw new ApplePurchaseVerificationError(
      'APPLE_TRANSACTION_VERIFICATION_FAILED',
      'Apple originalTransactionId is missing',
      400
    );
  }

  const productId = typeof decodedTransaction.productId === 'string'
    ? decodedTransaction.productId.trim()
    : '';
  if (!productId) {
    throw new ApplePurchaseVerificationError(
      'APPLE_PRODUCT_NOT_ALLOWED',
      'Apple productId is missing',
      400
    );
  }

  const appAccountToken = toCanonicalUuid(decodedTransaction.appAccountToken);
  if (!appAccountToken) {
    throw new ApplePurchaseVerificationError(
      'APPLE_APP_ACCOUNT_TOKEN_MISMATCH',
      'Apple appAccountToken is invalid',
      409
    );
  }

  const expiresDate = toDateFromMillis(decodedTransaction.expiresDate);
  if (!expiresDate) {
    throw new ApplePurchaseVerificationError(
      'APPLE_TRANSACTION_VERIFICATION_FAILED',
      'Apple expiresDate is missing or invalid',
      400
    );
  }

  const purchaseDate = toDateFromMillis(decodedTransaction.purchaseDate);
  const originalPurchaseDate = toDateFromMillis(decodedTransaction.originalPurchaseDate);
  const revocationDate = toDateFromMillis(decodedTransaction.revocationDate);
  const signedDate = toDateFromMillis(decodedTransaction.signedDate);

  const explicitFreeTrial = decodedTransaction.offerDiscountType === 'FREE_TRIAL';
  let normalizedStatus;
  if (revocationDate) {
    normalizedStatus = 'revoked';
  } else if (expiresDate.getTime() <= now.getTime()) {
    normalizedStatus = 'expired';
  } else if (explicitFreeTrial) {
    normalizedStatus = 'trialing';
  } else {
    normalizedStatus = 'active';
  }

  return {
    environment,
    transactionId,
    originalTransactionId,
    productId,
    appAccountToken,
    purchaseDate,
    originalPurchaseDate,
    expiresDate,
    revocationDate,
    signedDate,
    subscriptionGroupIdentifier: typeof decodedTransaction.subscriptionGroupIdentifier === 'string'
      ? decodedTransaction.subscriptionGroupIdentifier.trim() || null
      : null,
    explicitFreeTrial,
    normalizedStatus,
    providerEventTime: signedDate || purchaseDate || expiresDate,
  };
}

function mapVerifiedProductToPlan(productId) {
  const productConfig = getAppleProductConfiguration();
  const configValidation = validateAppleProductConfiguration(productConfig, { requireConfigured: true });
  if (!configValidation.isValid) {
    throw new ApplePurchaseVerificationError('APPLE_PRODUCT_NOT_ALLOWED', 'Apple product configuration is invalid', 400);
  }

  const mappedPlan = getAppleProductPlan(productId, productConfig);
  if (!mappedPlan) {
    throw new ApplePurchaseVerificationError('APPLE_PRODUCT_NOT_ALLOWED', 'Apple product is not allowed', 400);
  }

  return mappedPlan;
}

function isEntitlementStatusEffective(status) {
  return subscriptionService.isEffectiveEntitlementStatus(status);
}

function shouldApplyEntitlementUpdate(existingEntitlement, candidateEntitlement) {
  if (!existingEntitlement) {
    return true;
  }

  const existingEventTime = existingEntitlement.providerEventTime
    || existingEntitlement.currentPeriodEnd
    || existingEntitlement.updatedAt
    || null;
  const candidateEventTime = candidateEntitlement.providerEventTime
    || candidateEntitlement.currentPeriodEnd
    || null;

  const existingPeriodEnd = existingEntitlement.currentPeriodEnd || null;
  const candidatePeriodEnd = candidateEntitlement.currentPeriodEnd || null;

  if (candidateEntitlement.normalizedStatus === 'revoked') {
    if (existingEntitlement.revokedAt && candidateEntitlement.revokedAt) {
      return candidateEntitlement.revokedAt.getTime() >= existingEntitlement.revokedAt.getTime();
    }
    if (existingEventTime && candidateEventTime) {
      return candidateEventTime.getTime() >= existingEventTime.getTime();
    }
    return true;
  }

  if (existingPeriodEnd && candidatePeriodEnd && candidatePeriodEnd.getTime() < existingPeriodEnd.getTime()) {
    return false;
  }

  if (existingEventTime && candidateEventTime && candidateEventTime.getTime() < existingEventTime.getTime()) {
    if (!(existingPeriodEnd && candidatePeriodEnd && candidatePeriodEnd.getTime() > existingPeriodEnd.getTime())) {
      return false;
    }
  }

  return true;
}

function toSafeVerifiedPurchaseResponse(entitlement) {
  return {
    provider: entitlement.provider,
    plan: entitlement.plan,
    status: entitlement.normalizedStatus,
    environment: entitlement.environment,
    currentPeriodEnd: entitlement.currentPeriodEnd ? entitlement.currentPeriodEnd.toISOString() : null,
    trialEndsAt: entitlement.trialEndsAt ? entitlement.trialEndsAt.toISOString() : null,
    autoRenewEnabled: entitlement.autoRenewEnabled,
  };
}

async function resolveIdempotentConsumedIntentResult({
  studioId,
  intent,
  verified,
  transaction,
}) {
  const existingLedgerRow = await AppleSubscriptionTransaction.findOne({
    where: {
      environment: verified.environment === 'sandbox' ? 'Sandbox' : 'Production',
      transactionId: verified.transactionId,
    },
    transaction,
  });

  if (!existingLedgerRow || existingLedgerRow.studioId !== studioId) {
    throw new ApplePurchaseVerificationError('APPLE_PURCHASE_INTENT_ALREADY_CONSUMED', 'Purchase intent already consumed', 409);
  }

  const intentToken = toCanonicalUuid(intent.appAccountToken);
  if (!intentToken || intentToken !== verified.appAccountToken || toCanonicalUuid(existingLedgerRow.appAccountToken) !== verified.appAccountToken) {
    throw new ApplePurchaseVerificationError('APPLE_APP_ACCOUNT_TOKEN_MISMATCH', 'Apple appAccountToken mismatch', 409);
  }

  const entitlement = await StudioSubscriptionEntitlement.findOne({
    where: {
      studioId,
      provider: 'apple',
      environment: verified.environment,
      providerSubscriptionId: verified.originalTransactionId,
    },
    transaction,
  });

  if (!entitlement) {
    throw new ApplePurchaseVerificationError('APPLE_PURCHASE_INTENT_ALREADY_CONSUMED', 'Purchase intent already consumed', 409);
  }

  return {
    verifiedPurchase: toSafeVerifiedPurchaseResponse(entitlement),
  };
}

function mapVerifierError(error) {
  if (error instanceof AppleVerifierConfigurationError) {
    return new ApplePurchaseVerificationError('APPLE_PURCHASE_VERIFICATION_FAILED', 'Purchase verification configuration is invalid', 500);
  }

  if (error instanceof AppleVerifierError) {
    const map = {
      APPLE_BUNDLE_ID_MISMATCH: ['APPLE_TRANSACTION_APP_MISMATCH', 400],
      APPLE_APP_ID_MISMATCH: ['APPLE_TRANSACTION_APP_MISMATCH', 400],
      APPLE_ENVIRONMENT_NOT_ALLOWED: ['APPLE_TRANSACTION_ENVIRONMENT_NOT_ALLOWED', 400],
      APPLE_PRODUCT_NOT_ALLOWED: ['APPLE_PRODUCT_NOT_ALLOWED', 400],
      APPLE_APP_ACCOUNT_TOKEN_INVALID: ['APPLE_APP_ACCOUNT_TOKEN_MISMATCH', 409],
      APPLE_TRANSACTION_VERIFICATION_FAILED: ['APPLE_TRANSACTION_VERIFICATION_FAILED', 400],
      APPLE_TRANSACTION_ID_INVALID: ['APPLE_TRANSACTION_VERIFICATION_FAILED', 400],
      APPLE_ORIGINAL_TRANSACTION_ID_INVALID: ['APPLE_TRANSACTION_VERIFICATION_FAILED', 400],
      APPLE_SIGNED_TRANSACTION_REQUIRED: ['INVALID_PURCHASE_VERIFICATION_REQUEST', 400],
    };

    const [code, status] = map[error.code] || ['APPLE_TRANSACTION_VERIFICATION_FAILED', 400];
    return new ApplePurchaseVerificationError(code, 'Apple transaction verification failed', status);
  }

  return new ApplePurchaseVerificationError('APPLE_PURCHASE_VERIFICATION_FAILED', 'Apple purchase verification failed', 500);
}

function isEntitlementUniquenessConflict(error) {
  const message = error && typeof error.message === 'string' ? error.message : '';
  return message.includes('studio_subscription_entitlements_one_effective_per_studio_unique')
    || message.includes('studio_subscription_entitlements_provider_subscription_unique');
}

async function verifyApplePurchaseForStudio({
  studioId,
  userId,
  purchaseIntentId,
  signedTransactionInfo,
  now = new Date(),
  verifyTransactionFn,
} = {}) {
  if (!Number.isInteger(studioId) || studioId <= 0) {
    throw new ApplePurchaseVerificationError('INVALID_PURCHASE_VERIFICATION_REQUEST', 'Studio is invalid', 400);
  }

  const normalizedSignedTransactionInfo = validateVerifyRequest({
    purchaseIntentId,
    signedTransactionInfo,
  });

  const ownedIntent = await SubscriptionPurchaseIntent.findOne({
    where: {
      id: purchaseIntentId,
      studioId,
      provider: 'apple',
    },
    attributes: ['id', 'studioId', 'provider', 'targetPlan', 'status', 'expiresAt', 'consumedAt', 'appAccountToken'],
  });

  if (!ownedIntent) {
    throw new ApplePurchaseVerificationError('APPLE_PURCHASE_INTENT_NOT_FOUND', 'Apple purchase intent was not found', 404);
  }

  const verifyFn = typeof verifyTransactionFn === 'function' ? verifyTransactionFn : verifyAndDecodeTransaction;

  let decodedTransaction;
  try {
    decodedTransaction = await verifyFn(normalizedSignedTransactionInfo);
  } catch (error) {
    throw mapVerifierError(error);
  }

  const verified = normalizeVerifiedTransaction(decodedTransaction, now);

  const allowedEnvironments = parseAllowedEnvironments();
  if (!allowedEnvironments.has(verified.environment)) {
    throw new ApplePurchaseVerificationError(
      'APPLE_TRANSACTION_ENVIRONMENT_NOT_ALLOWED',
      'Apple transaction environment is not allowed',
      400
    );
  }

  const mappedPlan = mapVerifiedProductToPlan(verified.productId);

  return sequelize.transaction(async (transaction) => {
    const intent = await SubscriptionPurchaseIntent.findOne({
      where: {
        id: purchaseIntentId,
        studioId,
        provider: 'apple',
      },
      transaction,
    });

    if (!intent) {
      throw new ApplePurchaseVerificationError('APPLE_PURCHASE_INTENT_NOT_FOUND', 'Apple purchase intent was not found', 404);
    }

    if (intent.status === 'consumed' || intent.consumedAt) {
      return resolveIdempotentConsumedIntentResult({
        studioId,
        intent,
        verified,
        transaction,
      });
    }

    const intentValidation = validateApplePurchaseIntentForVerification(intent, {
      studioId,
      now,
    });

    if (!intentValidation.isValid) {
      const errors = intentValidation.errors || [];
      if (errors.some((item) => item.includes('expired'))) {
        throw new ApplePurchaseVerificationError('APPLE_PURCHASE_INTENT_EXPIRED', 'Apple purchase intent is expired', 409);
      }
      throw new ApplePurchaseVerificationError('APPLE_PURCHASE_INTENT_INVALID', 'Apple purchase intent is invalid', 409);
    }

    if (intent.targetPlan !== mappedPlan) {
      throw new ApplePurchaseVerificationError('APPLE_PURCHASE_PLAN_MISMATCH', 'Apple purchase plan does not match intent plan', 409);
    }

    const intentToken = toCanonicalUuid(intent.appAccountToken);
    if (!intentToken || intentToken !== verified.appAccountToken) {
      throw new ApplePurchaseVerificationError('APPLE_APP_ACCOUNT_TOKEN_MISMATCH', 'Apple appAccountToken does not match intent', 409);
    }

    const existingLedgerByTransaction = await AppleSubscriptionTransaction.findOne({
      where: {
        environment: verified.environment === 'sandbox' ? 'Sandbox' : 'Production',
        transactionId: verified.transactionId,
      },
      transaction,
    });

    if (existingLedgerByTransaction && existingLedgerByTransaction.studioId !== studioId) {
      throw new ApplePurchaseVerificationError('APPLE_TRANSACTION_ALREADY_BOUND', 'Apple transaction is already bound', 409);
    }

    const existingSubscriptionBinding = await StudioSubscriptionEntitlement.findOne({
      where: {
        provider: 'apple',
        environment: verified.environment,
        providerSubscriptionId: verified.originalTransactionId,
      },
      transaction,
    });

    if (existingSubscriptionBinding && existingSubscriptionBinding.studioId !== studioId) {
      throw new ApplePurchaseVerificationError('APPLE_SUBSCRIPTION_ALREADY_BOUND', 'Apple subscription is already bound', 409);
    }

    const candidateEffective = isEntitlementStatusEffective(verified.normalizedStatus);
    if (candidateEffective) {
      const effectiveStatuses = subscriptionService.getEffectiveEntitlementStatuses();
      const effectiveEntitlements = await StudioSubscriptionEntitlement.findAll({
        where: {
          studioId,
          normalizedStatus: {
            [Op.in]: effectiveStatuses,
          },
        },
        transaction,
      });

      for (const effectiveEntitlement of effectiveEntitlements) {
        const sameBinding = effectiveEntitlement.provider === 'apple'
          && effectiveEntitlement.environment === verified.environment
          && effectiveEntitlement.providerSubscriptionId === verified.originalTransactionId;

        if (sameBinding) {
          continue;
        }

        if (effectiveEntitlement.provider !== 'apple') {
          throw new ApplePurchaseVerificationError('OTHER_PROVIDER_ENTITLEMENT_ACTIVE', 'Another provider entitlement is active', 409);
        }

        throw new ApplePurchaseVerificationError('APPLE_OTHER_SUBSCRIPTION_ACTIVE', 'Another Apple subscription entitlement is active', 409);
      }
    }

    let ledgerRow = existingLedgerByTransaction;
    if (!ledgerRow) {
      try {
        ledgerRow = await AppleSubscriptionTransaction.create(
          {
            studioId,
            environment: verified.environment === 'sandbox' ? 'Sandbox' : 'Production',
            originalTransactionId: verified.originalTransactionId,
            transactionId: verified.transactionId,
            productId: verified.productId,
            subscriptionGroupIdentifier: verified.subscriptionGroupIdentifier,
            purchaseDate: verified.purchaseDate,
            originalPurchaseDate: verified.originalPurchaseDate,
            expiresDate: verified.expiresDate,
            revocationDate: verified.revocationDate,
            autoRenewStatus: null,
            signedTransactionInfo: normalizedSignedTransactionInfo,
            signedRenewalInfo: null,
            appAccountToken: verified.appAccountToken,
            notificationType: null,
            notificationSubtype: null,
            providerEventTime: verified.providerEventTime,
            ingestedAt: now,
          },
          { transaction }
        );
      } catch (error) {
        ledgerRow = await AppleSubscriptionTransaction.findOne({
          where: {
            environment: verified.environment === 'sandbox' ? 'Sandbox' : 'Production',
            transactionId: verified.transactionId,
          },
          transaction,
        });

        if (!ledgerRow) {
          throw new ApplePurchaseVerificationError('APPLE_PURCHASE_VERIFICATION_FAILED', 'Apple purchase verification failed', 500);
        }
        if (ledgerRow.studioId !== studioId) {
          throw new ApplePurchaseVerificationError('APPLE_TRANSACTION_ALREADY_BOUND', 'Apple transaction is already bound', 409);
        }
      }
    }

    if (ledgerRow.studioId !== studioId) {
      throw new ApplePurchaseVerificationError('APPLE_TRANSACTION_ALREADY_BOUND', 'Apple transaction is already bound', 409);
    }

    const entitlementCandidate = {
      studioId,
      provider: 'apple',
      plan: mappedPlan,
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
      sourceLastUpdate: 'verify_endpoint',
      environment: verified.environment,
      providerStateVersion: null,
      providerEventTime: verified.providerEventTime,
    };

    let entitlement = existingSubscriptionBinding;
    if (!entitlement) {
      try {
        entitlement = await StudioSubscriptionEntitlement.create(entitlementCandidate, { transaction });
      } catch (error) {
        const reboundEntitlement = await StudioSubscriptionEntitlement.findOne({
          where: {
            provider: 'apple',
            environment: verified.environment,
            providerSubscriptionId: verified.originalTransactionId,
          },
          transaction,
        });

        if (!reboundEntitlement) {
          throw new ApplePurchaseVerificationError('APPLE_PURCHASE_VERIFICATION_FAILED', 'Apple purchase verification failed', 500);
        }

        if (reboundEntitlement.studioId !== studioId) {
          throw new ApplePurchaseVerificationError('APPLE_SUBSCRIPTION_ALREADY_BOUND', 'Apple subscription is already bound', 409);
        }

        entitlement = reboundEntitlement;
      }
    }

    if (entitlement.studioId !== studioId) {
      throw new ApplePurchaseVerificationError('APPLE_SUBSCRIPTION_ALREADY_BOUND', 'Apple subscription is already bound', 409);
    }

    if (shouldApplyEntitlementUpdate(entitlement, entitlementCandidate)) {
      entitlement.set(entitlementCandidate);
      try {
        await entitlement.save({ transaction });
      } catch (error) {
        if (isEntitlementUniquenessConflict(error)) {
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

          const hasOtherProviderActive = effectiveRows.some((row) => row.provider !== 'apple');
          if (hasOtherProviderActive) {
            throw new ApplePurchaseVerificationError('OTHER_PROVIDER_ENTITLEMENT_ACTIVE', 'Another provider entitlement is active', 409);
          }

          const hasDifferentAppleActive = effectiveRows.some((row) => {
            return row.provider === 'apple'
              && row.providerSubscriptionId
              && row.providerSubscriptionId !== verified.originalTransactionId;
          });

          if (hasDifferentAppleActive) {
            throw new ApplePurchaseVerificationError('APPLE_OTHER_SUBSCRIPTION_ACTIVE', 'Another Apple subscription entitlement is active', 409);
          }
        }

        throw error;
      }
    }

    intent.status = 'consumed';
    intent.consumedAt = now;
    await intent.save({ transaction, fields: ['status', 'consumedAt'] });

    await entitlement.reload({ transaction });

    return {
      verifiedPurchase: toSafeVerifiedPurchaseResponse(entitlement),
    };
  }).catch((error) => {
    if (error instanceof ApplePurchaseVerificationError) {
      throw error;
    }

    throw new ApplePurchaseVerificationError(
      'APPLE_PURCHASE_VERIFICATION_FAILED',
      'Apple purchase verification failed',
      500
    );
  });
}

module.exports = {
  ApplePurchaseVerificationError,
  MAX_SIGNED_TRANSACTION_INFO_LENGTH,
  verifyApplePurchaseForStudio,
  validateVerifyRequest,
  normalizeVerifiedTransaction,
  shouldApplyEntitlementUpdate,
};