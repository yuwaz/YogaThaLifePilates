const jwt = require('jsonwebtoken');
const { User } = require('../models');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

// Authenticate JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.sendStatus(403);
    console.log('[DEBUG] Decoded JWT payload:', decoded);
    // Defensive: ensure permissions, assignedSalonIds are arrays if present as JSON strings
    let user = { ...decoded };
    if (typeof user.permissions === 'string') {
      try { user.permissions = JSON.parse(user.permissions); } catch { user.permissions = []; }
    }
    if (typeof user.assignedSalonIds === 'string') {
      try { user.assignedSalonIds = JSON.parse(user.assignedSalonIds); } catch { user.assignedSalonIds = []; }
    }
    req.user = user;
    console.log('[DEBUG] req.user after auth middleware:', req.user);
    next();
  });
}

// Role-based access
function authorizeRoles(roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.sendStatus(403);
    next();
  };
}

// Instructor can only access assigned salons
function authorizeInstructorSalon(salonIdField = 'salonId') {
  return (req, res, next) => {
    if (req.user.role === 'admin') return next();
    const salonId = req.body[salonIdField] || req.params[salonIdField];
    if (!req.user.assignedSalonIds.includes(Number(salonId))) return res.sendStatus(403);
    next();
  };
}

module.exports = { authenticateToken, authorizeRoles, authorizeInstructorSalon };
