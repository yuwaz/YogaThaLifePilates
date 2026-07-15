const { Studio } = require('../models');
const { ONBOARDING_STEPS } = require('../models/studioMetadata');

function toOnboardingResponse(studio) {
  return {
    studioId: studio.id,
    onboardingCompleted: Boolean(studio.onboardingCompleted),
    onboardingStep: studio.onboardingStep,
  };
}

async function getScopedStudio(req) {
  const studioId = req.user && req.user.studioId;
  if (!Number.isInteger(studioId) || studioId <= 0) {
    return null;
  }

  const studio = await Studio.findOne({ where: { id: studioId } });
  return studio;
}

exports.getStudioOnboarding = async (req, res) => {
  try {
    const studio = await getScopedStudio(req);
    if (!studio) return res.status(404).json({ error: 'Not found' });
    return res.json(toOnboardingResponse(studio));
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
};

exports.updateStudioOnboarding = async (req, res) => {
  try {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'studioId')) {
      return res.status(400).json({ error: 'Invalid field types' });
    }

    const studio = await getScopedStudio(req);
    if (!studio) return res.status(404).json({ error: 'Not found' });

    const hasStep = req.body && Object.prototype.hasOwnProperty.call(req.body, 'onboardingStep');
    const hasCompleted = req.body && Object.prototype.hasOwnProperty.call(req.body, 'onboardingCompleted');

    if (!hasStep && !hasCompleted) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let nextStep = studio.onboardingStep;
    let nextCompleted = Boolean(studio.onboardingCompleted);

    if (hasStep) {
      if (typeof req.body.onboardingStep !== 'string') {
        return res.status(400).json({ error: 'Invalid field types' });
      }
      const normalizedStep = req.body.onboardingStep.trim();
      if (!ONBOARDING_STEPS.includes(normalizedStep)) {
        return res.status(400).json({ error: 'Invalid field types' });
      }
      nextStep = normalizedStep;
    }

    if (hasCompleted) {
      if (typeof req.body.onboardingCompleted !== 'boolean') {
        return res.status(400).json({ error: 'Invalid field types' });
      }
      nextCompleted = req.body.onboardingCompleted;
    }

    const isCurrentlyCompleted = Boolean(studio.onboardingCompleted) || studio.onboardingStep === 'completed';
    if (isCurrentlyCompleted) {
      if ((hasCompleted && req.body.onboardingCompleted === false) || (hasStep && nextStep !== 'completed')) {
        return res.status(400).json({ error: 'Invalid field types' });
      }
    }

    if (hasCompleted && req.body.onboardingCompleted === true) {
      nextStep = 'completed';
      nextCompleted = true;
    }

    if (hasStep && nextStep === 'completed') {
      nextCompleted = true;
    }

    if (hasCompleted && req.body.onboardingCompleted === false && hasStep && nextStep === 'completed') {
      return res.status(400).json({ error: 'Invalid field types' });
    }

    studio.onboardingCompleted = nextCompleted;
    studio.onboardingStep = nextStep;
    await studio.save();

    return res.json(toOnboardingResponse(studio));
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
};
