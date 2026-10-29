const { MemberAccount, MemberAccountMembership, Member, Studio } = require('../models');
const {
  MEMBER_GLOBAL_TOKEN_TYPE,
  MEMBER_CONTEXT_TOKEN_TYPE,
  verifyMemberToken,
} = require('../utils/memberAuthToken');

function unauthorized(res) {
  return res.status(401).json({ error: 'Unauthorized' });
}

function readBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

// Account-level token revocation via tokenVersion. Tokens carry the account's
// tokenVersion at issuance; any password reset/change increments it, revoking all
// prior tokens. Legacy tokens (no tokenVersion claim) stay valid until the first
// password change (tokenVersion 0 -> 1), then become invalid.
function isTokenRevoked(decoded, account) {
  if (!account) return true;
  const currentVersion = Number(account.tokenVersion || 0);
  const hasClaim = decoded && decoded.tokenVersion !== undefined && decoded.tokenVersion !== null;
  if (!hasClaim) {
    // Legacy token: valid only while the account has never changed its password.
    return currentVersion > 0;
  }
  return Number(decoded.tokenVersion) !== currentVersion;
}

function authenticateMember(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) return unauthorized(res);
    const decoded = verifyMemberToken(token, MEMBER_GLOBAL_TOKEN_TYPE);
    return MemberAccount.findOne({ where: { id: decoded.accountId, status: 'active' } })
      .then((account) => {
        if (!account || isTokenRevoked(decoded, account)) return unauthorized(res);
        req.memberAccount = account;
        req.memberAccountId = account.id;
        return next();
      })
      .catch(() => unauthorized(res));
  } catch (error) {
    return unauthorized(res);
  }
}

function authenticateMemberContext(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) return unauthorized(res);
    const decoded = verifyMemberToken(token, MEMBER_CONTEXT_TOKEN_TYPE);
    return MemberAccount.findOne({ where: { id: decoded.accountId, status: 'active' } })
      .then(async (account) => {
        if (!account || isTokenRevoked(decoded, account)) return unauthorized(res);
        const membership = await MemberAccountMembership.findOne({
          where: { id: decoded.membershipId, accountId: account.id },
          include: [
            { model: Member, required: true, where: { isActive: true, deletedAt: null } },
            { model: Studio, required: true },
          ],
        });
        if (!membership
          || membership.studioId !== decoded.studioId
          || membership.memberId !== decoded.memberId
          || membership.Member.studioId !== membership.studioId
          || membership.Studio.id !== membership.studioId) {
          return unauthorized(res);
        }
        req.memberAccount = account;
        req.memberAccountId = account.id;
        req.memberMembership = membership;
        req.memberStudioId = membership.studioId;
        req.memberId = membership.memberId;
        return next();
      })
      .catch(() => unauthorized(res));
  } catch (error) {
    return unauthorized(res);
  }
}

module.exports = {
  authenticateMember,
  authenticateMemberContext,
};
