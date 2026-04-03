const express = require('express');
const controller = require('../../controllers/lessonPackageController');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getLessonPackages);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getLessonPackage);
router.post('/', authorizeRoles(['admin']), controller.createLessonPackage);
router.put('/:id', authorizeRoles(['admin']), controller.updateLessonPackage);
router.delete('/:id', authorizeRoles(['admin']), controller.deleteLessonPackage);

module.exports = router;
