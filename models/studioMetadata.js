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
  normalizeUppercaseCode,
  isSupportedCountryCode,
  isSupportedCurrency,
  isSupportedSubscriptionStatus,
  isValidIanaTimezone,
};