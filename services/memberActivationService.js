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
    }, { transaction });

    return { code, expiresAt };
  });
}

async function loadActivationCandidates(normalizedPhone, transaction) {
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
    },
    attributes: ['id', 'studioId', 'memberId', 'codeHash', 'expiresAt', 'attemptCount'],
    transaction,
  });

  return codes
    .map((code) => ({ code, member: memberById.get(code.memberId) }))
    .filter(({ code, member }) => member && member.studioId === code.studioId);
}

async function recordFailedAttempts(candidates, transaction) {
  const now = new Date();
  for (const { code } of candidates) {
    code.attemptCount = Math.min(ACTIVATION_CODE_MAX_ATTEMPTS, Number(code.attemptCount) + 1);
    code.lastAttemptAt = now;
    await code.save({ fields: ['attemptCount', 'lastAttemptAt'], transaction });
  }
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

  return MemberAccountMembership.create({
    accountId,
    studioId: member.studioId,
    memberId: member.id,
  }, { transaction });
}

async function linkSafeCrossStudioMembers(accountId, normalizedPhone, transaction) {
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

  for (const member of members) {
    if (!byStudio.has(member.studioId)) byStudio.set(member.studioId, []);
    byStudio.get(member.studioId).push(member);
  }

  for (const studioMembers of byStudio.values()) {
    if (studioMembers.length !== 1) continue;
    const member = studioMembers[0];
    const studio = await Studio.findByPk(member.studioId, { transaction });
    if (!studio || studio.id !== member.studioId) continue;
    await ensureMembership(accountId, member, transaction, false);
  }
}

async function activateMember({ phone, code, password, passwordConfirmation }) {
  const normalized = normalizePhone(phone);
  if (!isEligiblePhone(normalized) || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw genericActivationError();
  }
  validatePasswordInput(password, passwordConfirmation);

  const activationResult = await sequelize.transaction(async (transaction) => {
    const candidates = await loadActivationCandidates(normalized.normalizedPhone, transaction);
    const matches = [];
    for (const candidate of candidates) {
      if (await bcrypt.compare(code, candidate.code.codeHash)) matches.push(candidate);
    }

    if (matches.length !== 1) {
      await recordFailedAttempts(candidates, transaction);
      return { success: false };
    }

    const { code: activationCode, member } = matches[0];
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

module.exports = {
  ACTIVATION_CODE_MAX_ATTEMPTS,
  ACTIVATION_CODE_TTL_MS,
  generateActivationCode,
  activateMember,
};
