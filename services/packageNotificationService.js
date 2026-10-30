const { Op } = require('sequelize');
const {
  Member,
  MemberLessonPackage,
  LessonPackage,
  Attendance,
  NotificationJob,
} = require('../models');
const {
  enqueueNotification,
  resolveMemberRecipient,
  resolveInstructorRecipientForMember,
  resolveAdminRecipients,
  getStudioNotificationSettings,
} = require('./notificationService');
const { getStudioLocalDate } = require('./instructorFeeHistoryService');

const EXPIRY_WARNING_DAYS = 7;
const INACTIVITY_DAYS = 14;

function addDaysToDateString(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(aStr, bStr) {
  return Math.round((Date.parse(bStr) - Date.parse(aStr)) / 86400000);
}

// Builds the member + assigned instructor + admin recipient notification list.
// Instructor is resolved per member (assigned only); admins are same-studio.
async function buildMemberInstructorAdminNotifications({ studioId, memberId, type, title, body, payload }) {
  const notifications = [];
  const memberAccountId = await resolveMemberRecipient(studioId, memberId);
  if (memberAccountId) {
    notifications.push({ recipientType: 'member', recipientId: memberAccountId, type, title, body, payload });
  }
  const instructorId = await resolveInstructorRecipientForMember(studioId, memberId);
  if (instructorId) {
    notifications.push({ recipientType: 'instructor', recipientId: instructorId, type, title, body, payload });
  }
  const adminIds = await resolveAdminRecipients(studioId);
  for (const adminId of adminIds) {
    notifications.push({ recipientType: 'admin', recipientId: adminId, type, title, body, payload });
  }
  return notifications;
}

// --- 1. New package assignment: notify member once ---
async function notifyPackageAssigned(assignment, { studioId }) {
  const memberAccountId = await resolveMemberRecipient(studioId, assignment.memberId);
  if (!memberAccountId) return;
  const pkg = await LessonPackage.findOne({ where: { id: assignment.lessonPackageId, studioId } });
  await enqueueNotification({
    studioId,
    type: 'package_assigned',
    dedupKey: `package_assigned:${assignment.id}`,
    payload: {
      notifications: [{
        recipientType: 'member',
        recipientId: memberAccountId,
        type: 'package_assigned',
        title: 'Paket Atandı',
        body: `Yeni ders paketiniz atandı${pkg ? `: ${pkg.name}` : ''}.`,
        payload: { memberLessonPackageId: assignment.id, lessonPackageId: assignment.lessonPackageId },
      }],
    },
  });
}

// --- 2. Remaining lessons threshold (2 / 0), once per package cycle ---
// Detects threshold crossing after attendance. Dedup key includes the member and
// the threshold and the current "cycle" (number of packages assigned), so a
// renewal (new package) resets eligibility while repeated attendance does not
// re-fire within the same cycle.
async function checkRemainingLessonsThreshold(memberId, { studioId }) {
  const member = await Member.findOne({
    where: { id: memberId, studioId, isActive: true, deletedAt: null },
    attributes: ['id', 'remainingLessons', 'assignedInstructorId'],
  });
  if (!member) return;

  const settings = await getStudioNotificationSettings(studioId);
  if (settings.packageAlertsEnabled === false) return;

  const remaining = Number(member.remainingLessons);
  const lowThreshold = Number(settings.lowLessonsThreshold);
  if (remaining !== lowThreshold && remaining !== 0) return;

  // Cycle = number of package assignments (renewal creates a new cycle).
  const cycle = await MemberLessonPackage.count({ where: { memberId, studioId } });

  const type = 'package_low_lessons';
  const title = remaining === 0 ? 'Ders Paketi Bitti' : 'Ders Paketi Azalıyor';
  const body = remaining === 0
    ? 'Üyenin ders paketinde ders kalmadı.'
    : `Üyenin ders paketinde ${lowThreshold} ders kaldı.`;

  const notifications = await buildMemberInstructorAdminNotifications({
    studioId, memberId, type, title, body,
    payload: { memberId, remainingLessons: remaining, cycle },
  });
  if (notifications.length === 0) return;

  await enqueueNotification({
    studioId,
    type,
    dedupKey: `package_low_lessons:${memberId}:${remaining}:cycle:${cycle}`,
    payload: { notifications },
  });
}

// --- 3. Package expiration: 7 days before expiry (studio-local) ---
async function checkPackageExpiry({ studioId, now = new Date() } = {}) {
  const settings = await getStudioNotificationSettings(studioId);
  if (settings.packageAlertsEnabled === false) return { enqueued: 0 };

  const today = await getStudioLocalDate(studioId, now);
  if (!today) return { enqueued: 0 };
  const expiryDays = Number(settings.packageExpiryDays);
  const warningDate = addDaysToDateString(today, expiryDays);

  const assignments = await MemberLessonPackage.findAll({
    where: { studioId, expiresAt: { [Op.not]: null } },
    include: [{ model: Member, attributes: ['id', 'isActive', 'deletedAt'] }],
  });

  let enqueued = 0;
  for (const assignment of assignments) {
    if (!assignment.Member || assignment.Member.isActive !== true || assignment.Member.deletedAt) continue;
    const expiresAt = String(assignment.expiresAt);
    if (expiresAt !== warningDate) continue; // fire exactly 7 days before

    const notifications = await buildMemberInstructorAdminNotifications({
      studioId,
      memberId: assignment.memberId,
      type: 'package_expiring',
      title: 'Ders Paketi Sona Eriyor',
      body: `Ders paketiniz ${expiresAt} tarihinde sona erecek.`,
      payload: { memberLessonPackageId: assignment.id, expiresAt },
    });
    if (notifications.length === 0) continue;

    const { created } = await enqueueNotification({
      studioId,
      type: 'package_expiring',
      dedupKey: `package_expiring:${assignment.id}:${expiresAt}`,
      payload: { notifications },
    });
    if (created) enqueued += 1;
  }
  return { enqueued };
}

// --- 4. Payment reminders: member-level cycle anchored on latest package assignment ---
// Business rules: no installments, no due dates, no per-package debt. Member.totalDebt
// is the only debt source. The reminder cycle anchors on the LATEST MemberLessonPackage
// assignedAt (a new package restarts the cycle for the outstanding balance). Only
// assignments on/after the studio's paymentRemindersActivatedAt boundary start cycles
// (no retroactive reminders for historical assignments). Never notify instructors.
async function checkPaymentReminders({ studioId, now = new Date() } = {}) {
  const settings = await getStudioNotificationSettings(studioId);
  if (settings.paymentAlertsEnabled === false) return { enqueued: 0 };
  const activatedAt = settings.paymentRemindersActivatedAt;
  if (!activatedAt) return { enqueued: 0 }; // not activated -> no payment reminders

  const today = await getStudioLocalDate(studioId, now);
  if (!today) return { enqueued: 0 };

  // Active members with outstanding debt.
  const members = await Member.findAll({
    where: { studioId, isActive: true, deletedAt: null, totalDebt: { [Op.gt]: 0 } },
    attributes: ['id', 'totalDebt'],
  });

  let enqueued = 0;
  for (const member of members) {
    // Latest package assignment on/after the activation boundary = cycle anchor.
    const latestAssignment = await MemberLessonPackage.findOne({
      where: { memberId: member.id, studioId },
      order: [['assignedAt', 'DESC'], ['id', 'DESC']],
      attributes: ['id', 'assignedAt'],
    });
    if (!latestAssignment) continue; // no package -> no anchor -> no reminder

    const assignedDate = await getStudioLocalDate(studioId, new Date(latestAssignment.assignedAt));
    if (!assignedDate) continue;
    if (assignedDate < String(activatedAt)) continue; // historical -> no retroactive reminder

    const daysSince = daysBetween(assignedDate, today);
    const isAdminDay = daysSince === 3 || daysSince === 7;
    const isMemberDay = daysSince === 7;
    if (!isAdminDay && !isMemberDay) continue;

    const type = 'payment_overdue';
    const title = 'Ödeme Hatırlatması';
    const body = `Ödemeniz paket atamasından ${daysSince} gün sonra hala bekliyor.`;
    const payload = { memberId: member.id, cycleAssignmentId: latestAssignment.id, daysSince, totalDebt: Number(member.totalDebt) };

    // Day 3 and 7: admins. Never instructors.
    if (isAdminDay) {
      const adminIds = await resolveAdminRecipients(studioId);
      const adminNotifications = adminIds.map((adminId) => ({
        recipientType: 'admin', recipientId: adminId, type, title, body, payload,
      }));
      if (adminNotifications.length > 0) {
        const { created } = await enqueueNotification({
          studioId,
          type,
          dedupKey: `payment_reminder:admin:${member.id}:cycle:${latestAssignment.id}:day${daysSince}`,
          payload: { notifications: adminNotifications, paymentCycle: { memberId: member.id, assignmentId: latestAssignment.id, day: daysSince } },
        });
        if (created) enqueued += 1;
      }
    }

    // Day 7: member too.
    if (isMemberDay) {
      const memberAccountId = await resolveMemberRecipient(studioId, member.id);
      if (memberAccountId) {
        const { created } = await enqueueNotification({
          studioId,
          type,
          dedupKey: `payment_reminder:member:${member.id}:cycle:${latestAssignment.id}:day${daysSince}`,
          payload: { notifications: [{ recipientType: 'member', recipientId: memberAccountId, type, title, body, payload }], paymentCycle: { memberId: member.id, assignmentId: latestAssignment.id, day: daysSince } },
        });
        if (created) enqueued += 1;
      }
    }
  }
  return { enqueued };
}

// --- 5. Member inactivity: 14 days without attendance ---
// Members with no attendance history are skipped (no invented dates).
async function checkMemberInactivity({ studioId, now = new Date() } = {}) {
  const settings = await getStudioNotificationSettings(studioId);
  if (settings.inactivityAlertsEnabled === false) return { enqueued: 0 };

  const today = await getStudioLocalDate(studioId, now);
  if (!today) return { enqueued: 0 };

  const members = await Member.findAll({
    where: { studioId, isActive: true, deletedAt: null },
    attributes: ['id', 'assignedInstructorId'],
  });

  let enqueued = 0;
  for (const member of members) {
    const lastAttendance = await Attendance.findOne({
      where: { memberId: member.id, studioId },
      order: [['date', 'DESC']],
      attributes: ['date'],
    });
    if (!lastAttendance) continue; // no attendance history -> skip (no invented date)

    const lastDate = await getStudioLocalDate(studioId, new Date(lastAttendance.date));
    if (!lastDate) continue;
    const inactivityDays = Number(settings.inactivityDays);
    const daysInactive = daysBetween(lastDate, today);
    if (daysInactive !== inactivityDays) continue; // fire exactly at the threshold

    // Recipients: assigned instructor + admins (NOT the member).
    const inactivityBody = `Üye ${inactivityDays} gündür derse katılmadı.`;
    const notifications = [];
    const instructorId = await resolveInstructorRecipientForMember(studioId, member.id);
    if (instructorId) {
      notifications.push({
        recipientType: 'instructor', recipientId: instructorId,
        type: 'member_inactive', title: 'Üye İnaktif',
        body: inactivityBody,
        payload: { memberId: member.id, daysInactive },
      });
    }
    const adminIds = await resolveAdminRecipients(studioId);
    for (const adminId of adminIds) {
      notifications.push({
        recipientType: 'admin', recipientId: adminId,
        type: 'member_inactive', title: 'Üye İnaktif',
        body: inactivityBody,
        payload: { memberId: member.id, daysInactive },
      });
    }
    if (notifications.length === 0) continue;

    // Dedup per member per day -> no daily duplicates.
    const { created } = await enqueueNotification({
      studioId,
      type: 'member_inactive',
      dedupKey: `member_inactive:${member.id}:${today}`,
      payload: { notifications },
    });
    if (created) enqueued += 1;
  }
  return { enqueued };
}

module.exports = {
  EXPIRY_WARNING_DAYS,
  INACTIVITY_DAYS,
  notifyPackageAssigned,
  checkRemainingLessonsThreshold,
  checkPackageExpiry,
  checkPaymentReminders,
  checkMemberInactivity,
};
