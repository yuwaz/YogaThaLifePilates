const bcrypt = require('bcrypt');
const { MemberAccount, MemberAccountMembership, Member, Studio } = require('../models');
const { CLASSIFICATIONS, normalizePhone } = require('../utils/phoneNormalization');
const { signGlobalMemberToken, signMemberContextToken } = require('../utils/memberAuthToken');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map();

class MemberAuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

function genericLoginError() {
  return new MemberAuthError('Invalid phone or password');
}

function genericMemberAccessError() {
  return new MemberAuthError('Member access unavailable', 403);
}

function normalizeEligiblePhone(phone) {
  const result = normalizePhone(phone);
  if (result.classification !== CLASSIFICATIONS.TURKISH_MOBILE
    && result.classification !== CLASSIFICATIONS.INTERNATIONAL_E164) {
    throw genericLoginError();
  }
  return result.normalizedPhone;
}

function getClientIp(req) {
  return typeof req.ip === 'string' && req.ip.trim() ? req.ip.trim() : 'unknown-ip';
}

function getFailureKey(req, normalizedPhone) {
  return `${getClientIp(req)}|${normalizedPhone || 'invalid-phone'}`;
}

function isThrottled(key, now = Date.now()) {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (now >= entry.expiresAt) {
    loginFailures.delete(key);
    return false;
  }
  return entry.failures >= LOGIN_MAX_FAILURES;
}

function recordFailure(key, now = Date.now()) {
  const entry = loginFailures.get(key);
  if (!entry || now >= entry.expiresAt) {
    loginFailures.set(key, { failures: 1, expiresAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.failures += 1;
}

function clearFailures(key) {
  loginFailures.delete(key);
}

function toMembershipPayload(membership) {
  return {
    membershipId: membership.id,
    studioId: membership.studioId,
    studioName: membership.Studio.name,
    memberId: membership.memberId,
  };
}

async function getAccessibleMemberships(accountId, options = {}) {
  const memberships = await MemberAccountMembership.findAll({
    where: { accountId },
    include: [
      { model: Member, required: true, where: { isActive: true, deletedAt: null } },
      { model: Studio, required: true },
    ],
    order: [['id', 'ASC']],
    ...(options.transaction ? { transaction: options.transaction } : {}),
  });

  return memberships.filter((membership) => (
    membership.Member
    && membership.Member.studioId === membership.studioId
    && membership.Studio
    && membership.Studio.id === membership.studioId
  )).map(toMembershipPayload);
}

function buildAccountResponse(account, memberships) {
  return {
    account: { id: account.id, status: account.status },
    memberships,
    requiresStudioSelection: memberships.length > 1,
  };
}

async function loginMember(req, phone, password) {
  let normalizedPhone;
  try {
    normalizedPhone = normalizeEligiblePhone(phone);
  } catch (error) {
    const key = getFailureKey(req, null);
    if (!isThrottled(key)) recordFailure(key);
    throw error;
  }

  const key = getFailureKey(req, normalizedPhone);
  if (isThrottled(key)) throw genericLoginError();
  if (typeof password !== 'string') {
    recordFailure(key);
    throw genericLoginError();
  }

  const account = await MemberAccount.findOne({ where: { normalizedPhone } });
  if (!account || account.status !== 'active' || !(await bcrypt.compare(password, account.passwordHash))) {
    recordFailure(key);
    throw genericLoginError();
  }

  clearFailures(key);
  const token = signGlobalMemberToken(account.id);
  account.lastLoginAt = new Date();
  await account.save({ fields: ['lastLoginAt'] });
  const memberships = await getAccessibleMemberships(account.id);
  return {
    token,
    ...buildAccountResponse(account, memberships),
  };
}

async function getMemberSession(accountId) {
  const account = await MemberAccount.findByPk(accountId);
  if (!account || account.status !== 'active') throw genericMemberAccessError();
  const memberships = await getAccessibleMemberships(account.id);
  return buildAccountResponse(account, memberships);
}

async function selectMembership(accountId, membershipId) {
  const membership = await MemberAccountMembership.findOne({
    where: { id: membershipId, accountId },
    include: [
      { model: Member, required: true, where: { isActive: true, deletedAt: null } },
      { model: Studio, required: true },
    ],
  });

  if (!membership
    || !membership.Member
    || membership.Member.studioId !== membership.studioId
    || !membership.Studio
    || membership.Studio.id !== membership.studioId) {
    throw genericMemberAccessError();
  }

  return {
    contextToken: signMemberContextToken({
      accountId,
      membershipId: membership.id,
      studioId: membership.studioId,
      memberId: membership.memberId,
    }),
    membership: toMembershipPayload(membership),
  };
}

function validateAccountId(accountId) {
  const parsed = Number(accountId);
  if (!Number.isInteger(parsed) || parsed <= 0) throw genericMemberAccessError();
  return parsed;
}

module.exports = {
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  loginMember,
  getMemberSession,
  getAccessibleMemberships,
  selectMembership,
  validateAccountId,
  genericLoginError,
};
