const memberSelfService = require('../services/memberSelfService');

async function handle(readOperation, req, res) {
  try {
    const result = await readOperation(req);
    return res.status(200).json(result);
  } catch (error) {
    const status = error.message === 'Invalid limit'
      || error.message === 'Invalid from date'
      || error.message === 'Invalid to date'
      || error.message === 'Invalid date range'
      ? 400
      : 403;
    return res.status(status).json({ error: 'Member data unavailable' });
  }
}

exports.getSelf = (req, res) => handle(memberSelfService.getMember, req, res);
exports.getMeasurements = (req, res) => handle(memberSelfService.getMeasurements, req, res);
exports.getReservations = (req, res) => handle(memberSelfService.getReservations, req, res);
exports.getPackages = (req, res) => handle(memberSelfService.getPackages, req, res);
exports.getAttendances = (req, res) => handle(memberSelfService.getAttendances, req, res);
exports.getPayments = (req, res) => handle(memberSelfService.getPayments, req, res);
