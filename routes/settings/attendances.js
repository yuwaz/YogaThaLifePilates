const express = require('express');
const { authenticateToken } = require('../../middleware/auth');
const requireActiveSubscription = require('../../middleware/requireActiveSubscription');
// Custom middleware for attendance permissions
function attendancePermission(requiredPermission) {
  return (req, res, next) => {
    const { role, permissions, assignedSalonIds } = req.user;
    console.log('[DEBUG] role:', role);
    console.log('[DEBUG] permissions:', permissions, 'type:', Array.isArray(permissions) ? 'array' : typeof permissions);
    console.log('[DEBUG] assignedSalonIds:', assignedSalonIds);
    console.log('[DEBUG] requiredPermission:', requiredPermission);

    // Ensure permissions is always an array
    let perms = permissions;
    if (!Array.isArray(perms)) {
      if (typeof perms === 'string') {
        try {
          perms = JSON.parse(perms);
        } catch {
          perms = [perms];
        }
      } else if (!perms) {
        perms = [];
      } else {
        perms = Array.from(perms);
      }
    }

    if (role === 'admin') {
      return next();
    }
    if (role === 'instructor') {
      if (!perms.includes(requiredPermission)) {
        console.log('[DEBUG] 403: Instructor missing permission:', requiredPermission, 'actual:', perms);
        return res.status(403).json({ error: 'Forbidden: missing permission', perms, requiredPermission });
      }
      // For POST, check salonId in assignedSalonIds
      if (req.method === 'POST') {
        const salonId = req.body.salonId;
        if (!salonId || !assignedSalonIds.includes(Number(salonId))) {
          console.log('[DEBUG] 403: Instructor not assigned to salon:', salonId);
          return res.status(403).json({ error: 'Forbidden: not assigned to salon' });
        }
      }
      return next();
    }
    console.log('[DEBUG] 403: Role not allowed:', role);
    return res.status(403).json({ error: 'Forbidden: role not allowed' });
  };
}
const {
  getAttendance,
  addAttendance,
  updateAttendance,
  deleteAttendance,
} = require('../../controllers/attendanceController');

const router = express.Router();

router.use(authenticateToken);
router.use(requireActiveSubscription);


// GET: restrict to assigned salons for instructors

router.get('/', (req, res, next) => {
  console.log('[DEBUG] req.user before permission middleware:', req.user);
  next();
}, attendancePermission('attendances'), (req, res, next) => {
  if (req.user.role === 'instructor') {
    // Patch req.query to filter by assignedSalonIds
    req.query.assignedSalonIds = req.user.assignedSalonIds;
  }
  return getAttendance(req, res, next);
});

// POST: instructor must have salonId in assignedSalonIds
router.post('/', (req, res, next) => {
  console.log('[DEBUG] req.user before permission middleware:', req.user);
  next();
}, attendancePermission('attendances'), addAttendance);

// PUT/DELETE: only admin for now (can extend if needed)
router.put('/:id', attendancePermission('attendances'), updateAttendance);
router.delete('/:id', attendancePermission('attendances'), deleteAttendance);

module.exports = router;
