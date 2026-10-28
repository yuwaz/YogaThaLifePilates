const { User } = require('../models');
const { getStudioOwnerUserId } = require('./studioOwnerService');

// Teaching-capable = role 'instructor' OR the Studio's stable owner admin (never later admins).
// Mirrors the eligibility rule used for member.assignedInstructorId and /settings/users/instructors.
async function findTeachingCapableUser(studioId, userId) {
  if (!Number.isInteger(Number(userId)) || Number(userId) <= 0) return null;
  const parsedId = Number(userId);

  const user = await User.findOne({
    where: { id: parsedId, studioId },
    attributes: ['id', 'username', 'role'],
  });
  if (!user) return null;
  if (user.role === 'instructor') return user;

  if (user.role === 'admin') {
    const ownerUserId = await getStudioOwnerUserId(studioId);
    if (ownerUserId !== null && ownerUserId === parsedId) return user;
  }
  return null;
}

// Resolves who actually taught the class for an attendance write.
// Explicit instructorId (any authorized attendance user may select any eligible
// teaching-capable user in the studio) wins; otherwise defaults to the logged-in
// user when teaching-capable; otherwise explicit selection is required.
// Returns { ok: true, instructorId } or { ok: false, status, error }.
async function resolveAttendanceInstructor({ req, studioId, requestedInstructorId }) {
  if (requestedInstructorId !== undefined && requestedInstructorId !== null) {
    const parsed = Number(requestedInstructorId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, status: 400, error: 'instructorId must be a positive integer' };
    }
    const instructor = await findTeachingCapableUser(studioId, parsed);
    if (!instructor) {
      return { ok: false, status: 404, error: 'Instructor not found' };
    }
    return { ok: true, instructorId: parsed };
  }

  const selfId = req && req.user && req.user.id ? Number(req.user.id) : null;
  if (selfId) {
    const self = await findTeachingCapableUser(studioId, selfId);
    if (self) return { ok: true, instructorId: selfId };
  }
  return {
    ok: false,
    status: 400,
    error: 'instructorId is required: select the instructor who taught the class',
  };
}

module.exports = {
  findTeachingCapableUser,
  resolveAttendanceInstructor,
};
