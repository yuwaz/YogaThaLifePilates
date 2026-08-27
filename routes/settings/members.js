const express = require('express');
const router = express.Router();
const controller = require('../../controllers/memberController');
const activationController = require('../../controllers/memberActivationController');
const { authenticateToken, authorizeRoles, authorizePagePermission } = require('../../middleware/auth');
const requireActiveSubscription = require('../../middleware/requireActiveSubscription');

router.use(authenticateToken);
router.use(requireActiveSubscription);

router.post('/:id/activation-code', authorizeRoles(['admin']), activationController.generateActivationCode);

// Delete assigned lesson package from member
router.delete('/:memberId/assigned-lesson-packages/:assignedPackageId', authorizePagePermission('members'), controller.deleteAssignedLessonPackage);
// Restore/reactivate member
router.post('/:id/restore', authorizePagePermission('members'), controller.restoreMember);
router.get('/', authorizeRoles(['admin', 'instructor']), controller.getMembers);
router.get('/all', authorizeRoles(['admin']), controller.getAllMembers);
router.get('/:id/measurements', authorizeRoles(['admin', 'instructor']), controller.getMemberMeasurements);
router.post('/:id/measurements', authorizePagePermission('members'), controller.addMemberMeasurement);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getMember);
router.post('/', authorizePagePermission('members'), controller.createMember);
router.put('/:id', authorizePagePermission('members'), controller.updateMember);
router.patch('/:id', authorizePagePermission('members'), controller.updateMember);
router.delete('/:id', authorizePagePermission('members'), controller.deleteMember);
// Add lesson package to member
router.post('/:id/lessonPackage', authorizePagePermission('members'), controller.addLessonPackage);
// Track payment
router.post('/:id/payment', authorizeRoles(['admin']), controller.addPayment);
// Track attendance
router.post('/:id/attendance', authorizeRoles(['admin', 'instructor']), controller.addAttendance);

module.exports = router;
