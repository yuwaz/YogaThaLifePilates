const express = require('express');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');
const {
  getAttendance,
  addAttendance,
  updateAttendance,
  deleteAttendance,
} = require('../../controllers/attendanceController');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin']), getAttendance);
router.post('/', authorizeRoles(['admin']), addAttendance);
router.put('/:id', authorizeRoles(['admin']), updateAttendance);
router.delete('/:id', authorizeRoles(['admin']), deleteAttendance);

module.exports = router;
