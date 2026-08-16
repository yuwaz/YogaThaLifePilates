
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { Studio, User } = require('../models');
const { authenticateToken } = require('../middleware/auth');
const { buildAuthPayload, signAuthToken } = require('../utils/authToken');
const {
  normalizeStudioCode,
  isValidStudioCode,
} = require('../models/studioMetadata');

const router = express.Router();

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
  const hasStudioCode = req.body && Object.prototype.hasOwnProperty.call(req.body, 'studioCode');
  try {
    // Log which database file is being used
    console.log('DB file:', require('path').resolve(__dirname, '../database.sqlite'));
    let resolvedStudioCode = 'yogatha';
    if (hasStudioCode) {
      if (typeof req.body.studioCode !== 'string') {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      resolvedStudioCode = normalizeStudioCode(req.body.studioCode);
      if (!isValidStudioCode(resolvedStudioCode)) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    } else {
      // Temporary saas compatibility: legacy YogaTha clients still omit studioCode.
    }

    const studio = await Studio.findOne({ where: { studioCode: resolvedStudioCode } });
    if (!studio) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = await User.findOne({ where: { studioId: studio.id, username } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const payload = buildAuthPayload(user);
    const token = signAuthToken(payload);
    res.json({
      token,
      role: payload.role,
      assignedSalonIds: payload.assignedSalonIds,
      permissions: payload.permissions,
      studioId: payload.studioId,
      studioCode: studio.studioCode,
    });
  } catch (err) {
    console.error('Login error:', err && err.message);
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
