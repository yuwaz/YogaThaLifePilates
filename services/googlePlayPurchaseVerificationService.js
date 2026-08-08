const { Op } = require('sequelize');
const {
  sequelize,
  SubscriptionPurchaseIntent,
  StudioSubscriptionEntitlement,
  GooglePlaySubscriptionTransaction,
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
} = require('../models/googlePlaySubscriptionMetadata');
const {
  validateGooglePlayPurchaseIntentForVerification,
  selectEffectiveGooglePlayLineItem,
  mapGooglePlaySubscriptionV2ToEntitlementInput,
  secureEquals,
} = require('./googlePlaySubscriptionService');

const DEFAULT_GOOGLE_PLAY_ENVIRONMENTS_ALLOWED = Object.freeze(['production']);
const MAX_PURCHASE_TOKEN_LENGTH = 1024;

class GooglePlayPurchaseVerificationError extends Error {
  constructor(code, message, httpStatus = 400, retryable = false) {
    super(message);
    this.name = 'GooglePlayPurchaseVerificationError';
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

function parseAllowedGooglePlayEnvironments(rawValue = process.env.GOOGLE_PLAY_ENVIRONMENTS_ALLOWED) {
  if (rawValue instanceof Set) {
    const normalized = Array.from(rawValue).map((value) => normalizeString(value));
    const invalid = normalized.some((value) => value !== 'test' && value !== 'production');
    if (invalid) {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_CONFIGURATION_FAILED',
        'Google Play verification environments are invalid',
        500
      );
    }

    const values = normalized.filter(Boolean);

    if (values.length === 0) {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_CONFIGURATION_FAILED',
        'Google Play verification environments are invalid',
        500
      );
    }

    return new Set(values);
  }

  if (Array.isArray(rawValue)) {
    const normalized = rawValue.map((value) => normalizeString(value));
    const invalid = normalized.some((value) => value !== 'test' && value !== 'production');
    if (invalid) {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_CONFIGURATION_FAILED',
        'Google Play verification environments are invalid',
        500
      );
    }

    const values = normalized.filter(Boolean);

    if (values.length === 0) {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_CONFIGURATION_FAILED',
        'Google Play verification environments are invalid',
        500
      );
    }

    return new Set(values);
  }

  if (typeof rawValue === 'undefined' || rawValue === null || String(rawValue).trim() === '') {
    return new Set(DEFAULT_GOOGLE_PLAY_ENVIRONMENTS_ALLOWED);
  }

  const parsed = String(rawValue)
    .split(',')
    .map((value) => normalizeString(value))
    .filter(Boolean);

  if (parsed.some((value) => value !== 'test' && value !== 'production')) {
    throw new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_CONFIGURATION_FAILED',
      'Google Play verification environments are invalid',
      500
    );
  }

  if (parsed.length === 0) {
    throw new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_CONFIGURATION_FAILED',
      'Google Play verification environments are invalid',
      500
    );
  }

  return new Set(parsed);
}

function normalizePurchaseToken(value) {
  const token = normalizeString(value);
  if (!token) {
    throw new GooglePlayPurchaseVerificationError(
      'INVALID_PURCHASE_VERIFICATION_REQUEST',
      'purchaseToken is required',
      400
    );
  }

  if (token.length > MAX_PURCHASE_TOKEN_LENGTH) {
    throw new GooglePlayPurchaseVerificationError(
      'INVALID_PURCHASE_VERIFICATION_REQUEST',
      'purchaseToken is too large',
      400
    );
  }

  return token;
}

function toDateOrNull(value) {
  if (!value) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeGoogleApiResponse(response) {
  try {
    return cloneJson(response);
  } catch (error) {
    return {
      kind: response && response.kind ? response.kind : null,
      subscriptionState: response && response.subscriptionState ? response.subscriptionState : null,
    };
  }
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

function isRetryableNetworkError(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  return ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNABORTED'].includes(code);
}

function mapGoogleApiError(error) {
  if (error instanceof GooglePlayConfigurationError) {
    return new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_CONFIGURATION_FAILED',
      'Google Play verification configuration is invalid',
      500
    );
  }

  if (error instanceof GooglePlayNotFoundError) {
    return new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_PURCHASE_NOT_FOUND',
      'Google Play purchase was not found',
      404
    );
  }

  if (error instanceof GooglePlayRateLimitError) {
    return new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_RATE_LIMITED',
      'Google Play verification is rate limited',
      503,
      true
    );
  }

  if (error instanceof GooglePlayRetryableError) {
    return new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_TEMPORARILY_UNAVAILABLE',
      'Google Play verification is temporarily unavailable',
      503,
      true
    );
  }

  if (error instanceof GooglePlayNonRetryableError) {
    return new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_VERIFICATION_FAILED',
      'Google Play verification failed',
      400
    );
  }

  const responseStatus = Number(error && error.response && error.response.status);
  const googleStatus = error && error.response && error.response.data && error.response.data.error && error.response.data.error.status
    ? String(error.response.data.error.status)
    : null;
  const googleReason = error
    && error.response
    && error.response.data
    && error.response.data.error
    && Array.isArray(error.response.data.error.errors)
    && error.response.data.error.errors[0]
    && error.response.data.error.errors[0].reason
    ? String(error.response.data.error.errors[0].reason)
    : null;
  const errorMessage = typeof error?.message === 'string' ? error.message : '';

  if (responseStatus === 401 || googleStatus === 'UNAUTHENTICATED' || googleReason === 'CREDENTIALS_MISSING' || errorMessage.includes('missing required authentication credential')) {
    return new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_CONFIGURATION_FAILED',
      'Google Play verification configuration is invalid',
      500
    );
  }

  if (responseStatus === 403 || googleStatus === 'PERMISSION_DENIED') {
    return new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_PERMISSION_FAILED',
      'Google Play verification permission is denied',
      500
    );
  }

  if (responseStatus === 429 || googleStatus === 'RESOURCE_EXHAUSTED' || googleReason === 'rateLimitExceeded') {
    return new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_RATE_LIMITED',
      'Google Play verification is rate limited',
      503,
      true
    );
  }

  if (responseStatus === 404 || googleStatus === 'NOT_FOUND' || googleReason === 'notFound') {
    return new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_PURCHASE_NOT_FOUND',
      'Google Play purchase was not found',
      404
    );
  }

  if (responseStatus === 400 || googleStatus === 'INVALID_ARGUMENT' || googleReason === 'invalid' || googleReason === 'badRequest') {
    return new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_PURCHASE_TOKEN_INVALID',
      'Google Play purchase token is invalid',
      400
    );
  }

  if (responseStatus >= 500 || googleStatus === 'INTERNAL' || googleStatus === 'UNAVAILABLE' || isRetryableNetworkError(error)) {
    return new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_TEMPORARILY_UNAVAILABLE',
      'Google Play verification is temporarily unavailable',
      503,
      true
    );
  }

  return new GooglePlayPurchaseVerificationError(
    'GOOGLE_PLAY_VERIFICATION_FAILED',
    'Google Play verification failed',
    500
  );
}

function toSafeVerifiedPurchaseResponse(entitlement) {
  return {
    provider: entitlement.provider,
    plan: entitlement.plan,
    status: entitlement.normalizedStatus,
    environment: entitlement.environment,
    currentPeriodEnd: entitlement.currentPeriodEnd ? entitlement.currentPeriodEnd.toISOString() : null,
    trialEndsAt: entitlement.trialEndsAt ? entitlement.trialEndsAt.toISOString() : null,
    autoRenewEnabled: typeof entitlement.autoRenewEnabled === 'boolean' ? entitlement.autoRenewEnabled : null,
  };
}

function buildGooglePlayTransactionSnapshot({
  studioId,
  now,
  mapped,
  apiData,
  purchaseToken,
}) {
  const selectedLineItem = selectEffectiveGooglePlayLineItem(apiData, now);
  const providerEventTime = toDateOrNull(apiData.startTime)
    || toDateOrNull(selectedLineItem && selectedLineItem.expiryTime)
    || now;

  const cancellationContext = {};
  if (apiData.canceledStateContext) {
    cancellationContext.canceledStateContext = apiData.canceledStateContext;
  }
  if (apiData.inGracePeriodStateContext) {
    cancellationContext.inGracePeriodStateContext = apiData.inGracePeriodStateContext;
  }
  if (apiData.onHoldStateContext) {
    cancellationContext.onHoldStateContext = apiData.onHoldStateContext;
  }
  if (apiData.pausedStateContext) {
    cancellationContext.pausedStateContext = apiData.pausedStateContext;
  }

  const rawApiResponse = sanitizeGoogleApiResponse(apiData);

  return {
    studioId,
    environment: mapped.environment,
    packageName: mapped.packageName,
    productId: mapped.providerProductId,
    basePlanId: mapped.basePlanId,
    offerId: mapped.offerId,
    purchaseToken,
    linkedPurchaseToken: mapped.linkedPurchaseToken,
    latestSuccessfulOrderId: mapped.latestSuccessfulOrderId,
    subscriptionState: mapped.subscriptionState,
    acknowledgementState: mapped.acknowledgementState,
    autoRenewEnabled: mapped.autoRenewEnabled,
    startTime: mapped.currentPeriodStart,
    expiryTime: mapped.currentPeriodEnd,
    cancelSurveyResultJson: null,
    cancellationContextJson: Object.keys(cancellationContext).length > 0 ? JSON.stringify(cancellationContext) : null,
    testPurchaseFlag: mapped.testPurchaseFlag,
    externalAccountIdentifier: mapped.externalAccountIdentifier,
    rawApiResponseJson: JSON.stringify(rawApiResponse),
    providerEventTime,
    ingestedAt: now,
  };
}

function shouldApplyGooglePlayTransactionUpdate(existingRow, candidateRow) {
  if (!existingRow) {
    return true;
  }

  const existingEventTime = toDateOrNull(existingRow.providerEventTime) || toDateOrNull(existingRow.updatedAt) || toDateOrNull(existingRow.ingestedAt);
  const candidateEventTime = toDateOrNull(candidateRow.providerEventTime) || toDateOrNull(candidateRow.ingestedAt);
  const existingExpiry = toDateOrNull(existingRow.expiryTime);
  const candidateExpiry = toDateOrNull(candidateRow.expiryTime);

  if (existingEventTime && candidateEventTime && candidateEventTime.getTime() < existingEventTime.getTime()) {
    if (!candidateExpiry || !existingExpiry || candidateExpiry.getTime() <= existingExpiry.getTime()) {
      return false;
    }
  }

  if (existingExpiry && candidateExpiry && candidateExpiry.getTime() < existingExpiry.getTime()) {
    if (!candidateEventTime || !existingEventTime || candidateEventTime.getTime() <= existingEventTime.getTime()) {
      return false;
    }
  }

  return true;
}

function shouldApplyGooglePlayEntitlementUpdate(existingRow, candidateRow) {
  if (!existingRow) {
    return true;
  }

  const existingEventTime = toDateOrNull(existingRow.providerEventTime) || toDateOrNull(existingRow.lastVerifiedAt) || toDateOrNull(existingRow.updatedAt);
  const candidateEventTime = toDateOrNull(candidateRow.providerEventTime) || toDateOrNull(candidateRow.lastVerifiedAt) || toDateOrNull(candidateRow.currentPeriodEnd) || toDateOrNull(candidateRow.currentPeriodStart);
  const existingPeriodEnd = toDateOrNull(existingRow.currentPeriodEnd);
  const candidatePeriodEnd = toDateOrNull(candidateRow.currentPeriodEnd);

  if (existingEventTime && candidateEventTime && candidateEventTime.getTime() < existingEventTime.getTime()) {
    if (!candidatePeriodEnd || !existingPeriodEnd || candidatePeriodEnd.getTime() <= existingPeriodEnd.getTime()) {
      return false;
    }
  }

  if (existingPeriodEnd && candidatePeriodEnd && candidatePeriodEnd.getTime() < existingPeriodEnd.getTime()) {
    if (!candidateEventTime || !existingEventTime || candidateEventTime.getTime() <= existingEventTime.getTime()) {
      return false;
    }
  }

  return true;
}

function normalizeStoredEnvironment(value) {
  return value === 'test' || value === 'production' ? value : null;
}

async function getOwnedPurchaseIntent({ studioId, purchaseIntentId, transaction }) {
  return SubscriptionPurchaseIntent.findOne({
    where: {
      id: purchaseIntentId,
      studioId,
      provider: 'google_play',
    },
    transaction,
  });
}

async function getEffectiveEntitlementForStudio({ studioId, transaction }) {
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

async function getGoogleTransactionBinding({ environment, purchaseToken, transaction }) {
  return GooglePlaySubscriptionTransaction.findOne({
    where: {
      environment,
      purchaseToken,
    },
    transaction,
  });
}

async function getGoogleEntitlementBinding({ environment, purchaseToken, transaction }) {
  return StudioSubscriptionEntitlement.findOne({
    where: {
      provider: 'google_play',
      environment,
      providerSubscriptionId: purchaseToken,
    },
    transaction,
  });
}

function mapIntentValidationError(intentValidation) {
  switch (intentValidation.code) {
    case 'GOOGLE_PLAY_INTENT_EXPIRED':
      return new GooglePlayPurchaseVerificationError('GOOGLE_PLAY_PURCHASE_INTENT_EXPIRED', 'Purchase intent is expired', 409);
    case 'GOOGLE_PLAY_INTENT_CONSUMED':
      return new GooglePlayPurchaseVerificationError('GOOGLE_PLAY_PURCHASE_INTENT_ALREADY_CONSUMED', 'Purchase intent is already consumed', 409);
    default:
      return new GooglePlayPurchaseVerificationError('GOOGLE_PLAY_PURCHASE_INTENT_INVALID', 'Purchase intent is invalid', 409);
  }
}

function resolveGoogleClient(dependencies = {}) {
  if (dependencies.googleClient) {
    return dependencies.googleClient;
  }

  if (typeof dependencies.googleClientFactory === 'function') {
    const client = dependencies.googleClientFactory();
    if (!client || typeof client !== 'object') {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_CONFIGURATION_FAILED',
        'Google Play client factory did not return a client',
        500
      );
    }
    return client;
  }

  return getGooglePlayDeveloperClient().client;
}

function resolveVerificationConfiguration(dependencies = {}) {
  const configSource = dependencies.googlePlayProductConfiguration || getGooglePlayProductConfiguration();
  const validation = validateGooglePlayProductConfiguration(configSource, { requireConfigured: true });
  if (!validation.isValid) {
    throw new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_CONFIGURATION_FAILED',
      'Google Play verification configuration is invalid',
      500
    );
  }

  return {
    productConfiguration: validation.normalized,
    allowedEnvironments: dependencies.allowedEnvironments instanceof Set
      ? dependencies.allowedEnvironments
      : parseAllowedGooglePlayEnvironments(dependencies.allowedEnvironments),
  };
}

async function verifyGooglePlayPurchaseForStudio({
  studioId,
  userId,
  purchaseIntentId,
  purchaseToken,
  now = new Date(),
  dependencies = {},
} = {}) {
  if (!Number.isInteger(studioId) || studioId <= 0) {
    throw new GooglePlayPurchaseVerificationError('INVALID_PURCHASE_VERIFICATION_REQUEST', 'Studio is invalid', 400);
  }

  if (!Number.isInteger(purchaseIntentId) || purchaseIntentId <= 0) {
    throw new GooglePlayPurchaseVerificationError('INVALID_PURCHASE_VERIFICATION_REQUEST', 'purchaseIntentId must be a positive integer', 400);
  }

  const normalizedPurchaseToken = normalizePurchaseToken(purchaseToken);
  const verificationConfiguration = resolveVerificationConfiguration(dependencies);
  const googleClient = resolveGoogleClient(dependencies);

  const intent = await getOwnedPurchaseIntent({ studioId, purchaseIntentId, transaction: null });
  if (!intent) {
    throw new GooglePlayPurchaseVerificationError('GOOGLE_PLAY_PURCHASE_INTENT_NOT_FOUND', 'Google Play purchase intent was not found', 404);
  }

  const intentStatus = normalizeString(intent.status);
  const consumedIntent = intentStatus === 'consumed' || Boolean(intent.consumedAt);
  const expiredIntent = intentStatus === 'expired'
    || (toDateOrNull(intent.expiresAt) && toDateOrNull(intent.expiresAt).getTime() <= now.getTime());

  const intentValidation = validateGooglePlayPurchaseIntentForVerification(intent, {
    studioId,
    now,
  });

  if (!intentValidation.isValid && !consumedIntent) {
    if (expiredIntent) {
      throw new GooglePlayPurchaseVerificationError('GOOGLE_PLAY_PURCHASE_INTENT_EXPIRED', 'Purchase intent is expired', 409);
    }

    throw mapIntentValidationError(intentValidation);
  }

  let apiResponse;
  try {
    apiResponse = await googleClient.purchases.subscriptionsv2.get({
      packageName: verificationConfiguration.productConfiguration.packageName,
      token: normalizedPurchaseToken,
    });
  } catch (error) {
    throw mapGoogleApiError(error);
  }

  const apiData = extractGoogleApiData(apiResponse);
  const mapped = mapGooglePlaySubscriptionV2ToEntitlementInput({
    response: apiData,
    purchaseToken: normalizedPurchaseToken,
    expectedPackageName: verificationConfiguration.productConfiguration.packageName,
    expectedObfuscatedAccountId: intent.googleObfuscatedAccountId,
    config: verificationConfiguration.productConfiguration,
    now,
  });

  if (!mapped.ok) {
    const code = mapped.code || 'GOOGLE_PLAY_VERIFICATION_FAILED';
    if (code === 'GOOGLE_PLAY_ENVIRONMENT_MISMATCH') {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_ENVIRONMENT_NOT_ALLOWED',
        'Google Play purchase environment is not allowed',
        400
      );
    }

    if (code === 'GOOGLE_PLAY_ACCOUNT_ID_MISSING') {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_ACCOUNT_IDENTIFIER_MISSING',
        'Google Play account identifier is missing',
        409
      );
    }

    if (code === 'GOOGLE_PLAY_ACCOUNT_ID_MISMATCH') {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_ACCOUNT_IDENTIFIER_MISMATCH',
        'Google Play account identifier does not match purchase intent',
        409
      );
    }

    if (code === 'GOOGLE_PLAY_PRODUCT_MAPPING_INVALID') {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_PURCHASE_PLAN_MISMATCH',
        'Google Play purchase plan does not match the purchase intent',
        409
      );
    }

    if (code === 'GOOGLE_PLAY_SUBSCRIPTION_STATE_INVALID' || code === 'GOOGLE_PLAY_SUBSCRIPTION_STATE_UNMAPPED') {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_VERIFICATION_FAILED',
        'Google Play subscription state is unsupported',
        400
      );
    }

    if (code === 'GOOGLE_PLAY_LINE_ITEM_MISSING') {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_VERIFICATION_FAILED',
        'Google Play response did not include a valid line item',
        400
      );
    }

    throw new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_VERIFICATION_FAILED',
      'Google Play verification failed',
      400
    );
  }

  if (!verificationConfiguration.allowedEnvironments.has(mapped.value.environment)) {
    throw new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_ENVIRONMENT_NOT_ALLOWED',
      'Google Play purchase environment is not allowed',
      400
    );
  }

  if (!mapped.value.plan || mapped.value.plan !== intent.targetPlan) {
    throw new GooglePlayPurchaseVerificationError(
      'GOOGLE_PLAY_PURCHASE_PLAN_MISMATCH',
      'Google Play purchase plan does not match the purchase intent',
      409
    );
  }

  const candidateEffective = subscriptionService.isEffectiveEntitlementStatus(mapped.value.normalizedStatus);
  const candidateTransactionSnapshot = buildGooglePlayTransactionSnapshot({
    studioId,
    now,
    mapped: mapped.value,
    apiData,
    purchaseToken: normalizedPurchaseToken,
  });

  return sequelize.transaction(async (transaction) => {
    const lockedIntent = await getOwnedPurchaseIntent({ studioId, purchaseIntentId, transaction });
    if (!lockedIntent) {
      throw new GooglePlayPurchaseVerificationError('GOOGLE_PLAY_PURCHASE_INTENT_NOT_FOUND', 'Google Play purchase intent was not found', 404);
    }

    if (lockedIntent.status === 'consumed' || lockedIntent.consumedAt) {
      const existingTransaction = await getGoogleTransactionBinding({
        environment: candidateTransactionSnapshot.environment,
        purchaseToken: normalizedPurchaseToken,
        transaction,
      });

      if (!existingTransaction || existingTransaction.studioId !== studioId) {
        throw new GooglePlayPurchaseVerificationError(
          'GOOGLE_PLAY_PURCHASE_INTENT_ALREADY_CONSUMED',
          'Purchase intent is already consumed',
          409
        );
      }

      const existingEntitlement = await getGoogleEntitlementBinding({
        environment: candidateTransactionSnapshot.environment,
        purchaseToken: normalizedPurchaseToken,
        transaction,
      });

      if (!existingEntitlement || existingEntitlement.studioId !== studioId) {
        throw new GooglePlayPurchaseVerificationError(
          'GOOGLE_PLAY_PURCHASE_INTENT_ALREADY_CONSUMED',
          'Purchase intent is already consumed',
          409
        );
      }

      return {
        verifiedPurchase: toSafeVerifiedPurchaseResponse(existingEntitlement),
      };
    }

    const ownedEffectiveEntitlement = await getEffectiveEntitlementForStudio({ studioId, transaction });
    if (candidateEffective && ownedEffectiveEntitlement) {
      if (ownedEffectiveEntitlement.provider !== 'google_play') {
        throw new GooglePlayPurchaseVerificationError(
          'OTHER_PROVIDER_ENTITLEMENT_ACTIVE',
          'Another provider entitlement is already active for this studio',
          409
        );
      }

      const sameTokenReplacement = normalizeString(ownedEffectiveEntitlement.providerSubscriptionId)
        && normalizeString(mapped.value.linkedPurchaseToken)
        && secureEquals(ownedEffectiveEntitlement.providerSubscriptionId, mapped.value.linkedPurchaseToken);

      const sameTokenBinding = normalizeString(ownedEffectiveEntitlement.providerSubscriptionId)
        && secureEquals(ownedEffectiveEntitlement.providerSubscriptionId, normalizedPurchaseToken);

      if (!sameTokenBinding && !sameTokenReplacement) {
        throw new GooglePlayPurchaseVerificationError(
          'GOOGLE_PLAY_OTHER_SUBSCRIPTION_ACTIVE',
          'Another Google Play subscription is already active for this studio',
          409
        );
      }

      if (sameTokenReplacement && ownedEffectiveEntitlement.providerSubscriptionId !== normalizedPurchaseToken) {
        const replacementStatus = toDateOrNull(ownedEffectiveEntitlement.currentPeriodEnd)
          && ownedEffectiveEntitlement.currentPeriodEnd.getTime() <= now.getTime()
          ? 'expired'
          : 'cancelled';
        await ownedEffectiveEntitlement.update({
          normalizedStatus: replacementStatus,
          sourceLastUpdate: 'verify_endpoint',
          providerEventTime: now,
          lastVerifiedAt: now,
        }, { transaction });
      }
    }

    const existingTransaction = await getGoogleTransactionBinding({
      environment: candidateTransactionSnapshot.environment,
      purchaseToken: normalizedPurchaseToken,
      transaction,
    });

    if (existingTransaction && existingTransaction.studioId !== studioId) {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_PURCHASE_ALREADY_BOUND',
        'Google Play purchase is already bound',
        409
      );
    }

    const existingEntitlement = await getGoogleEntitlementBinding({
      environment: candidateTransactionSnapshot.environment,
      purchaseToken: normalizedPurchaseToken,
      transaction,
    });

    if (existingEntitlement && existingEntitlement.studioId !== studioId) {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_PURCHASE_ALREADY_BOUND',
        'Google Play purchase is already bound',
        409
      );
    }

    const existingEffectiveEntitlementForToken = existingEntitlement
      && subscriptionService.isEffectiveEntitlementStatus(existingEntitlement.normalizedStatus)
      ? existingEntitlement
      : null;

    if (candidateEffective && existingEffectiveEntitlementForToken && existingEffectiveEntitlementForToken.providerSubscriptionId !== normalizedPurchaseToken) {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_SUBSCRIPTION_ALREADY_BOUND',
        'Google Play subscription is already bound',
        409
      );
    }

    if (candidateEffective && existingTransaction && existingTransaction.studioId === studioId && existingEffectiveEntitlementForToken && existingEffectiveEntitlementForToken.providerSubscriptionId !== normalizedPurchaseToken) {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_REPLACEMENT_CONFLICT',
        'Google Play replacement cannot be applied',
        409
      );
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
      providerSubscriptionId: normalizedPurchaseToken,
      currentPeriodStart: mapped.value.currentPeriodStart,
      currentPeriodEnd: mapped.value.currentPeriodEnd,
      trialEndsAt: mapped.value.trialDetectedReliably ? mapped.value.currentPeriodEnd : null,
      autoRenewEnabled: mapped.value.autoRenewEnabled,
      gracePeriodEndsAt: null,
      revokedAt: null,
      refundedAt: null,
      pausedAt: null,
      lastVerifiedAt: now,
      sourceLastUpdate: 'verify_endpoint',
      environment: mapped.value.environment,
      providerStateVersion: normalizeString(apiData.etag),
      providerEventTime: candidateTransactionSnapshot.providerEventTime,
    };

    if (existingEntitlement) {
      if (shouldApplyGooglePlayEntitlementUpdate(existingEntitlement, entitlementSnapshot)) {
        await existingEntitlement.update(entitlementSnapshot, { transaction });
      }
    } else {
      await StudioSubscriptionEntitlement.create(entitlementSnapshot, { transaction });
    }

    await lockedIntent.update({
      status: 'consumed',
      consumedAt: now,
    }, { transaction });

    const verifiedEntitlement = await StudioSubscriptionEntitlement.findOne({
      where: {
        studioId,
        provider: 'google_play',
        environment: mapped.value.environment,
        providerSubscriptionId: normalizedPurchaseToken,
      },
      transaction,
    });

    if (!verifiedEntitlement) {
      throw new GooglePlayPurchaseVerificationError(
        'GOOGLE_PLAY_PURCHASE_VERIFICATION_FAILED',
        'Google Play entitlement could not be persisted',
        500
      );
    }

    return {
      verifiedPurchase: toSafeVerifiedPurchaseResponse(verifiedEntitlement),
    };
  });
}

module.exports = {
  GooglePlayPurchaseVerificationError,
  DEFAULT_GOOGLE_PLAY_ENVIRONMENTS_ALLOWED,
  MAX_PURCHASE_TOKEN_LENGTH,
  parseAllowedGooglePlayEnvironments,
  normalizePurchaseToken,
  sanitizeGoogleApiResponse,
  buildGooglePlayTransactionSnapshot,
  shouldApplyGooglePlayTransactionUpdate,
  shouldApplyGooglePlayEntitlementUpdate,
  mapGoogleApiError,
  mapIntentValidationError,
  verifyGooglePlayPurchaseForStudio,
  toSafeVerifiedPurchaseResponse,
};