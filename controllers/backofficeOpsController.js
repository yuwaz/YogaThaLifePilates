const backofficeOpsService = require('../services/backofficeOpsService');

async function getPlatformSummary(req, res) {
  try {
    const summary = await backofficeOpsService.getPlatformSummary();
    return res.status(200).json({ summary });
  } catch (err) {
    return res.status(500).json({ error: 'BACKOFFICE_INTERNAL_ERROR' });
  }
}

async function listPlatformAuditLogs(req, res) {
  try {
    const result = await backofficeOpsService.listPlatformAuditLogs(req.query);
    return res.status(200).json(result);
  } catch (err) {
    if (err && err.code === 'BACKOFFICE_VALIDATION_ERROR') {
      return res.status(400).json({ error: 'BACKOFFICE_INVALID_REQUEST' });
    }
    return res.status(500).json({ error: 'BACKOFFICE_INTERNAL_ERROR' });
  }
}

module.exports = {
  getPlatformSummary,
  listPlatformAuditLogs,
};