const { Op } = require('sequelize');
const { sequelize, Notification, NotificationJob, Reservation, Member, MemberLessonPackage, User } = require('../models');
const { enqueuePushDeliveries } = require('./pushDeliveryService');

const BASE_BACKOFF_MS = 60 * 1000; // 1 minute
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1 hour
const STALE_PROCESSING_MS = 10 * 60 * 1000; // reclaim jobs stuck 'processing' > 10 min (crash recovery)

function computeBackoffMs(attemptCount) {
  const backoff = BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attemptCount - 1));
  return Math.min(backoff, MAX_BACKOFF_MS);
}

// Atomically claims one due job by transitioning pending -> processing.
// The single UPDATE ... WHERE processingState='pending' is atomic in SQLite;
// only one concurrent worker's UPDATE matches, so the same job is never claimed twice.
async function claimNextDueJob(now = new Date()) {
  const candidate = await NotificationJob.findOne({
    where: {
      processingState: 'pending',
      nextAttemptAt: { [Op.lte]: now },
    },
    order: [['nextAttemptAt', 'ASC'], ['id', 'ASC']],
  });
  if (!candidate) return null;

  const [updated] = await NotificationJob.update(
    { processingState: 'processing', attemptCount: candidate.attemptCount + 1 },
    {
      where: { id: candidate.id, processingState: 'pending' },
    }
  );
  if (updated !== 1) return null; // claimed by another worker
  return NotificationJob.findOne({ where: { id: candidate.id } });
}

// Reclaims jobs stuck in 'processing' beyond the crash window back to 'pending'.
// Normalizes the ISO 'T' separator so datetime() comparison works regardless of
// whether updatedAt was stored by Sequelize (ISO) or raw SQL.
async function recoverStaleJobs(now = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
  const staleBeforeStr = staleBefore.toISOString().replace('T', ' ').replace('Z', '');
  const [recovered] = await NotificationJob.update(
    { processingState: 'pending' },
    {
      where: {
        processingState: 'processing',
        [Op.and]: [
          sequelize.where(
            sequelize.fn('REPLACE', sequelize.col('updatedAt'), 'T', ' '),
            { [Op.lte]: staleBeforeStr }
          ),
        ],
      },
    }
  );
  return recovered;
}

// Default handler: materialize in-app Notification rows from the job payload.
// Payload shape: { notifications: [{ recipientType, recipientId, type, title, body, payload }] }.
// Real triggers are added in later phases; this only writes inbox rows.
function parsePayload(payload) {
  if (payload && typeof payload === 'object') return payload;
  if (typeof payload === 'string') {
    try { return JSON.parse(payload); } catch { return null; }
  }
  return null;
}

async function defaultJobHandler(job) {
  const payload = parsePayload(job.payload);
  const notifications = payload && Array.isArray(payload.notifications)
    ? payload.notifications
    : [];
  if (notifications.length === 0) return { created: 0 };

  // Crash-safe idempotency via durable per-recipient delivery keys (unique per
  // job+studio+recipient). The inbox INSERT and the job's notificationId link
  // happen in ONE transaction; a retry after a crash finds existing rows by
  // deliveryKey and does not duplicate.
  return sequelize.transaction(async (transaction) => {
    let createdCount = 0;
    let firstNotificationId = null;

    for (let i = 0; i < notifications.length; i++) {
      const n = notifications[i];
      const deliveryKey = `job:${job.id}:${n.recipientType}:${n.recipientId}`;

      const existing = await Notification.findOne({
        where: { studioId: job.studioId, deliveryKey },
        transaction,
      });
      if (existing) {
        if (!firstNotificationId) firstNotificationId = existing.id;
        continue; // already delivered (retry after crash)
      }

      const row = {
        studioId: job.studioId,
        recipientType: n.recipientType,
        recipientId: n.recipientId,
        type: n.type || job.type,
        title: n.title || '',
        body: n.body || null,
        payload: n.payload || null,
        deliveryKey,
      };

      let created;
      try {
        created = await Notification.create(row, { transaction });
      } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
          continue; // concurrent delivery created it first
        }
        throw error;
      }
      if (created) {
        createdCount += 1;
        if (!firstNotificationId) firstNotificationId = created.id;
        // Enqueue push deliveries for eligible devices (never fails inbox delivery).
        await enqueuePushDeliveries(created, { transaction });
      }
    }

    if (firstNotificationId && !job.notificationId) {
      await job.update({ notificationId: firstNotificationId }, { transaction });
    }
    return { created: createdCount };
  });
}

// class_reminder handler: verifies the reservation still exists and is in the
// future, and re-resolves the recipient before delivering. Returns { skipped: true }
// (without creating a notification) when the class was cancelled or is past.
async function classReminderJobHandler(job) {
  const payload = parsePayload(job.payload);
  if (!payload) return { created: 0 };

  const now = new Date();
  if (payload.kind === 'member' && payload.reservationId) {
    const reservation = await Reservation.findOne({
      where: { id: payload.reservationId, studioId: job.studioId },
    });
    if (!reservation) return { created: 0, skipped: 'cancelled' };
    // Verify still future (date+time in studio-local terms stored on reservation).
    const slotUtc = new Date(`${reservation.date}T${reservation.time}Z`);
    if (!Number.isNaN(slotUtc.getTime()) && slotUtc <= now) {
      return { created: 0, skipped: 'past' };
    }
  }

  if (payload.kind === 'instructor' && payload.slotDate) {
    // Re-resolve the instructor from CURRENT slot attendees' assignedInstructorId.
    // Never use Attendance.instructorId (may not exist before the class). Only
    // notify the instructor if they still have an assigned member in this slot.
    const slotReservations = await Reservation.findAll({
      where: { studioId: job.studioId, date: payload.slotDate, time: payload.slotTime, salonId: payload.salonId },
      attributes: ['memberId'],
    });
    if (slotReservations.length === 0) return { created: 0, skipped: 'cancelled' };

    const memberIds = slotReservations.map((r) => r.memberId);
    const members = await Member.findAll({
      where: { id: { [Op.in]: memberIds }, studioId: job.studioId, isActive: true, deletedAt: null },
      attributes: ['id', 'assignedInstructorId'],
    });
    const assignedInstructorIds = new Set(
      members.map((m) => Number(m.assignedInstructorId)).filter((id) => Number.isInteger(id) && id > 0)
    );
    const targetInstructorId = Number(payload.instructorId);
    if (!assignedInstructorIds.has(targetInstructorId)) {
      return { created: 0, skipped: 'reassigned' }; // instructor no longer has a member in this slot
    }
    // Verify the instructor still belongs to this studio.
    const instructor = await User.findOne({
      where: { id: targetInstructorId, studioId: job.studioId, role: 'instructor' },
      attributes: ['id'],
    });
    if (!instructor) return { created: 0, skipped: 'instructor-not-in-studio' };

    // Build the notification with the revalidated instructor recipient.
    // Mutate the job's payload so defaultJobHandler (which needs the instance
    // for job.update) writes the revalidated notification.
    job.payload = {
      ...payload,
      notifications: [{
        recipientType: 'instructor',
        recipientId: targetInstructorId,
        type: 'class_reminder',
        title: 'Ders Hatırlatması',
        body: `${payload.slotDate} ${payload.slotTime} tarihinde dersiniz var.`,
        payload: { date: payload.slotDate, time: payload.slotTime, salonId: payload.salonId },
      }],
    };
    return defaultJobHandler(job);
  }

  return defaultJobHandler(job);
}

// Delivery-time revalidation for scheduled (non-event) jobs. Each returns
// { skipped: true } (no notification) when the state that triggered the job no
// longer holds, so obsolete/invalid jobs are safely skipped.

// payment_overdue: member active, cycle is current (latest assignment matches),
// and totalDebt still > 0.
async function paymentReminderJobHandler(job) {
  const payload = parsePayload(job.payload);
  if (!payload || !payload.paymentCycle) return defaultJobHandler(job);
  const { memberId, assignmentId } = payload.paymentCycle;

  const member = await Member.findOne({
    where: { id: memberId, studioId: job.studioId, isActive: true, deletedAt: null },
    attributes: ['id', 'totalDebt'],
  });
  if (!member) return { created: 0, skipped: 'member-inactive' };
  if (Number(member.totalDebt) <= 0) return { created: 0, skipped: 'debt-paid' };

  // Cycle must still be the latest assignment (a newer package resets the cycle).
  const latest = await MemberLessonPackage.findOne({
    where: { memberId, studioId: job.studioId },
    order: [['assignedAt', 'DESC'], ['id', 'DESC']],
    attributes: ['id'],
  });
  if (!latest || Number(latest.id) !== Number(assignmentId)) {
    return { created: 0, skipped: 'cycle-superseded' };
  }

  return defaultJobHandler(job);
}

// package_expiring: member active and expiresAt still matches the scheduled alert.
async function packageExpiringJobHandler(job) {
  const payload = parsePayload(job.payload);
  const notification = payload && Array.isArray(payload.notifications) && payload.notifications[0];
  const assignmentId = notification && notification.payload && notification.payload.memberLessonPackageId;
  const expiresAt = notification && notification.payload && notification.payload.expiresAt;
  if (!assignmentId || !expiresAt) return defaultJobHandler(job);

  const assignment = await MemberLessonPackage.findOne({
    where: { id: assignmentId, studioId: job.studioId },
    include: [{ model: Member, attributes: ['id', 'isActive', 'deletedAt'] }],
  });
  if (!assignment || !assignment.Member || assignment.Member.isActive !== true || assignment.Member.deletedAt) {
    return { created: 0, skipped: 'member-inactive' };
  }
  if (String(assignment.expiresAt) !== String(expiresAt)) {
    return { created: 0, skipped: 'expiry-changed' };
  }

  return defaultJobHandler(job);
}

// member_inactive: member active and still meets the 14-day inactivity condition.
async function memberInactiveJobHandler(job) {
  const payload = parsePayload(job.payload);
  const notification = payload && Array.isArray(payload.notifications) && payload.notifications[0];
  const memberId = notification && notification.payload && notification.payload.memberId;
  if (!memberId) return defaultJobHandler(job);

  const member = await Member.findOne({
    where: { id: memberId, studioId: job.studioId, isActive: true, deletedAt: null },
    attributes: ['id'],
  });
  if (!member) return { created: 0, skipped: 'member-inactive' };

  // Re-check inactivity: still no attendance in the last 14 days.
  const { Attendance } = require('../models');
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const recentAttendance = await Attendance.findOne({
    where: { memberId, studioId: job.studioId, date: { [Op.gt]: cutoff } },
    attributes: ['id'],
  });
  if (recentAttendance) return { created: 0, skipped: 'no-longer-inactive' };

  return defaultJobHandler(job);
}

// Routes a job to its type-specific handler, falling back to the default.
async function routeJobHandler(job) {
  if (job.type === 'class_reminder') {
    return classReminderJobHandler(job);
  }
  if (job.type === 'payment_overdue') {
    return paymentReminderJobHandler(job);
  }
  if (job.type === 'package_expiring') {
    return packageExpiringJobHandler(job);
  }
  if (job.type === 'member_inactive') {
    return memberInactiveJobHandler(job);
  }
  return defaultJobHandler(job);
}

// Processes due jobs: claim -> handle -> done, or retry with backoff / fail.
// handler is injectable for tests. Returns the number of jobs processed.
async function processDueJobs({ handler = routeJobHandler, limit = 25, now = new Date() } = {}) {
  await recoverStaleJobs(now);

  let processed = 0;
  while (processed < limit) {
    const job = await claimNextDueJob(now);
    if (!job) break;

    try {
      await handler(job);
      await job.update({
        processingState: 'done',
        processedAt: new Date(),
        lastError: null,
      });
    } catch (error) {
      const attempts = Number(job.attemptCount);
      const exhausted = attempts >= Number(job.maxAttempts);
      await job.update({
        processingState: exhausted ? 'failed' : 'pending',
        nextAttemptAt: exhausted ? null : new Date(Date.now() + computeBackoffMs(attempts)),
        lastError: String((error && error.message) || error || 'Unknown error'),
      });
    }
    processed += 1;
  }
  return processed;
}

module.exports = {
  computeBackoffMs,
  claimNextDueJob,
  recoverStaleJobs,
  processDueJobs,
  defaultJobHandler,
  classReminderJobHandler,
  paymentReminderJobHandler,
  packageExpiringJobHandler,
  memberInactiveJobHandler,
  routeJobHandler,
  STALE_PROCESSING_MS,
};
