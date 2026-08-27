const jwt = require('jsonwebtoken');

const MEMBER_TOKEN_ISSUER = 'cepstudio-member-auth';
const MEMBER_TOKEN_AUDIENCE = 'cepstudio-member-api';
const MEMBER_GLOBAL_TOKEN_TYPE = 'member';
const MEMBER_CONTEXT_TOKEN_TYPE = 'member_context';
const MEMBER_GLOBAL_TOKEN_EXPIRY = '30d';
const MEMBER_CONTEXT_TOKEN_EXPIRY = '15m';

function getMemberJwtSecret() {
  const secret = process.env.MEMBER_JWT_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('MEMBER_JWT_SECRET is not configured');
  }
  const staffSecret = process.env.JWT_SECRET || 'supersecret';
  if (secret === staffSecret) {
    throw new Error('MEMBER_JWT_SECRET must differ from the staff JWT secret');
  }
  return secret;
}

function signMemberToken(payload, tokenType, expiresIn) {
  return jwt.sign(
    { ...payload, tokenType },
    getMemberJwtSecret(),
    {
      expiresIn,
      issuer: MEMBER_TOKEN_ISSUER,
      audience: MEMBER_TOKEN_AUDIENCE,
    }
  );
}

function signGlobalMemberToken(accountId) {
  return signMemberToken({ accountId }, MEMBER_GLOBAL_TOKEN_TYPE, MEMBER_GLOBAL_TOKEN_EXPIRY);
}

function signMemberContextToken({ accountId, membershipId, studioId, memberId }) {
  return signMemberToken(
    { accountId, membershipId, studioId, memberId },
    MEMBER_CONTEXT_TOKEN_TYPE,
    MEMBER_CONTEXT_TOKEN_EXPIRY
  );
}

function verifyMemberToken(token, expectedTokenType) {
  const decoded = jwt.verify(token, getMemberJwtSecret(), {
    issuer: MEMBER_TOKEN_ISSUER,
    audience: MEMBER_TOKEN_AUDIENCE,
  });

  if (!decoded || decoded.tokenType !== expectedTokenType) {
    throw new Error('Invalid member token type');
  }

  const accountId = Number(decoded.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error('Invalid member account identity');
  }

  if (expectedTokenType === MEMBER_CONTEXT_TOKEN_TYPE) {
    for (const field of ['membershipId', 'studioId', 'memberId']) {
      const value = Number(decoded[field]);
      if (!Number.isInteger(value) || value <= 0) throw new Error('Invalid member context');
    }
  }

  return decoded;
}

module.exports = {
  MEMBER_TOKEN_ISSUER,
  MEMBER_TOKEN_AUDIENCE,
  MEMBER_GLOBAL_TOKEN_TYPE,
  MEMBER_CONTEXT_TOKEN_TYPE,
  MEMBER_GLOBAL_TOKEN_EXPIRY,
  MEMBER_CONTEXT_TOKEN_EXPIRY,
  getMemberJwtSecret,
  signGlobalMemberToken,
  signMemberContextToken,
  verifyMemberToken,
};
