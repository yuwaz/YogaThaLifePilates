const {
  resolveSubscriptionAccessDecision,
} = require('../services/subscriptionAccessService');

function sendSubscriptionRequired(res, decision) {
  return res.status(402).json({
    error: 'SUBSCRIPTION_REQUIRED',
    code: 'SUBSCRIPTION_REQUIRED',
    subscriptionStatus: decision && typeof decision.subscriptionStatus === 'string'
      ? decision.subscriptionStatus
      : null,
    normalizedStatus: decision && typeof decision.normalizedStatus === 'string'
      ? decision.normalizedStatus
      : null,
    trialExpired: decision && typeof decision.trialExpired === 'boolean'
      ? decision.trialExpired
      : null,
    recoveryAllowed: true,
  });
}

function sendSubscriptionCheckUnavailable(res) {
  return res.status(503).json({
    error: 'SUBSCRIPTION_CHECK_UNAVAILABLE',
    code: 'SUBSCRIPTION_CHECK_UNAVAILABLE',
  });
}

async function requireActiveSubscription(req, res, next) {
  try {
    if (!req || !req.user) {
      return res.sendStatus(401);
    }

    const studioId = req.user.studioId;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return sendSubscriptionCheckUnavailable(res);
    }

    const authContext = req && req.authContext && typeof req.authContext === 'object'
      ? req.authContext
      : null;

    const hasExplicitStudioContext = Boolean(
      authContext
      && authContext.hasExplicitStudioContext === true
      && authContext.studioIdSource === 'token'
    );

    if (!hasExplicitStudioContext) {
      return sendSubscriptionCheckUnavailable(res);
    }

    const decision = await resolveSubscriptionAccessDecision({
      studioId,
      now: new Date(),
    });

    if (!decision || decision.checkUnavailable || decision.ok !== true) {
      return sendSubscriptionCheckUnavailable(res);
    }

    req.subscriptionAccessDecision = decision;

    if (decision.operationalAccess) {
      return next();
    }

    return sendSubscriptionRequired(res, decision);
  } catch (err) {
    return sendSubscriptionCheckUnavailable(res);
  }
}

module.exports = requireActiveSubscription;