const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { User } = require('../models');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

// Login route
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    // Log which database file is being used
    console.log('DB file:', require('path').resolve(__dirname, '../database.sqlite'));
    const user = await User.findOne({ where: { username } });
    console.log('User exists:', !!user);
    if (user) {
      console.log('Stored username:', user.username);
    }
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    console.log('bcrypt.compare result:', valid);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Get permissions for the user's role
    const permissionsMap = require('../permissions');
    const permissions = permissionsMap[user.role] || [];

    const token = jwt.sign({ id: user.id, role: user.role, assignedSalonIds: user.assignedSalonIds }, JWT_SECRET, { expiresIn: '1d' });
    res.json({
      token,
      role: user.role,
      assignedSalonIds: user.assignedSalonIds,
      permissions,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
