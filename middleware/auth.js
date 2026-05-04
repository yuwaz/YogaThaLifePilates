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


// Page-level permission middleware
// Usage: authorizePagePermission('payments'), authorizePagePermission('members'), etc.
function authorizePagePermission(pageKey) {
  return (req, res, next) => {
    const { role, permissions } = req.user;
    // Admin always allowed
    if (role === 'admin') return next();
    // Defensive: ensure permissions is array
    let perms = permissions;
    if (!Array.isArray(perms)) {
      if (typeof perms === 'string') {
        try { perms = JSON.parse(perms); } catch { perms = [perms]; }
      } else if (!perms) {
        perms = [];
      } else {
        perms = Array.from(perms);
      }
    }
    // Allow if user has pageKey (e.g. 'payments')
    if (perms.includes(pageKey)) return next();
    // Allow if user has any permission starting with pageKey + ':'
    if (perms.some(p => typeof p === 'string' && p.startsWith(pageKey + ':'))) return next();
    // Forbidden
    return res.status(403).json({ error: 'Forbidden: missing permission', perms, required: pageKey });
  };
}

// Action-level permission middleware with fallback to page-level
// Usage: authorizeActionPermission('payments:create'), etc.
function authorizeActionPermission(required) {
  return (req, res, next) => {
    const { role, permissions } = req.user;
    if (role === 'admin') return next();
    let perms = permissions;
    if (!Array.isArray(perms)) {
      if (typeof perms === 'string') {
        try { perms = JSON.parse(perms); } catch { perms = [perms]; }
      } else if (!perms) {
        perms = [];
      } else {
        perms = Array.from(perms);
      }
    }
    if (perms.includes(required)) return next();
    const baseKey = required.split(':')[0];
    // Fallback: allow if user has base page permission (e.g. 'payments')
    if (perms.includes(baseKey)) return next();
    // Special: allow 'settings' for any settings:* action
    if (baseKey === 'settings' && perms.includes('settings')) return next();
    return res.status(403).json({ error: 'Forbidden: missing permission', perms, required });
  };
}

module.exports = { authenticateToken, authorizeRoles, authorizeInstructorSalon, authorizePagePermission, authorizeActionPermission };
