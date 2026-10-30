const { Op } = require('sequelize');
const {
  sequelize,
  Notification,
  NotificationJob,
  StudioNotificationSettings,
  Studio,
  User,
  Member,
  MemberAccount,
  MemberAccountMembership,
} = require('../models');

const DEFAULT_QUIET_START = '21:00';
const DEFAULT_QUIET_END = '09:00';
const DEFAULT_TIMEZONE = 'Europe/Istanbul';

const SETTINGS_DEFAULTS = Object.freeze({
  quietHoursStart: DEFAULT_QUIET_START,
  quietHoursEnd: DEFAULT_QUIET_END,
  classReminderEnabled: true,
  packageAlertsEnabled: true,
  paymentAlertsEnabled: true,
  inactivityAlertsEnabled: true,
  paymentRemindersActivatedAt: null,
  memberReminderMinutes: 120,
  instructorReminderMinutes: 60,
  lowLessonsThreshold: 2,
  packageExpiryDays: 7,
  inactivityDays: 14,
});

class NotificationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function parseTimeToMinutes(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function localDateTimeParts(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const year = get('year'); const month = get('month'); const day = get('day');
    const hour = get('hour'); const minute = get('minute');
    if (!year || !month || !day || !hour || !minute) return null;
    return { date: `${year}-${month}-${day}`, minutes: Number(hour) * 60 + Number(minute) };
  } catch {
    return null;
  }
}

async function getStudioTimezone(studioId) {
  const studio = await Studio.findOne({ where: { id: studioId }, attributes: ['timezone'] });
  return (studio && studio.timezone) || DEFAULT_TIMEZONE;
}

async function getStudioNotificationSettings(studioId) {
  const settings = await StudioNotificationSettings.findOne({ where: { studioId } });
  if (!settings) {
    return { ...SETTINGS_DEFAULTS };
  }
  return {
    quietHoursStart: settings.quietHoursStart || DEFAULT_QUIET_START,
    quietHoursEnd: settings.quietHoursEnd || DEFAULT_QUIET_END,
    classReminderEnabled: settings.classReminderEnabled !== false,
    packageAlertsEnabled: settings.packageAlertsEnabled !== false,
    paymentAlertsEnabled: settings.paymentAlertsEnabled !== false,
    inactivityAlertsEnabled: settings.inactivityAlertsEnabled !== false,
    paymentRemindersActivatedAt: settings.paymentRemindersActivatedAt || null,
    memberReminderMinutes: settings.memberReminderMinutes != null ? Number(settings.memberReminderMinutes) : 120,
    instructorReminderMinutes: settings.instructorReminderMinutes != null ? Number(settings.instructorReminderMinutes) : 60,
    lowLessonsThreshold: settings.lowLessonsThreshold != null ? Number(settings.lowLessonsThreshold) : 2,
    packageExpiryDays: settings.packageExpiryDays != null ? Number(settings.packageExpiryDays) : 7,
    inactivityDays: settings.inactivityDays != null ? Number(settings.inactivityDays) : 14,
  };
}

// Returns true when the given studio-local wall-clock minutes fall inside the
// quiet window. Handles overnight windows (e.g. 21:00 -> 09:00).
function isWithinQuietHours(minutes, startMinutes, endMinutes) {
  if (startMinutes === null || endMinutes === null) return false;
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) {
    return minutes >= startMinutes && minutes < endMinutes;
  }
  return minutes >= startMinutes || minutes < endMinutes;
}

// Computes the next studio-local Date at quiet-hours end (e.g. 09:00) after `date`.
function nextQuietHoursEnd(date, timeZone, endMinutes) {
  // Resolve the studio-local date for `date`, then build end time on that date;
  // if already past end, roll to the next day. Computed via UTC offset iteration.
  const parts = localDateTimeParts(date, timeZone);
  if (!parts) return date;
  // Candidate: end time on the local date of `date`.
  const [year, month, day] = parts.date.split('-').map(Number);
  const endHour = Math.floor(endMinutes / 60);
  const endMinute = endMinutes % 60;
  // Build a UTC guess then correct by the timezone offset at that instant.
  function zonedTimeToUtc(y, mo, d, h, mi) {
    const utcGuess = Date.UTC(y, mo - 1, d, h, mi);
    const guessDate = new Date(utcGuess);
    const localParts = localDateTimeParts(guessDate, timeZone);
    if (!localParts) return guessDate;
    const [ly, lmo, ld] = localParts.date.split('-').map(Number);
    const localMinutes = localParts.minutes;
    const wantedMinutes = h * 60 + mi;
    const dayDiff = (Date.UTC(ly, lmo - 1, ld) - Date.UTC(y, mo - 1, d)) / 86400000;
    const diffMinutes = (dayDiff * 1440) + (localMinutes - wantedMinutes);
    return new Date(utcGuess - diffMinutes * 60000);
  }
  let candidate = zonedTimeToUtc(year, month, day, endHour, endMinute);
  if (candidate <= date) {
    const nextDay = new Date(Date.UTC(year, month - 1, day) + 86400000);
    candidate = zonedTimeToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), endHour, endMinute);
  }
  return candidate;
}

// Applies quiet-hours deferral for routine alerts. Urgent alerts bypass.
// Returns the Date at which the job should be scheduled.
async function applyQuietHours({ studioId, scheduledAt, urgent }) {
  const when = scheduledAt ? new Date(scheduledAt) : new Date();
  if (Number.isNaN(when.getTime())) throw new NotificationError('Invalid scheduledAt');
  if (urgent) return when;

  const timeZone = await getStudioTimezone(studioId);
  const settings = await getStudioNotificationSettings(studioId);
  const startMinutes = parseTimeToMinutes(settings.quietHoursStart);
  const endMinutes = parseTimeToMinutes(settings.quietHoursEnd);
  const local = localDateTimeParts(when, timeZone);
  if (!local || startMinutes === null || endMinutes === null) return when;

  if (!isWithinQuietHours(local.minutes, startMinutes, endMinutes)) return when;
  return nextQuietHoursEnd(when, timeZone, endMinutes);
}

// Enqueues a notification job with a unique dedup key. Returns { job, created }.
// Revival safety: a job with the same dedupKey is revived ONLY when it was
// explicitly cancelled/superseded (lastError='cancelled') — i.e. a legitimate
// rebooking of a cancelled slot. Successfully delivered jobs (done with a
// notificationId) and exhausted failures are NEVER revived, preserving dedup.
async function enqueueNotification({ studioId, type, dedupKey, payload, scheduledAt, urgent = false, maxAttempts = 5 }) {
  if (!Number.isInteger(Number(studioId)) || Number(studioId) <= 0) {
    throw new NotificationError('Invalid studioId');
  }
  if (typeof type !== 'string' || !type.trim()) throw new NotificationError('Invalid type');
  if (typeof dedupKey !== 'string' || !dedupKey.trim()) throw new NotificationError('Invalid dedupKey');

  const effectiveScheduledAt = await applyQuietHours({ studioId, scheduledAt, urgent });
  const key = dedupKey.trim();

  const existing = await NotificationJob.findOne({ where: { studioId, dedupKey: key } });
  if (existing) {
    const wasCancelled = existing.processingState === 'done' && existing.lastError === 'cancelled';
    if (wasCancelled) {
      // Revive for rebooking: reset state, new schedule/payload, clear prior link.
      await existing.update({
        type: type.trim(),
        payload: payload || null,
        scheduledAt: effectiveScheduledAt,
        processingState: 'pending',
        attemptCount: 0,
        maxAttempts,
        nextAttemptAt: effectiveScheduledAt,
        processedAt: null,
        notificationId: null,
        lastError: null,
      });
      return { job: existing, created: true, revived: true };
    }
    // Delivered, failed, pending, or processing -> never revive.
    return { job: existing, created: false };
  }

  try {
    const job = await NotificationJob.create({
      studioId,
      type: type.trim(),
      dedupKey: key,
      payload: payload || null,
      scheduledAt: effectiveScheduledAt,
      processingState: 'pending',
      attemptCount: 0,
      maxAttempts,
      nextAttemptAt: effectiveScheduledAt,
    });
    return { job, created: true };
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      const raced = await NotificationJob.findOne({ where: { studioId, dedupKey: key } });
      return { job: raced, created: false };
    }
    throw error;
  }
}

// --- Studio-scoped recipient resolution ---

// Admins of the studio (role 'admin'). Returns User ids.
async function resolveAdminRecipients(studioId) {
  const admins = await User.findAll({
    where: { studioId, role: 'admin' },
    attributes: ['id'],
  });
  return admins.map((u) => Number(u.id));
}

// Instructor recipient for a member: only the member's assigned instructor,
// and only if that instructor belongs to the same studio. Returns User id or null.
async function resolveInstructorRecipientForMember(studioId, memberId) {
  const member = await Member.findOne({
    where: { id: memberId, studioId, isActive: true, deletedAt: null },
    attributes: ['id', 'assignedInstructorId'],
  });
  if (!member || !member.assignedInstructorId) return null;
  const instructor = await User.findOne({
    where: { id: member.assignedInstructorId, studioId, role: 'instructor' },
    attributes: ['id'],
  });
  return instructor ? Number(instructor.id) : null;
}

// Member recipient: the linked global account for the member in this studio.
// Returns MemberAccount id or null.
async function resolveMemberRecipient(studioId, memberId) {
  const membership = await MemberAccountMembership.findOne({
    where: { memberId, studioId },
    attributes: ['accountId'],
  });
  if (!membership) return null;
  const account = await MemberAccount.findOne({
    where: { id: membership.accountId, status: 'active' },
    attributes: ['id'],
  });
  return account ? Number(account.id) : null;
}

module.exports = {
  NotificationError,
  enqueueNotification,
  applyQuietHours,
  isWithinQuietHours,
  resolveAdminRecipients,
  resolveInstructorRecipientForMember,
  resolveMemberRecipient,
  getStudioNotificationSettings,
  SETTINGS_DEFAULTS,
};
