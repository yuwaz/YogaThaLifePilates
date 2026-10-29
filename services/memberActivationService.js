const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Op } = require('sequelize');
const {
  sequelize,
  Member,
  MemberAccount,
  MemberAccountMembership,
  MemberActivationCode,
  Studio,
} = require('../models');
const { CLASSIFICATIONS, normalizePhone } = require('../utils/phoneNormalization');

const ACTIVATION_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVATION_CODE_MAX_ATTEMPTS = 5;
const PASSWORD_MIN_LENGTH = 8;
const BCRYPT_ROUNDS = 10;
const PURPOSE_ACTIVATION = 'activation';
const PURPOSE_RECOVERY = 'recovery';

class MemberActivationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function genericActivationError() {
  return new MemberActivationError('Activation failed');
}

function isEligiblePhone(result) {
  return result.classification === CLASSIFICATIONS.TURKISH_MOBILE
    || result.classification === CLASSIFICATIONS.INTERNATIONAL_E164;
}

function generateSixDigitCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function validatePasswordInput(password, passwordConfirmation) {
  if (typeof password !== 'string' || typeof passwordConfirmation !== 'string') {
    throw genericActivationError();
  }
  if (password.length < PASSWORD_MIN_LENGTH || password !== passwordConfirmation) {
    throw genericActivationError();
  }
}

async function generateActivationCode({ studioId, memberId, createdByUserId }) {
  return sequelize.transaction(async (transaction) => {
    const member = await Member.findOne({
      where: {
        id: memberId,
        studioId,
        isActive: true,
        deletedAt: null,
      },
      attributes: ['id', 'studioId', 'normalizedPhone'],
      transaction,
    });

    if (!member || !member.normalizedPhone) {
      throw new MemberActivationError('Member not found or app access unavailable', 404);
    }

    const now = new Date();
    await MemberActivationCode.update(
      { consumedAt: now },
      {
        where: {
          studioId,
          memberId: member.id,
          consumedAt: null,
        },
        transaction,
      }
    );

    const code = generateSixDigitCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    const expiresAt = new Date(now.getTime() + ACTIVATION_CODE_TTL_MS);

    await MemberActivationCode.create({
      studioId,
      memberId: member.id,
      codeHash,
      expiresAt,
      consumedAt: null,
      createdByUserId,
      attemptCount: 0,
      lastAttemptAt: null,
      purpose: PURPOSE_ACTIVATION,
    }, { transaction });

    return { code, expiresAt };
  });
}

// Recovery codes are bound to the exact linked global account (not merely the
// current studio contact phone), so they keep working after contact phone changes.
async function generateRecoveryCode({ studioId, memberId, createdByUserId }) {
  return sequelize.transaction(async (transaction) => {
    const member = await Member.findOne({
      where: {
        id: memberId,
        studioId,
        isActive: true,
        deletedAt: null,
      },
      attributes: ['id', 'studioId', 'normalizedPhone'],
      transaction,
    });

    if (!member) {
      throw new MemberActivationError('Member not found or app access unavailable', 404);
    }

    const membership = await MemberAccountMembership.findOne({
      where: { memberId: member.id, studioId },
      transaction,
    });
    if (!membership) {
      throw new MemberActivationError('Member not found or app access unavailable', 404);
    }

    const account = await MemberAccount.findOne({
      where: { id: membership.accountId, status: 'active' },
      transaction,
    });
    if (!account) {
      throw new MemberActivationError('Member not found or app access unavailable', 404);
    }

    const now = new Date();
    await MemberActivationCode.update(
      { consumedAt: now },
      {
        where: {
          studioId,
          memberId: member.id,
          consumedAt: null,
        },
        transaction,
      }
    );

    const code = generateSixDigitCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    const expiresAt = new Date(now.getTime() + ACTIVATION_CODE_TTL_MS);

    await MemberActivationCode.create({
      studioId,
      memberId: member.id,
      codeHash,
      expiresAt,
      consumedAt: null,
      createdByUserId,
      attemptCount: 0,
      lastAttemptAt: null,
      purpose: PURPOSE_RECOVERY,
    }, { transaction });

    return { code, expiresAt };
  });
}

async function loadActivationCandidates(normalizedPhone, transaction, purpose = PURPOSE_ACTIVATION) {
  const members = await Member.findAll({
    where: {
      normalizedPhone,
      isActive: true,
      deletedAt: null,
    },
    attributes: ['id', 'studioId', 'normalizedPhone'],
    include: [{
      model: Studio,
      attributes: ['id', 'name'],
      required: true,
    }],
    transaction,
  });

  if (members.length === 0) return [];

  const memberById = new Map(members.map((member) => [member.id, member]));
  const codes = await MemberActivationCode.findAll({
    where: {
      memberId: { [Op.in]: members.map((member) => member.id) },
      consumedAt: null,
      expiresAt: { [Op.gt]: new Date() },
      attemptCount: { [Op.lt]: ACTIVATION_CODE_MAX_ATTEMPTS },
      purpose,
    },
    attributes: ['id', 'studioId', 'memberId', 'codeHash', 'expiresAt', 'attemptCount'],
    transaction,
  });

  return codes
    .map((code) => ({ code, member: memberById.get(code.memberId) }))
    .filter(({ code, member }) => member && member.studioId === code.studioId);
}

// Recovery candidates are bound to the global account (looked up by the account's
// own normalizedPhone, which never changes on contact-phone edits), then resolved
// via the account's linked members. This keeps recovery working after the studio
// contact phone changes and prevents cross-account collisions.
async function loadRecoveryCandidates(normalizedPhone, transaction) {
  const account = await MemberAccount.findOne({
    where: { normalizedPhone, status: 'active' },
    attributes: ['id', 'normalizedPhone'],
    transaction,
  });
  if (!account) return [];

  const memberships = await MemberAccountMembership.findAll({
    where: { accountId: account.id },
    attributes: ['memberId', 'studioId'],
    transaction,
  });
  if (memberships.length === 0) return [];

  const memberIds = memberships.map((m) => m.memberId);
  const members = await Member.findAll({
    where: { id: { [Op.in]: memberIds }, isActive: true, deletedAt: null },
    attributes: ['id', 'studioId', 'normalizedPhone'],
    transaction,
  });
  if (members.length === 0) return [];

  const memberById = new Map(members.map((member) => [member.id, member]));
  const codes = await MemberActivationCode.findAll({
    where: {
      memberId: { [Op.in]: memberIds },
      consumedAt: null,
      expiresAt: { [Op.gt]: new Date() },
      attemptCount: { [Op.lt]: ACTIVATION_CODE_MAX_ATTEMPTS },
      purpose: PURPOSE_RECOVERY,
    },
    attributes: ['id', 'studioId', 'memberId', 'codeHash', 'expiresAt', 'attemptCount'],
    transaction,
  });

  return codes
    .map((code) => ({ code, member: memberById.get(code.memberId) }))
    .filter(({ code, member }) => member && member.studioId === code.studioId)
    .map((entry) => ({ ...entry, accountId: account.id }));
}

async function recordFailedAttempts(candidates, transaction) {
  const now = new Date();
  for (const { code } of candidates) {
    // Cap at MAX_ATTEMPTS + 1 so the 5th failure actually locks the code:
    // candidates are filtered by attemptCount < MAX_ATTEMPTS, so reaching
    // MAX_ATTEMPTS must persist (not be clamped below the lockout threshold).
    code.attemptCount = Math.min(ACTIVATION_CODE_MAX_ATTEMPTS + 1, Number(code.attemptCount) + 1);
    code.lastAttemptAt = now;
    await code.save({ fields: ['attemptCount', 'lastAttemptAt'], transaction });
  }
}

// Persists failed attempts in a committed transaction so the lockout survives the
// caller's rollback on failure. Loads fresh rows to avoid stale-instance issues.
async function recordFailedAttemptsCommitted(candidates) {
  const ids = candidates.map(({ code }) => code.id);
  if (ids.length === 0) return;
  await sequelize.transaction(async (transaction) => {
    const rows = await MemberActivationCode.findAll({ where: { id: { [Op.in]: ids } }, transaction });
    await recordFailedAttempts(rows.map((code) => ({ code })), transaction);
  });
}

async function findOrCreateAccount(normalizedPhone, passwordHash, transaction) {
  let account = await MemberAccount.findOne({
    where: { normalizedPhone },
    transaction,
  });

  if (account) return { account, created: false };

  try {
    account = await MemberAccount.create({
      normalizedPhone,
      passwordHash,
      status: 'active',
      activatedAt: new Date(),
    }, { transaction });
    return { account, created: true };
  } catch (error) {
    if (error.name !== 'SequelizeUniqueConstraintError') throw error;
    account = await MemberAccount.findOne({
      where: { normalizedPhone },
      transaction,
    });
    if (!account) throw error;
    return { account, created: false };
  }
}

async function ensureMembership(accountId, member, transaction, required = false) {
  const existing = await MemberAccountMembership.findOne({
    where: { memberId: member.id },
    transaction,
  });

  if (existing) {
    if (existing.accountId !== accountId && required) {
      throw genericActivationError();
    }
    return existing.accountId === accountId ? existing : null;
  }

  const existingStudioMembership = await MemberAccountMembership.findOne({
    where: { accountId, studioId: member.studioId },
    transaction,
  });
  if (existingStudioMembership) return null;

  try {
    return await MemberAccountMembership.create({
      accountId,
      studioId: member.studioId,
      memberId: member.id,
    }, { transaction });
  } catch (error) {
    if (error.name !== 'SequelizeUniqueConstraintError') throw error;
    return MemberAccountMembership.findOne({
      where: { accountId, memberId: member.id },
      transaction,
    });
  }
}

async function linkSafeCrossStudioMembers(accountId, normalizedPhone, transaction) {
  const account = await MemberAccount.findOne({
    where: { id: accountId, normalizedPhone, status: 'active' },
    transaction,
  });
  if (!account) return [];

  const members = await Member.findAll({
    where: {
      normalizedPhone,
      isActive: true,
      deletedAt: null,
    },
    attributes: ['id', 'studioId', 'normalizedPhone'],
    transaction,
  });
  const byStudio = new Map();
  const linkedMemberships = [];

  for (const member of members) {
    if (member.normalizedPhone !== account.normalizedPhone) continue;
    if (!byStudio.has(member.studioId)) byStudio.set(member.studioId, []);
    byStudio.get(member.studioId).push(member);
  }

  for (const studioMembers of byStudio.values()) {
    if (studioMembers.length !== 1) continue;
    const member = studioMembers[0];
    const studio = await Studio.findByPk(member.studioId, { transaction });
    if (!studio || studio.id !== member.studioId) continue;
    const membership = await ensureMembership(account.id, member, transaction, false);
    if (membership) linkedMemberships.push(membership);
  }

  return linkedMemberships;
}

async function activateMember({ phone, code, password, passwordConfirmation }) {
  const normalized = normalizePhone(phone);
  if (!isEligiblePhone(normalized) || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw genericActivationError();
  }
  validatePasswordInput(password, passwordConfirmation);

  // Load candidates and match outside the mutation transaction so failed-attempt
  // increments can be committed even when activation fails.
  const candidateRows = await loadActivationCandidates(normalized.normalizedPhone, null, PURPOSE_ACTIVATION);
  const matches = [];
  for (const candidate of candidateRows) {
    if (await bcrypt.compare(code, candidate.code.codeHash)) matches.push(candidate);
  }
  if (matches.length !== 1) {
    await recordFailedAttemptsCommitted(candidateRows);
    throw genericActivationError();
  }
  const matchedCodeId = matches[0].code.id;

  const activationResult = await sequelize.transaction(async (transaction) => {
    const activationCode = await MemberActivationCode.findOne({
      where: { id: matchedCodeId },
      transaction,
    });
    const member = await Member.findOne({
      where: { id: activationCode.memberId, isActive: true, deletedAt: null },
      transaction,
    });
    if (!activationCode || !member) throw genericActivationError();
    if (member.studioId !== activationCode.studioId || member.normalizedPhone !== normalized.normalizedPhone) {
      throw genericActivationError();
    }

    const existingAccount = await MemberAccount.findOne({
      where: { normalizedPhone: normalized.normalizedPhone },
      transaction,
    });
    if (existingAccount && existingAccount.status !== 'active') {
      throw genericActivationError();
    }

    const passwordHash = existingAccount ? null : await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { account } = await findOrCreateAccount(normalized.normalizedPhone, passwordHash, transaction);
    await ensureMembership(account.id, member, transaction, true);
    await linkSafeCrossStudioMembers(account.id, normalized.normalizedPhone, transaction);

    const now = new Date();
    const [consumedCount] = await MemberActivationCode.update(
      { consumedAt: now },
      {
        where: {
          id: activationCode.id,
          consumedAt: null,
          expiresAt: { [Op.gt]: now },
          attemptCount: { [Op.lt]: ACTIVATION_CODE_MAX_ATTEMPTS },
        },
        transaction,
      }
    );
    if (consumedCount !== 1) throw genericActivationError();

    const memberships = await MemberAccountMembership.findAll({
      where: { accountId: account.id },
      include: [{ model: Studio, attributes: ['id', 'name'] }],
      order: [['id', 'ASC']],
      transaction,
    });

    return { success: true, account, memberships };
  });

  if (!activationResult.success) throw genericActivationError();

  return {
    account: {
      id: activationResult.account.id,
      status: activationResult.account.status,
    },
    memberships: activationResult.memberships.map((membership) => ({
      membershipId: membership.id,
      studioId: membership.studioId,
      studioName: membership.Studio?.name || null,
      memberId: membership.memberId,
    })),
    requiresStudioSelection: activationResult.memberships.length > 1,
  };
}

// Resets a forgotten password using a single-use recovery code.
// The code is bound to the exact linked global account (via its membership), so
// recovery keeps working even after the studio contact phone changes. Never
// creates an account or modifies memberships. All failures return the same
// generic error to avoid exposing account existence.
async function resetPasswordWithCode({ phone, code, password, passwordConfirmation }) {
  const normalized = normalizePhone(phone);
  if (!isEligiblePhone(normalized) || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw genericActivationError();
  }
  validatePasswordInput(password, passwordConfirmation);

  // Load candidates bound to the global account (by the account's own phone) and
  // match outside the mutation transaction so failed-attempt increments commit.
  const candidateRows = await loadRecoveryCandidates(normalized.normalizedPhone, null);
  const matches = [];
  for (const candidate of candidateRows) {
    if (await bcrypt.compare(code, candidate.code.codeHash)) matches.push(candidate);
  }
  if (matches.length !== 1) {
    await recordFailedAttemptsCommitted(candidateRows);
    throw genericActivationError();
  }
  const matchedCodeId = matches[0].code.id;
  const matchedAccountId = matches[0].accountId;

  await sequelize.transaction(async (transaction) => {
    const recoveryCode = await MemberActivationCode.findOne({
      where: { id: matchedCodeId },
      transaction,
    });
    if (!recoveryCode) throw genericActivationError();
    const member = await Member.findOne({
      where: { id: recoveryCode.memberId, isActive: true, deletedAt: null },
      transaction,
    });
    if (!member || member.studioId !== recoveryCode.studioId) {
      throw genericActivationError();
    }

    // Bind to the exact account linked to this member's membership, and require
    // it to be the account the code was issued for.
    const membership = await MemberAccountMembership.findOne({
      where: { memberId: member.id, studioId: member.studioId },
      transaction,
    });
    if (!membership || Number(membership.accountId) !== Number(matchedAccountId)) {
      throw genericActivationError();
    }

    const account = await MemberAccount.findOne({
      where: { id: membership.accountId, status: 'active' },
      transaction,
    });
    if (!account) throw genericActivationError();

    const now = new Date();
    const [consumedCount] = await MemberActivationCode.update(
      { consumedAt: now },
      {
        where: {
          id: recoveryCode.id,
          consumedAt: null,
          expiresAt: { [Op.gt]: now },
          attemptCount: { [Op.lt]: ACTIVATION_CODE_MAX_ATTEMPTS },
        },
        transaction,
      }
    );
    if (consumedCount !== 1) throw genericActivationError();

    account.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    account.passwordChangedAt = now;
    account.tokenVersion = Number(account.tokenVersion || 0) + 1;
    await account.save({ fields: ['passwordHash', 'passwordChangedAt', 'tokenVersion'], transaction });
  });

  return { success: true };
}

module.exports = {
  ACTIVATION_CODE_MAX_ATTEMPTS,
  ACTIVATION_CODE_TTL_MS,
  generateActivationCode,
  generateRecoveryCode,
  activateMember,
  resetPasswordWithCode,
  linkSafeCrossStudioMembers,
};
