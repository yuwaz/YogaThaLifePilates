const {
  generateStudioCodeBase,
  isValidStudioCode,
  normalizeStudioCode,
} = require('../models/studioMetadata');

function buildCandidateCode(base, suffix) {
  if (suffix === 1) {
    return base;
  }

  return `${base}-${suffix}`;
}

function allocateStudioCodeFromBases(bases, usedCodes) {
  for (const rawBase of bases) {
    const base = normalizeStudioCode(rawBase);
    if (!isValidStudioCode(base)) {
      continue;
    }

    for (let suffix = 1; suffix <= 999; suffix += 1) {
      const candidate = buildCandidateCode(base, suffix);
      if (!usedCodes.has(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function allocateRegistrationStudioCode(studioName, usedCodes) {
  const base = generateStudioCodeBase(studioName);
  if (!isValidStudioCode(base)) {
    return null;
  }

  return allocateStudioCodeFromBases([base], usedCodes);
}

function allocateBackfillStudioCode(studio, usedCodes) {
  const nameBase = generateStudioCodeBase(studio.name);
  const fallbackBase = `studio-${studio.id}`;

  const preferredBases = studio.id === 1
    ? ['yogatha', nameBase, fallbackBase]
    : [nameBase, fallbackBase];

  return allocateStudioCodeFromBases(preferredBases, usedCodes);
}

module.exports = {
  allocateStudioCodeFromBases,
  allocateRegistrationStudioCode,
  allocateBackfillStudioCode,
};
