const { getAuthenticatedStudioId } = require('../middleware/tenantContext');
const { registerDeviceToken, unregisterDeviceToken } = require('../services/deviceTokenService');

// Staff: ownerType='staff', ownerId=req.user.id, studioId from staff token.
exports.staffRegisterDevice = async (req, res) => {
  try {
    const { token, platform } = req.body || {};
    const result = await registerDeviceToken({
      ownerType: 'staff',
      ownerId: req.user.id,
      studioId: getAuthenticatedStudioId(req),
      token,
      platform,
    });
    res.status(result.created ? 201 : 200).json({ registered: true, created: result.created });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Invalid device registration' });
  }
};

exports.staffUnregisterDevice = async (req, res) => {
  try {
    const { token } = req.body || {};
    const result = await unregisterDeviceToken({
      ownerType: 'staff',
      ownerId: req.user.id,
      studioId: getAuthenticatedStudioId(req),
      token,
    });
    res.status(200).json({ removed: result.removed });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Invalid device removal' });
  }
};

// Member: ownerType='member', ownerId=req.memberAccountId, studioId=null (global).
exports.memberRegisterDevice = async (req, res) => {
  try {
    const { token, platform } = req.body || {};
    const result = await registerDeviceToken({
      ownerType: 'member',
      ownerId: req.memberAccountId,
      studioId: null,
      token,
      platform,
    });
    res.status(result.created ? 201 : 200).json({ registered: true, created: result.created });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Invalid device registration' });
  }
};

exports.memberUnregisterDevice = async (req, res) => {
  try {
    const { token } = req.body || {};
    const result = await unregisterDeviceToken({
      ownerType: 'member',
      ownerId: req.memberAccountId,
      studioId: null,
      token,
    });
    res.status(200).json({ removed: result.removed });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Invalid device removal' });
  }
};
