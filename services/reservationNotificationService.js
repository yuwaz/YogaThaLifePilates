const { Op } = require('sequelize');
const {
  Reservation,
  Member,
  NotificationJob,
} = require('../models');
const {
  enqueueNotification,
  resolveMemberRecipient,
  resolveInstructorRecipientForMember,
  getStudioNotificationSettings,
} = require('./notificationService');
const { getStudioLocalDate } = require('./instructorFeeHistoryService');

const MEMBER_REMINDER_LEAD_MS = 2 * 60 * 60 * 1000; // 2 hours (default)
const INSTRUCTOR_REMINDER_LEAD_MS = 1 * 60 * 60 * 1000; // 1 hour (default)

// Builds a UTC Date for a reservation's local date+time in the studio timezone.
function slotDateTimeUtc(dateStr, timeStr, timeZone) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const timeParts = String(timeStr).split(':').map(Number);
  const hours = timeParts[0];
  const minutes = timeParts[1] || 0;
  if (!year || !month || !day || Number.isNaN(hours)) return null;

  const utcGuess = Date.UTC(year, month - 1, day, hours, minutes);
  const guess = new Date(utcGuess);
  // Correct by the timezone offset at that instant.
  const localParts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(guess);
  const get = (t) => localParts.find((p) => p.type === t)?.value;
  const localMinutes = Number(get('hour')) * 60 + Number(get('minute'));
  const wantedMinutes = hours * 60 + minutes;
  const localDate = `${get('year')}-${get('month')}-${get('day')}`;
  const dayDiff = (Date.parse(localDate) - Date.UTC(year, month - 1, day)) / 86400000;
  const diffMinutes = (dayDiff * 1440) + (localMinutes - wantedMinutes);
  return new Date(utcGuess - diffMinutes * 60000);
}

async function getStudioTimezoneById(studioId) {
  const { Studio } = require('../models');
  const studio = await Studio.findOne({ where: { id: studioId }, attributes: ['timezone'] });
  return (studio && studio.timezone) || 'Europe/Istanbul';
}

// Schedules member (2h) and instructor (1h) reminders for one reservation.
// Member reminder: per reservation. Instructor reminder: one per instructor per
// class slot (studio+salon+date+time+instructorId), using Member.assignedInstructorId
// as the source of truth. The instructor is re-resolved at delivery time.
async function scheduleRemindersForReservation(reservation, { studioId, timeZone }) {
  const slotUtc = slotDateTimeUtc(reservation.date, reservation.time, timeZone);
  if (!slotUtc) return;
  const now = new Date();
  if (slotUtc <= now) return; // never remind for past classes

  // Configurable lead times (defaults: member 120 min, instructor 60 min).
  const settings = await getStudioNotificationSettings(studioId);
  if (settings.classReminderEnabled === false) return;
  const memberLeadMs = Number(settings.memberReminderMinutes) * 60 * 1000;
  const instructorLeadMs = Number(settings.instructorReminderMinutes) * 60 * 1000;

  // Member reminder (memberReminderMinutes before).
  const memberAccountId = await resolveMemberRecipient(studioId, reservation.memberId);
  if (memberAccountId) {
    const memberAt = new Date(slotUtc.getTime() - memberLeadMs);
    if (memberAt > now) {
      await enqueueNotification({
        studioId,
        type: 'class_reminder',
        dedupKey: `class_reminder:member:${reservation.id}`,
        scheduledAt: memberAt,
        payload: {
          kind: 'member',
          reservationId: reservation.id,
          notifications: [{
            recipientType: 'member',
            recipientId: memberAccountId,
            type: 'class_reminder',
            title: 'Ders Hatırlatması',
            body: `Dersiniz ${reservation.date} ${reservation.time} tarihinde.`,
            payload: { reservationId: reservation.id, date: reservation.date, time: reservation.time },
          }],
        },
      });
    }
  }

  // Instructor reminder (1h before), one per instructor per class slot.
  // Resolve the member's assigned instructor now for the dedup key; the actual
  // recipient is re-resolved at delivery from current slot attendees.
  const instructorId = await resolveInstructorRecipientForMember(studioId, reservation.memberId);
  if (instructorId) {
    const instructorAt = new Date(slotUtc.getTime() - instructorLeadMs);
    if (instructorAt > now) {
      await enqueueNotification({
        studioId,
        type: 'class_reminder',
        dedupKey: `class_reminder:instructor:${reservation.date}:${reservation.time}:${reservation.salonId}:${instructorId}`,
        scheduledAt: instructorAt,
        payload: {
          kind: 'instructor',
          slotDate: reservation.date,
          slotTime: reservation.time,
          salonId: reservation.salonId,
          instructorId,
          notifications: [],
        },
      });
    }
  }
}

// Single reservation confirmation to the member.
async function notifySingleReservationCreated(reservation, { studioId }) {
  const memberAccountId = await resolveMemberRecipient(studioId, reservation.memberId);
  if (!memberAccountId) return;
  await enqueueNotification({
    studioId,
    type: 'reservation_confirmed',
    dedupKey: `reservation_confirmed:${reservation.id}`,
    payload: {
      notifications: [{
        recipientType: 'member',
        recipientId: memberAccountId,
        type: 'reservation_confirmed',
        title: 'Rezervasyon Onayı',
        body: `Rezervasyonunuz ${reservation.date} ${reservation.time} için onaylandı.`,
        payload: { reservationId: reservation.id, date: reservation.date, time: reservation.time },
      }],
    },
  });
}

// ONE summary confirmation for an entire weekly recurring series.
async function notifySeriesReservationCreated(reservations, { studioId }) {
  if (!reservations || reservations.length === 0) return;
  const first = reservations[0];
  const memberAccountId = await resolveMemberRecipient(studioId, first.memberId);
  if (!memberAccountId) return;
  await enqueueNotification({
    studioId,
    type: 'reservation_series_confirmed',
    dedupKey: `reservation_series_confirmed:${first.recurrenceGroupId}`,
    payload: {
      notifications: [{
        recipientType: 'member',
        recipientId: memberAccountId,
        type: 'reservation_series_confirmed',
        title: 'Rezervasyon Serisi Onayı',
        body: `Haftalık rezervasyonlarınız ${first.date} ${first.time} tarihinden itibaren her hafta için onaylandı (${reservations.length} ders).`,
        payload: {
          recurrenceGroupId: first.recurrenceGroupId,
          firstDate: first.date,
          time: first.time,
          recurrenceType: 'weekly',
          count: reservations.length,
        },
      }],
    },
  });
}

// Cancellation: notify affected members + instructor(s). One summary per recipient
// for a series. Cancels pending reminders for the deleted bookings. Urgent
// (bypasses quiet hours). Captures recipients BEFORE hard deletion.
async function notifyReservationCancelled(reservations, { studioId, timeZone }) {
  if (!reservations || reservations.length === 0) return;
  const isSeries = reservations.length > 1;
  const first = reservations[0];

  // Cancel pending reminders for all deleted bookings (member per-reservation +
  // instructor per-slot) so no reminder fires for a cancelled class.
  const reservationIds = reservations.map((r) => r.id);
  const memberDedupKeys = reservationIds.map((id) => `class_reminder:member:${id}`);
  // Instructor keys are per slot+instructor; match all instructors for the slot.
  const slotPrefixes = [...new Set(reservations.map((r) => `class_reminder:instructor:${r.date}:${r.time}:${r.salonId}:`))];
  await NotificationJob.update(
    { processingState: 'done', processedAt: new Date(), lastError: 'cancelled' },
    {
      where: {
        studioId,
        processingState: 'pending',
        [Op.or]: [
          { dedupKey: { [Op.in]: memberDedupKeys } },
          ...slotPrefixes.map((prefix) => ({ dedupKey: { [Op.like]: `${prefix}%` } })),
        ],
      },
    }
  );

  // Collect recipients: member account per reservation + instructor per slot.
  const memberRecipientIds = new Set();
  const instructorRecipientIds = new Set();
  for (const reservation of reservations) {
    const memberAccountId = await resolveMemberRecipient(studioId, reservation.memberId);
    if (memberAccountId) memberRecipientIds.add(memberAccountId);
    const instructorId = await resolveInstructorRecipientForMember(studioId, reservation.memberId);
    if (instructorId) instructorRecipientIds.add(instructorId);
  }

  const notifications = [];
  const groupKey = isSeries ? first.recurrenceGroupId : first.id;
  for (const accountId of memberRecipientIds) {
    notifications.push({
      recipientType: 'member',
      recipientId: accountId,
      type: 'reservation_cancelled',
      title: 'Rezervasyon İptali',
      body: isSeries
        ? `${first.date} ${first.time} tarihinden itibaren haftalık rezervasyonlarınız iptal edildi (${reservations.length} ders).`
        : `${first.date} ${first.time} tarihli rezervasyonunuz iptal edildi.`,
      payload: { recurrenceGroupId: first.recurrenceGroupId || null, count: reservations.length },
    });
  }
  for (const instructorId of instructorRecipientIds) {
    notifications.push({
      recipientType: 'instructor',
      recipientId: instructorId,
      type: 'reservation_cancelled',
      title: 'Ders İptali',
      body: isSeries
        ? `${first.date} ${first.time} tarihinden itibaren haftalık dersleriniz iptal edildi (${reservations.length} ders).`
        : `${first.date} ${first.time} tarihli dersiniz iptal edildi.`,
      payload: { recurrenceGroupId: first.recurrenceGroupId || null, count: reservations.length },
    });
  }

  if (notifications.length === 0) return;
  await enqueueNotification({
    studioId,
    type: 'reservation_cancelled',
    dedupKey: `reservation_cancelled:${groupKey}`,
    urgent: true, // cancellations bypass quiet hours
    payload: { notifications },
  });
}

module.exports = {
  MEMBER_REMINDER_LEAD_MS,
  INSTRUCTOR_REMINDER_LEAD_MS,
  slotDateTimeUtc,
  getStudioTimezoneById,
  scheduleRemindersForReservation,
  notifySingleReservationCreated,
  notifySeriesReservationCreated,
  notifyReservationCancelled,
};
