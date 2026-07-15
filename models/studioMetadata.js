const SUPPORTED_COUNTRY_CODES = Object.freeze([
  'TR',
  'PL',
  'DE',
  'GB',
  'US',
  'NL',
  'FR',
  'IT',
  'ES',
  'AT',
  'BE',
  'CH',
]);

const SUPPORTED_CURRENCIES = Object.freeze(['TRY', 'EUR', 'USD']);

const SUBSCRIPTION_STATUSES = Object.freeze([
  'trial',
  'active',
  'past_due',
  'suspended',
  'cancelled',
]);

const TURKISH_CHAR_MAP = Object.freeze({
  Ç: 'c',
  Ğ: 'g',
  İ: 'i',
  Ö: 'o',
  Ş: 's',
  Ü: 'u',
  ç: 'c',
  ğ: 'g',
  ı: 'i',
  ö: 'o',
  ş: 's',
  ü: 'u',
});

const ONBOARDING_STEPS = Object.freeze([
  'studio',
  'salon',
  'member_types',
  'payment_methods',
  'equipment',
  'users',
  'completed',
]);

const ONBOARDING_STEP_INDEX = Object.freeze(
  ONBOARDING_STEPS.reduce((acc, step, index) => {
    acc[step] = index;
    return acc;
  }, {})
);

function normalizeUppercaseCode(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.trim().toUpperCase();
}

function isSupportedCountryCode(value) {
  return SUPPORTED_COUNTRY_CODES.includes(value);
}

function isSupportedCurrency(value) {
  return SUPPORTED_CURRENCIES.includes(value);
}

function isSupportedSubscriptionStatus(value) {
  return SUBSCRIPTION_STATUSES.includes(value);
}

function normalizeStudioCode(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value
    .trim()
    .replace(/[ÇĞİÖŞÜçğıöşü]/g, (character) => TURKISH_CHAR_MAP[character] || character)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized;
}

function isValidStudioCode(value) {
  if (typeof value !== 'string') {
    return false;
  }

  if (value.length < 3 || value.length > 40) {
    return false;
  }

  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function generateStudioCodeBase(studioName) {
  return normalizeStudioCode(studioName);
}

function isSupportedOnboardingStep(value) {
  return ONBOARDING_STEPS.includes(value);
}

function getOnboardingStepIndex(value) {
  if (!Object.prototype.hasOwnProperty.call(ONBOARDING_STEP_INDEX, value)) {
    return -1;
  }

  return ONBOARDING_STEP_INDEX[value];
}

function getNextOnboardingStep(value) {
  const currentIndex = getOnboardingStepIndex(value);
  if (currentIndex < 0) {
    return null;
  }

  if (currentIndex >= ONBOARDING_STEPS.length - 1) {
    return null;
  }

  return ONBOARDING_STEPS[currentIndex + 1];
}

function isValidIanaTimezone(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }

  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  SUPPORTED_COUNTRY_CODES,
  SUPPORTED_CURRENCIES,
  SUBSCRIPTION_STATUSES,
  TURKISH_CHAR_MAP,
  ONBOARDING_STEPS,
  ONBOARDING_STEP_INDEX,
  normalizeUppercaseCode,
  isSupportedCountryCode,
  isSupportedCurrency,
  isSupportedSubscriptionStatus,
  normalizeStudioCode,
  isValidStudioCode,
  generateStudioCodeBase,
  isSupportedOnboardingStep,
  getOnboardingStepIndex,
  getNextOnboardingStep,
  isValidIanaTimezone,
};