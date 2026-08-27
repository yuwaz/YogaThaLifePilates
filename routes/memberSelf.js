const express = require('express');
const { authenticateMemberContext } = require('../middleware/memberAuth');
const controller = require('../controllers/memberSelfController');

const router = express.Router();

router.use(authenticateMemberContext);
router.get('/self', controller.getSelf);
router.get('/self/measurements', controller.getMeasurements);
router.get('/self/reservations', controller.getReservations);
router.get('/self/packages', controller.getPackages);
router.get('/self/attendances', controller.getAttendances);
router.get('/self/payments', controller.getPayments);

module.exports = router;
