const express = require('express');
const controller = require('../../controllers/lessonPackageController');
const { authenticateToken, authorizeRoles, authorizePagePermission } = require('../../middleware/auth');
const requireActiveSubscription = require('../../middleware/requireActiveSubscription');

const router = express.Router();

router.use(authenticateToken);
router.use(requireActiveSubscription);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getLessonPackages);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getLessonPackage);
router.post('/', authorizePagePermission('settings'), controller.createLessonPackage);
router.put('/:id', authorizePagePermission('settings'), controller.updateLessonPackage);
router.delete('/:id', authorizePagePermission('settings'), controller.deleteLessonPackage);

module.exports = router;
