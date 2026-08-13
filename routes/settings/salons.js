const express = require('express');
const controller = require('../../controllers/salonController');
const { authenticateToken, authorizeRoles, authorizePagePermission } = require('../../middleware/auth');
const requireActiveSubscription = require('../../middleware/requireActiveSubscription');

const router = express.Router();

router.use(authenticateToken);
router.use(requireActiveSubscription);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getSalons);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getSalon);
router.post('/', authorizePagePermission('settings'), controller.createSalon);
router.put('/:id', authorizePagePermission('settings'), controller.updateSalon);
router.delete('/:id', authorizePagePermission('settings'), controller.deleteSalon);

module.exports = router;
