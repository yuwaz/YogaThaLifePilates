const { Studio } = require('../models');
const { SUBSCRIPTION_STATUSES } = require('../models/studioMetadata');

function buildSubscriptionResponse(studio, now = new Date()) {
  return {
    studioId: studio.id,
    studioName: studio.name,
    subscriptionStatus: studio.subscriptionStatus,
    trialEndsAt: studio.trialEndsAt ? new Date(studio.trialEndsAt).toISOString() : null,
    onboardingCompleted: Boolean(studio.onboardingCompleted),
    onboardingStep: studio.onboardingStep,
    serverTime: now.toISOString(),
  };
}

function toUtcDate(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function calculateDaysRemaining(now, trialEndsAt) {
  if (trialEndsAt === null) {
    return null;
  }

  const remainingMs = trialEndsAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return 0;
  }

  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
}

async function getStatus(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const studio = await Studio.findByPk(studioId);
    if (!studio) {
      return res.status(404).json({ error: 'Not found' });
    }

    const now = new Date();
    const trialEndsAt = toUtcDate(studio.trialEndsAt);
    const subscriptionStatus = typeof studio.subscriptionStatus === 'string'
      ? studio.subscriptionStatus
      : null;
    const onTrial = subscriptionStatus === 'trial';
    const trialExpired = onTrial && trialEndsAt !== null && now.getTime() > trialEndsAt.getTime();

    return res.json({
      subscriptionStatus,
      trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
      onTrial,
      trialExpired,
      daysRemaining: calculateDaysRemaining(now, trialEndsAt),
      onboardingCompleted: Boolean(studio.onboardingCompleted),
      onboardingStep: studio.onboardingStep,
      serverTime: now.toISOString(),
    });
  } catch (error) {
    return res.status(500).json({ error: 'Server error' });
  }
}

function isValidIsoDatetime(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
  if (!isoPattern.test(value)) {
    return false;
  }

  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

function normalizeTrialEndsAt(value) {
  if (value === null) {
    return null;
  }

  if (!isValidIsoDatetime(value)) {
    throw new Error('trialEndsAt must be null or a valid ISO datetime');
  }

  return new Date(value);
}

async function getManagementStatus(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const studio = await Studio.findByPk(studioId);
    if (!studio) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json(buildSubscriptionResponse(studio));
  } catch (error) {
    return res.status(500).json({ error: 'Server error' });
  }
}

async function updateManagementStatus(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const studio = await Studio.findByPk(studioId);
    if (!studio) {
      return res.status(404).json({ error: 'Not found' });
    }

    const updates = {};
    const body = req && req.body && typeof req.body === 'object' ? req.body : {};

    if (Object.prototype.hasOwnProperty.call(body, 'subscriptionStatus')) {
      const status = body.subscriptionStatus;
      if (typeof status !== 'string' || !SUBSCRIPTION_STATUSES.includes(status)) {
        return res.status(400).json({
          error: 'Validation error',
          details: [{ message: 'Invalid subscriptionStatus', path: 'subscriptionStatus', value: status }],
        });
      }
      if (status !== studio.subscriptionStatus) {
        updates.subscriptionStatus = status;
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'trialEndsAt')) {
      try {
        const normalizedTrialEndsAt = normalizeTrialEndsAt(body.trialEndsAt);
        const currentTrialEndsAt = studio.trialEndsAt ? new Date(studio.trialEndsAt).toISOString() : null;
        const nextTrialEndsAt = normalizedTrialEndsAt ? normalizedTrialEndsAt.toISOString() : null;
        if (nextTrialEndsAt !== currentTrialEndsAt) {
          updates.trialEndsAt = normalizedTrialEndsAt;
        }
      } catch (error) {
        return res.status(400).json({
          error: 'Validation error',
          details: [{ message: error.message, path: 'trialEndsAt', value: body.trialEndsAt }],
        });
      }
    }

    if (Object.keys(updates).length > 0) {
      studio.set(updates);
      await studio.save({ fields: Object.keys(updates) });
    }

    await studio.reload();
    return res.json(buildSubscriptionResponse(studio));
  } catch (error) {
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = {
  getStatus,
  getManagementStatus,
  updateManagementStatus,
};