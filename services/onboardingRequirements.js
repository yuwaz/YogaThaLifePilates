const {
  Salon,
  MemberType,
  PaymentMethod,
  Equipment,
  User,
} = require('../models');

const REQUIREMENT_CODES = Object.freeze({
  salon: 'salon_required',
  member_types: 'member_type_required',
  payment_methods: 'payment_method_required',
  equipment: 'equipment_required',
  users: 'user_required',
});

async function hasAtLeastOne(model, studioId, transaction) {
  const count = await model.count({
    where: { studioId },
    transaction,
  });

  return count >= 1;
}

async function validateOnboardingTransitionRequirements({
  studioId,
  currentStep,
  requestedStep,
  transaction,
}) {
  if (currentStep === requestedStep) {
    return { ok: true };
  }

  if (currentStep === 'studio' && requestedStep === 'salon') {
    return { ok: true };
  }

  if (currentStep === 'salon' && requestedStep === 'member_types') {
    const ok = await hasAtLeastOne(Salon, studioId, transaction);
    return ok
      ? { ok: true }
      : { ok: false, requiredStep: 'salon', missingRequirement: REQUIREMENT_CODES.salon };
  }

  if (currentStep === 'member_types' && requestedStep === 'payment_methods') {
    const ok = await hasAtLeastOne(MemberType, studioId, transaction);
    return ok
      ? { ok: true }
      : { ok: false, requiredStep: 'member_types', missingRequirement: REQUIREMENT_CODES.member_types };
  }

  if (currentStep === 'payment_methods' && requestedStep === 'equipment') {
    const ok = await hasAtLeastOne(PaymentMethod, studioId, transaction);
    return ok
      ? { ok: true }
      : { ok: false, requiredStep: 'payment_methods', missingRequirement: REQUIREMENT_CODES.payment_methods };
  }

  if (currentStep === 'equipment' && requestedStep === 'users') {
    const ok = await hasAtLeastOne(Equipment, studioId, transaction);
    return ok
      ? { ok: true }
      : { ok: false, requiredStep: 'equipment', missingRequirement: REQUIREMENT_CODES.equipment };
  }

  if (currentStep === 'users' && requestedStep === 'completed') {
    const ok = await hasAtLeastOne(User, studioId, transaction);
    return ok
      ? { ok: true }
      : { ok: false, requiredStep: 'users', missingRequirement: REQUIREMENT_CODES.users };
  }

  return { ok: true };
}

module.exports = {
  REQUIREMENT_CODES,
  validateOnboardingTransitionRequirements,
};
