const {
  loginMember,
  getMemberSession,
  selectMembership,
  validateAccountId,
} = require('../services/memberAuthService');

exports.login = async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.phone !== 'string' || typeof body.password !== 'string') {
      return res.status(401).json({ error: 'Invalid phone or password' });
    }
    const result = await loginMember(req, body.phone, body.password);
    return res.status(200).json(result);
  } catch (error) {
    if (error.message === 'MEMBER_JWT_SECRET is not configured') {
      return res.status(500).json({ error: 'Member authentication is unavailable' });
    }
    return res.status(error.status || 401).json({ error: error.message || 'Invalid phone or password' });
  }
};

exports.getMe = async (req, res) => {
  try {
    const result = await getMemberSession(validateAccountId(req.memberAccountId));
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || 403).json({ error: error.message || 'Member access unavailable' });
  }
};

exports.selectMembership = async (req, res) => {
  try {
    const membershipId = Number(req.body && req.body.membershipId);
    if (!Number.isInteger(membershipId) || membershipId <= 0) {
      return res.status(403).json({ error: 'Member access unavailable' });
    }
    const result = await selectMembership(validateAccountId(req.memberAccountId), membershipId);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || 403).json({ error: error.message || 'Member access unavailable' });
  }
};
