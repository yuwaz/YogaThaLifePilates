const express = require('express');
const controller = require('../../controllers/memberController');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

// Restore/reactivate member
router.post('/:id/restore', authorizeRoles(['admin']), controller.restoreMember);
router.get('/', authorizeRoles(['admin', 'instructor']), controller.getMembers);
router.get('/all', authorizeRoles(['admin']), controller.getAllMembers);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getMember);
router.post('/', authorizeRoles(['admin']), controller.createMember);
router.put('/:id', authorizeRoles(['admin']), controller.updateMember);
router.delete('/:id', authorizeRoles(['admin']), controller.deleteMember);

// Add lesson package to member
router.post('/:id/lessonPackage', authorizeRoles(['admin']), controller.addLessonPackage);
// Track payment
router.post('/:id/payment', authorizeRoles(['admin']), controller.addPayment);
// Track attendance
router.post('/:id/attendance', authorizeRoles(['admin', 'instructor']), controller.addAttendance);

module.exports = router;
