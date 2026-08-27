const CLASSIFICATIONS = Object.freeze({
  TURKISH_MOBILE: 'turkish_mobile',
  INTERNATIONAL_E164: 'international_e164',
  INVALID: 'invalid',
  AMBIGUOUS: 'ambiguous',
  EMPTY: 'empty',
});

function result(classification, normalizedPhone, reason) {
  return {
    classification,
    normalizedPhone: normalizedPhone || null,
    reason,
  };
}

function normalizePhone(value) {
  if (value === null || typeof value === 'undefined') {
    return result(CLASSIFICATIONS.EMPTY, null, 'Phone is empty');
  }

  if (typeof value !== 'string') {
    return result(CLASSIFICATIONS.INVALID, null, 'Phone must be a string');
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return result(CLASSIFICATIONS.EMPTY, null, 'Phone is empty');
  }

  const compact = trimmed.replace(/[\s().-]/g, '');
  if (!/^[+0-9]+$/.test(compact)) {
    return result(CLASSIFICATIONS.INVALID, null, 'Phone contains unsupported characters');
  }

  if (/^05[0-9]{9}$/.test(compact)) {
    return result(CLASSIFICATIONS.TURKISH_MOBILE, `+90${compact.slice(1)}`, 'Turkish national mobile format');
  }

  if (/^5[0-9]{9}$/.test(compact)) {
    return result(CLASSIFICATIONS.TURKISH_MOBILE, `+90${compact}`, 'Turkish national mobile format without trunk prefix');
  }

  if (/^90(5[0-9]{9})$/.test(compact)) {
    return result(CLASSIFICATIONS.TURKISH_MOBILE, `+${compact}`, 'Turkish international mobile format');
  }

  if (/^\+90(5[0-9]{9})$/.test(compact)) {
    return result(CLASSIFICATIONS.TURKISH_MOBILE, compact, 'Turkish international mobile format');
  }

  if (/^\+90/.test(compact)) {
    return result(CLASSIFICATIONS.INVALID, null, 'Turkish number is not a valid mobile format');
  }

  if (/^\+[1-9][0-9]{7,14}$/.test(compact)) {
    return result(CLASSIFICATIONS.INTERNATIONAL_E164, compact, 'Syntactically plausible explicit international E.164 format');
  }

  if (/^\+/.test(compact)) {
    return result(CLASSIFICATIONS.INVALID, null, 'Invalid international E.164 format');
  }

  if (/^[0-9]+$/.test(compact)) {
    return result(CLASSIFICATIONS.AMBIGUOUS, null, 'National number is not an unambiguous Turkish mobile format');
  }

  return result(CLASSIFICATIONS.INVALID, null, 'Invalid phone format');
}

module.exports = {
  CLASSIFICATIONS,
  normalizePhone,
};
