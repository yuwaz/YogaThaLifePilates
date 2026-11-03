const { Op } = require('sequelize');
const {
  Reservation,
  Member,
  Salon,
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

// Reads a field from a Sequelize instance or a plain object. `date`/`time` are
// internal getters on Sequelize Model instances, so direct property access on
// instances returns undefined — always go through get() when available.
function fieldOf(row, field) {
  if (row && typeof row.get === 'function') return row.get(field);
  return row ? row[field] : undefined;
}

// Chronological ordering: DATEONLY ('YYYY-MM-DD') + TIME ('HH:MM[:SS]') strings
// sort lexicographically; id breaks ties. Callers pass rows from unordered
// findAll queries, so "first" must be derived here, never from array position.
function sortChronologically(reservations) {
  return [...reservations].sort((a, b) => {
    const keyA = `${fieldOf(a, 'date')} ${fieldOf(a, 'time')}`;
    const keyB = `${fieldOf(b, 'date')} ${fieldOf(b, 'time')}`;
    if (keyA !== keyB) return keyA < keyB ? -1 : 1;
    return Number(fieldOf(a, 'id')) - Number(fieldOf(b, 'id'));
  });
}

// Loads member/salon display names for notification content. Name lookup only:
// no isActive/deletedAt filters, so cancellations of deactivated members still
// identify the affected member.
async function loadMemberSalonMaps(studioId, reservations) {
  const memberIds = [...new Set(reservations.map((r) => Number(fieldOf(r, 'memberId'))))];
  const salonIds = [...new Set(reservations.map((r) => Number(fieldOf(r, 'salonId'))))];
  const members = await Member.findAll({
    where: { id: { [Op.in]: memberIds }, studioId },
    attributes: ['id', 'name'],
  });
  const salons = await Salon.findAll({
    where: { id: { [Op.in]: salonIds }, studioId },
    attributes: ['id', 'name'],
  });
  return {
    memberNameById: new Map(members.map((m) => [Number(m.id), m.name])),
    salonNameById: new Map(salons.map((s) => [Number(s.id), s.name])),
  };
}

// Schedules member (2h) and instructor (1h) reminders for one reservation.
// Member reminder: per reservation. Instructor reminder: one per instructor per
// class slot (studio+salon+date+time+instructorId), using Member.assignedInstructorId
// as the source of truth. The instructor is re-resolved at delivery time.
async function scheduleRemindersForReservation(reservation, { studioId, timeZone }) {
  const reservationId = fieldOf(reservation, 'id');
  const memberId = fieldOf(reservation, 'memberId');
  const salonId = fieldOf(reservation, 'salonId');
  const date = fieldOf(reservation, 'date');
  const time = fieldOf(reservation, 'time');
  const slotUtc = slotDateTimeUtc(date, time, timeZone);
  if (!slotUtc) return;
  const now = new Date();
  if (slotUtc <= now) return; // never remind for past classes

  // Configurable lead times (defaults: member 120 min, instructor 60 min).
  const settings = await getStudioNotificationSettings(studioId);
  if (settings.classReminderEnabled === false) return;
  const memberLeadMs = Number(settings.memberReminderMinutes) * 60 * 1000;
  const instructorLeadMs = Number(settings.instructorReminderMinutes) * 60 * 1000;

  // Member reminder (memberReminderMinutes before).
  const memberAccountId = await resolveMemberRecipient(studioId, memberId);
  if (memberAccountId) {
    const memberAt = new Date(slotUtc.getTime() - memberLeadMs);
    if (memberAt > now) {
      await enqueueNotification({
        studioId,
        type: 'class_reminder',
        dedupKey: `class_reminder:member:${reservationId}`,
        scheduledAt: memberAt,
        payload: {
          kind: 'member',
          reservationId,
          notifications: [{
            recipientType: 'member',
            recipientId: memberAccountId,
            type: 'class_reminder',
            title: 'Ders Hatırlatması',
            body: `Dersiniz ${date} ${time} tarihinde.`,
            payload: { reservationId, date, time },
          }],
        },
      });
    }
  }

  // Instructor reminder (1h before), one per instructor per class slot.
  // Resolve the member's assigned instructor now for the dedup key; the actual
  // recipient is re-resolved at delivery from current slot attendees.
  const instructorId = await resolveInstructorRecipientForMember(studioId, memberId);
  if (instructorId) {
    const instructorAt = new Date(slotUtc.getTime() - instructorLeadMs);
    if (instructorAt > now) {
      await enqueueNotification({
        studioId,
        type: 'class_reminder',
        dedupKey: `class_reminder:instructor:${date}:${time}:${salonId}:${instructorId}`,
        scheduledAt: instructorAt,
        payload: {
          kind: 'instructor',
          slotDate: date,
          slotTime: time,
          salonId,
          instructorId,
          notifications: [],
        },
      });
    }
  }
}

// Reservation lifecycle notifications (confirmed/updated/cancelled) honor the
// studio's reservationAlertsEnabled toggle at the source, matching how the
// other categories gate inbox delivery.
async function reservationAlertsEnabled(studioId) {
  const settings = await getStudioNotificationSettings(studioId);
  return settings.reservationAlertsEnabled !== false;
}

// Single reservation confirmation to the member + the member's assigned
// instructor. Instructor copy identifies the affected member and slot.
async function notifySingleReservationCreated(reservation, { studioId }) {
  if (!(await reservationAlertsEnabled(studioId))) return;
  const reservationId = fieldOf(reservation, 'id');
  const memberId = fieldOf(reservation, 'memberId');
  const salonId = fieldOf(reservation, 'salonId');
  const date = fieldOf(reservation, 'date');
  const time = fieldOf(reservation, 'time');
  const { memberNameById, salonNameById } = await loadMemberSalonMaps(studioId, [reservation]);
  const memberName = memberNameById.get(Number(memberId)) || 'Üye';
  const salonName = salonNameById.get(Number(salonId)) || null;
  const salonText = salonName ? ` (${salonName})` : '';

  const notifications = [];
  const memberAccountId = await resolveMemberRecipient(studioId, memberId);
  if (memberAccountId) {
    notifications.push({
      recipientType: 'member',
      recipientId: memberAccountId,
      type: 'reservation_confirmed',
      title: 'Rezervasyon Onayı',
      body: `Rezervasyonunuz ${date} ${time} için onaylandı.`,
      payload: { reservationId, date, time },
    });
  }
  const instructorId = await resolveInstructorRecipientForMember(studioId, memberId);
  if (instructorId) {
    notifications.push({
      recipientType: 'instructor',
      recipientId: instructorId,
      type: 'reservation_confirmed',
      title: 'Yeni Rezervasyon',
      body: `${memberName} için ${date} ${time} tarihinde rezervasyon oluşturuldu${salonText}.`,
      payload: {
        reservationId,
        memberId: Number(memberId),
        memberName,
        salonId: Number(salonId),
        salonName,
        date,
        time,
      },
    });
  }
  if (notifications.length === 0) return;
  await enqueueNotification({
    studioId,
    type: 'reservation_confirmed',
    dedupKey: `reservation_confirmed:${reservationId}`,
    payload: { notifications },
  });
}

// ONE summary confirmation for an entire weekly recurring series, to the member
// + the member's assigned instructor.
async function notifySeriesReservationCreated(reservations, { studioId }) {
  if (!reservations || reservations.length === 0) return;
  if (!(await reservationAlertsEnabled(studioId))) return;
  const sorted = sortChronologically(reservations);
  const first = sorted[0];
  const { memberNameById, salonNameById } = await loadMemberSalonMaps(studioId, [first]);
  const memberName = memberNameById.get(Number(first.memberId)) || 'Üye';
  const salonName = salonNameById.get(Number(first.salonId)) || null;
  const salonText = salonName ? ` (${salonName})` : '';

  const firstMemberId = fieldOf(first, 'memberId');
  const firstSalonId = fieldOf(first, 'salonId');
  const firstDate = fieldOf(first, 'date');
  const firstTime = fieldOf(first, 'time');
  const firstGroupId = fieldOf(first, 'recurrenceGroupId');

  const notifications = [];
  const memberAccountId = await resolveMemberRecipient(studioId, firstMemberId);
  if (memberAccountId) {
    notifications.push({
      recipientType: 'member',
      recipientId: memberAccountId,
      type: 'reservation_series_confirmed',
      title: 'Rezervasyon Serisi Onayı',
      body: `Haftalık rezervasyonlarınız ${firstDate} ${firstTime} tarihinden itibaren her hafta için onaylandı (${sorted.length} ders).`,
      payload: {
        recurrenceGroupId: firstGroupId,
        firstDate,
        time: firstTime,
        recurrenceType: 'weekly',
        count: sorted.length,
      },
    });
  }
  const instructorId = await resolveInstructorRecipientForMember(studioId, firstMemberId);
  if (instructorId) {
    notifications.push({
      recipientType: 'instructor',
      recipientId: instructorId,
      type: 'reservation_series_confirmed',
      title: 'Yeni Rezervasyon Serisi',
      body: `${memberName} için ${firstDate} ${firstTime} tarihinden itibaren her hafta rezervasyon serisi oluşturuldu${salonText} (${sorted.length} ders).`,
      payload: {
        recurrenceGroupId: firstGroupId,
        memberId: Number(firstMemberId),
        memberName,
        salonId: Number(firstSalonId),
        salonName,
        firstDate,
        time: firstTime,
        recurrenceType: 'weekly',
        count: sorted.length,
      },
    });
  }
  if (notifications.length === 0) return;
  await enqueueNotification({
    studioId,
    type: 'reservation_series_confirmed',
    dedupKey: `reservation_series_confirmed:${firstGroupId}`,
    payload: { notifications },
  });
}

// Cancels pending member reminders for the given reservations and pending
// instructor slot reminders ONLY for slots with no remaining attendees.
// `excludeReservationIds` are reservations being deleted/moved (not yet
// persisted as such), so they never count as remaining attendees. Instructor
// reminders for slots that still have other attendees — including other
// instructors sharing the slot — are preserved.
async function cancelObsoleteReminders(studioId, reservations, { excludeReservationIds = [] } = {}) {
  if (!reservations || reservations.length === 0) return;
  const excluded = new Set(excludeReservationIds.map((id) => Number(id)));
  const memberDedupKeys = reservations.map((r) => `class_reminder:member:${fieldOf(r, 'id')}`);
  const or = [{ dedupKey: { [Op.in]: memberDedupKeys } }];

  const slotKeys = new Map();
  for (const r of reservations) {
    const date = fieldOf(r, 'date');
    const time = fieldOf(r, 'time');
    const salonId = fieldOf(r, 'salonId');
    slotKeys.set(`${date}|${time}|${salonId}`, { date, time, salonId });
  }
  for (const slot of slotKeys.values()) {
    const remaining = await Reservation.count({
      where: {
        studioId,
        date: slot.date,
        time: slot.time,
        salonId: slot.salonId,
        ...(excluded.size > 0 ? { id: { [Op.notIn]: [...excluded] } } : {}),
      },
    });
    if (remaining === 0) {
      or.push({ dedupKey: { [Op.like]: `class_reminder:instructor:${slot.date}:${slot.time}:${slot.salonId}:%` } });
    }
  }

  await NotificationJob.update(
    { processingState: 'done', processedAt: new Date(), lastError: 'cancelled' },
    { where: { studioId, processingState: 'pending', [Op.or]: or } }
  );
}

// Date/time change: notify the affected member + their assigned instructor with
// old and new values, cancel obsolete pending reminders, and schedule new ones.
// `changes` entries: { reservationId, memberId, salonId, oldDate, oldTime,
// newDate, newTime, updateId? }. Urgent (bypasses quiet hours).
//
// Dedup: one job per DISTINCT update event. The key embeds a per-event
// `updateId` (generated per call when not supplied), so repeated moves such as
// A->B->A->B never collide with an earlier delivered job. Retry idempotency
// does NOT rely on this key: the worker's per-recipient deliveryKey
// (`job:{id}:...`) already makes notification inserts crash/retry-safe, and
// reminder scheduling dedups on its own slot-based keys. Callers that may
// re-enqueue the SAME logical update should pass a stable `updateId`.
async function notifyReservationUpdated(changes, { studioId, timeZone }) {
  if (!changes || changes.length === 0) return;
  if (!(await reservationAlertsEnabled(studioId))) return;
  const { memberNameById, salonNameById } = await loadMemberSalonMaps(studioId, changes);
  // One update event per call: shared across all changes in this call so a
  // future-scope series update enqueues one job per reservation of the SAME
  // event, never colliding with a previous event for the same reservation.
  const eventId = `upd_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;

  for (const change of changes) {
    const memberName = memberNameById.get(Number(change.memberId)) || 'Üye';
    const salonName = salonNameById.get(Number(change.salonId)) || null;
    const salonText = salonName ? ` (${salonName})` : '';
    const detailsPayload = {
      reservationId: change.reservationId,
      memberId: Number(change.memberId),
      memberName,
      salonId: Number(change.salonId),
      salonName,
      oldDate: change.oldDate,
      oldTime: change.oldTime,
      newDate: change.newDate,
      newTime: change.newTime,
    };

    const notifications = [];
    const memberAccountId = await resolveMemberRecipient(studioId, change.memberId);
    if (memberAccountId) {
      notifications.push({
        recipientType: 'member',
        recipientId: memberAccountId,
        type: 'reservation_updated',
        title: 'Rezervasyon Güncellendi',
        body: `Rezervasyonunuz ${change.oldDate} ${change.oldTime} tarihinden ${change.newDate} ${change.newTime} tarihine güncellendi.`,
        payload: detailsPayload,
      });
    }
    const instructorId = await resolveInstructorRecipientForMember(studioId, change.memberId);
    if (instructorId) {
      notifications.push({
        recipientType: 'instructor',
        recipientId: instructorId,
        type: 'reservation_updated',
        title: 'Rezervasyon Güncellendi',
        body: `${memberName} üyenin rezervasyonu ${change.oldDate} ${change.oldTime} tarihinden ${change.newDate} ${change.newTime} tarihine güncellendi${salonText}.`,
        payload: detailsPayload,
      });
    }
    if (notifications.length === 0) continue;

    const updateId = change.updateId || eventId;
    await enqueueNotification({
      studioId,
      type: 'reservation_updated',
      dedupKey: `reservation_updated:${change.reservationId}:${updateId}`,
      urgent: true, // schedule changes bypass quiet hours
      payload: { notifications },
    });
  }

  // Reminder consistency: drop pending reminders for the old slots (instructor
  // slot reminders only when no other attendees remain), then schedule new ones.
  // enqueueNotification dedups, so no duplicate reminders are created.
  const oldSlots = changes.map((c) => ({
    id: c.reservationId,
    date: c.oldDate,
    time: c.oldTime,
    salonId: c.salonId,
  }));
  await cancelObsoleteReminders(studioId, oldSlots, { excludeReservationIds: changes.map((c) => c.reservationId) });
  for (const change of changes) {
    await scheduleRemindersForReservation(
      {
        id: change.reservationId,
        memberId: change.memberId,
        salonId: change.salonId,
        date: change.newDate,
        time: change.newTime,
      },
      { studioId, timeZone }
    );
  }
}

// Cancellation: notify affected members + their assigned instructor(s). One
// summary per recipient per affected member. Cancels pending reminders for the
// deleted bookings. Urgent (bypasses quiet hours). Captures recipients BEFORE
// hard deletion. Instructor copy says "Rezervasyon İptali" (never "class
// cancelled") and identifies the affected member — a member's reservation
// cancellation must never imply the whole group class was cancelled.
async function notifyReservationCancelled(reservations, { studioId, timeZone }) {
  if (!reservations || reservations.length === 0) return;
  if (!(await reservationAlertsEnabled(studioId))) return;
  const sorted = sortChronologically(reservations);
  const isSeries = sorted.length > 1;
  const first = sorted[0];

  // Cancel pending reminders for all deleted bookings (member per-reservation +
  // instructor per-slot) so no reminder fires for a cancelled class. Instructor
  // slot reminders survive while other attendees remain in the slot.
  await cancelObsoleteReminders(studioId, sorted, { excludeReservationIds: sorted.map((r) => fieldOf(r, 'id')) });

  const { memberNameById, salonNameById } = await loadMemberSalonMaps(studioId, sorted);

  // Group by member so every affected member (and their instructor) gets a
  // summary that identifies the member and the affected reservations.
  const byMember = new Map();
  for (const reservation of sorted) {
    const key = Number(fieldOf(reservation, 'memberId'));
    if (!byMember.has(key)) byMember.set(key, []);
    byMember.get(key).push(reservation);
  }

  const notifications = [];
  for (const [memberId, memberReservations] of byMember) {
    const memberFirst = memberReservations[0];
    const memberFirstSalonId = fieldOf(memberFirst, 'salonId');
    const memberFirstDate = fieldOf(memberFirst, 'date');
    const memberFirstTime = fieldOf(memberFirst, 'time');
    const memberName = memberNameById.get(memberId) || 'Üye';
    const salonName = salonNameById.get(Number(memberFirstSalonId)) || null;
    const salonText = salonName ? ` (${salonName})` : '';
    const memberIsSeries = memberReservations.length > 1;
    const detailsPayload = {
      recurrenceGroupId: fieldOf(memberFirst, 'recurrenceGroupId') || null,
      count: memberReservations.length,
      scope: memberIsSeries ? 'series' : 'single',
      reservationIds: memberReservations.map((r) => fieldOf(r, 'id')),
      memberId,
      memberName,
      salonId: Number(memberFirstSalonId),
      salonName,
      date: memberFirstDate,
      time: memberFirstTime,
    };

    const memberAccountId = await resolveMemberRecipient(studioId, memberId);
    if (memberAccountId) {
      notifications.push({
        recipientType: 'member',
        recipientId: memberAccountId,
        type: 'reservation_cancelled',
        title: 'Rezervasyon İptali',
        body: memberIsSeries
          ? `${memberFirstDate} ${memberFirstTime} tarihinden itibaren haftalık rezervasyonlarınız iptal edildi (${memberReservations.length} ders).`
          : `${memberFirstDate} ${memberFirstTime} tarihli rezervasyonunuz iptal edildi.`,
        payload: detailsPayload,
      });
    }
    const instructorId = await resolveInstructorRecipientForMember(studioId, memberId);
    if (instructorId) {
      notifications.push({
        recipientType: 'instructor',
        recipientId: instructorId,
        type: 'reservation_cancelled',
        title: 'Rezervasyon İptali',
        body: memberIsSeries
          ? `${memberName} üyenin ${memberFirstDate} ${memberFirstTime} tarihinden itibaren haftalık rezervasyonları iptal edildi${salonText} (${memberReservations.length} ders).`
          : `${memberName} üyenin ${memberFirstDate} ${memberFirstTime} tarihli rezervasyonu iptal edildi${salonText}.`,
        payload: detailsPayload,
      });
    }
  }

  if (notifications.length === 0) return;
  // Series dedup includes the first affected date: a later partial cancellation
  // of the same recurrence group (different first date) must still notify.
  const firstGroupId = fieldOf(first, 'recurrenceGroupId');
  const groupKey = isSeries && firstGroupId
    ? `${firstGroupId}:${fieldOf(first, 'date')}`
    : fieldOf(first, 'id');
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
  notifyReservationUpdated,
  notifyReservationCancelled,
};
