const express = require('express');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');
const { deleteAttendance } = require('../../controllers/attendanceController');

const router = express.Router();

router.use(authenticateToken);

router.delete('/:id', authorizeRoles(['admin']), deleteAttendance);

module.exports = router;
