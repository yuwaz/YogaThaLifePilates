const backofficeOpsService = require('../services/backofficeOpsService');

async function getPlatformSummary(req, res) {
  try {
    const summary = await backofficeOpsService.getPlatformSummary();
    return res.status(200).json({ summary });
  } catch (err) {
    return res.status(500).json({ error: 'BACKOFFICE_INTERNAL_ERROR' });
  }
}

module.exports = {
  getPlatformSummary,
};