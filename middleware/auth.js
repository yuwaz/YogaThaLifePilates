const jwt = require('jsonwebtoken');
const { User } = require('../models');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

// Authenticate JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
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
