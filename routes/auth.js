
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

// Apply CORS to all /auth routes (in addition to global)
router.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Login route
router.post('/login', async (req, res) => {
  console.log('[AUTH BACKEND] login hit');
  console.log('[AUTH BACKEND] method:', req.method);
  console.log('[AUTH BACKEND] origin:', req.headers.origin);
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

    // Use permissions from DB, not permissions.js
    let permissions = user.permissions;
    if (typeof permissions === 'string') {
      try { permissions = JSON.parse(permissions); } catch { permissions = []; }
    }
    if (!Array.isArray(permissions)) permissions = [];
    console.log('[Auth] DB permissions:', permissions);
    let assignedSalonIds = user.assignedSalonIds;
    if (typeof assignedSalonIds === 'string') {
      try { assignedSalonIds = JSON.parse(assignedSalonIds); } catch { assignedSalonIds = []; }
    }
    const normalizedStudioId = Number.isInteger(Number(user.studioId)) && Number(user.studioId) > 0
      ? Number(user.studioId)
      : 1;
    const payload = { id: user.id, role: user.role, assignedSalonIds, permissions, studioId: normalizedStudioId };
    console.log('[Auth] JWT permissions:', permissions);
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
    console.log('[Auth] response permissions:', permissions);
    res.json({
      token,
      role: user.role,
      assignedSalonIds,
      permissions,
      studioId: normalizedStudioId,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'username', 'role', 'assignedSalonIds', 'permissions', 'studioId']
    });
    if (!user) return res.sendStatus(404);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/me/password', authenticateToken, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: 'Missing required fields: oldPassword, newPassword' });
    }
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'newPassword must be at least 6 characters' });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) return res.sendStatus(404);

    const validOldPassword = await bcrypt.compare(oldPassword, user.password);
    if (!validOldPassword) {
      return res.status(401).json({ error: 'Old password is incorrect' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    return res.json({ message: 'Password updated successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
