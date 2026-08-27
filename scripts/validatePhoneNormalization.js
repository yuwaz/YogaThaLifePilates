const assert = require('assert');
const { CLASSIFICATIONS, normalizePhone } = require('../utils/phoneNormalization');

const expectedTurkish = '+905321234567';
const turkishCases = [
  '+905321234567',
  '905321234567',
  '05321234567',
  '5321234567',
  '+90 532 123 45 67',
  '0 (532) 123 45 67',
  '0532-123-45-67',
];

for (const phone of turkishCases) {
  const result = normalizePhone(phone);
  assert.strictEqual(result.classification, CLASSIFICATIONS.TURKISH_MOBILE, phone);
  assert.strictEqual(result.normalizedPhone, expectedTurkish, phone);
}

const nonTurkishCases = [
  '+14155552671',
  '+442071838750',
  '+4915123456789',
];

for (const phone of nonTurkishCases) {
  const result = normalizePhone(phone);
  assert.strictEqual(result.classification, CLASSIFICATIONS.INTERNATIONAL_E164, phone);
  assert.strictEqual(result.normalizedPhone, phone, phone);
}

const invalidTurkishCases = [
  '+902121234567',
  '02121234567',
  '2121234567',
  '+90532123456',
  '+9053212345678',
  '90532123',
  'abc',
  '+90abc5321234567',
];

for (const phone of invalidTurkishCases) {
  const result = normalizePhone(phone);
  assert.ok(
    result.classification === CLASSIFICATIONS.INVALID || result.classification === CLASSIFICATIONS.AMBIGUOUS,
    `${phone} was classified as ${result.classification}`
  );
  assert.strictEqual(result.normalizedPhone, null, phone);
}

for (const phone of ['', '   ', null, undefined]) {
  const result = normalizePhone(phone);
  assert.strictEqual(result.classification, CLASSIFICATIONS.EMPTY, String(phone));
  assert.strictEqual(result.normalizedPhone, null, String(phone));
}

for (const phone of ['+123', '+1234567890123456', '+1 23 abc 456']) {
  const result = normalizePhone(phone);
  assert.strictEqual(result.classification, CLASSIFICATIONS.INVALID, phone);
  assert.strictEqual(result.normalizedPhone, null, phone);
}

assert.notStrictEqual(normalizePhone('+902121234567').normalizedPhone, expectedTurkish);
assert.deepStrictEqual(normalizePhone(' +90 532 123 45 67 '), {
  classification: CLASSIFICATIONS.TURKISH_MOBILE,
  normalizedPhone: expectedTurkish,
  reason: 'Turkish international mobile format',
});

console.log('phone normalization validation passed');
