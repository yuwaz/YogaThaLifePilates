const express = require('express');
const controller = require('../controllers/memberActivationController');

const router = express.Router();

router.post('/activate', controller.activateMember);

module.exports = router;
