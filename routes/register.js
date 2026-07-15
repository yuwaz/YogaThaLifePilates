const express = require('express');
const { registerStudio } = require('../controllers/registerController');

const router = express.Router();

router.post('/', registerStudio);

module.exports = router;
