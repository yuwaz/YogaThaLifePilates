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

function authenticateMember(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) return unauthorized(res);
    const decoded = verifyMemberToken(token, MEMBER_GLOBAL_TOKEN_TYPE);
    return MemberAccount.findOne({ where: { id: decoded.accountId, status: 'active' } })
      .then((account) => {
        if (!account) return unauthorized(res);
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
        if (!account) return unauthorized(res);
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
