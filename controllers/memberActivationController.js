const { getAuthenticatedStudioId } = require('../middleware/tenantContext');
const {
  generateActivationCode,
  activateMember,
} = require('../services/memberActivationService');

exports.generateActivationCode = async (req, res) => {
  try {
    const result = await generateActivationCode({
      studioId: getAuthenticatedStudioId(req),
      memberId: Number(req.params.id),
      createdByUserId: Number(req.user.id),
    });
    return res.status(201).json(result);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message || 'Unable to generate activation code' });
  }
};

exports.activateMember = async (req, res) => {
  try {
    const result = await activateMember(req.body || {});
    return res.status(201).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Activation failed' });
  }
};
