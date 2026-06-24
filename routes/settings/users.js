const express = require('express');
const controller = require('../../controllers/userController');
const { authenticateToken, authorizeRoles, authorizePagePermission } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

function canAccessInstructorReference(req, res, next) {
	if (req.user.role === 'admin') return next();

	const perms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
	const hasAllowedPermission = perms.includes('members') || perms.includes('reservations') || perms.includes('attendances');

	if (!hasAllowedPermission) {
		return res.status(403).json({ error: 'Forbidden: missing permission', requiredAnyOf: ['members', 'reservations', 'attendances'] });
	}

	return next();
}

router.get('/instructors', canAccessInstructorReference, controller.getInstructors);

router.get('/', authorizePagePermission('settings'), controller.getUsers);
router.get('/:id', authorizeRoles(['admin']), controller.getUser);
router.post('/', authorizePagePermission('settings'), controller.createUser);
router.put('/:id', authorizePagePermission('settings'), controller.updateUser);
router.delete('/:id', authorizePagePermission('settings'), controller.deleteUser);

module.exports = router;
