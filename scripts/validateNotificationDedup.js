// Disposable validator (not part of product code): regression coverage for
// content-level notification dedup — a deferred quiet-hours job plus a
// re-enqueued retry of the SAME content must not create duplicate inbox rows,
// while genuinely different notifications (different class/date/type) are
// unaffected — against an isolated temp SQLite DB. Does not touch the real
// database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-dedup-'));
const dbPath = path.join(tmpRoot, 'validation.sqlite');
process.env.DB_PATH = dbPath;

const {
  sequelize,
  Studio,
  User,
  Notification,
  NotificationJob,
} = require('../models');
const ensureNotificationTables = require('../ensureNotificationTables');
const notificationService = require('../services/notificationService');
const notificationWorker = require('../services/notificationWorker');

async function run() {
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS NotificationJobs');
  await sequelize.query('DROP TABLE IF EXISTS Notifications');
  await sequelize.query('DROP TABLE IF EXISTS StudioNotificationSettings');
  await ensureNotificationTables();

  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });

  async function inboxCount(type) {
    return Notification.count({ where: { studioId: studioA.id, type } });
  }

  // --- D1: deferred quiet-hours job + re-enqueued retry -> ONE inbox row ---
  {
    // 23:00 Istanbul = 20:00 UTC -> inside quiet hours (21:00-09:00) -> deferred to 09:00.
    const nightUtc = new Date('2026-11-10T20:00:00Z');
    const payload = {
      notifications: [{
        recipientType: 'admin', recipientId: adminA.id, type: 'payment_overdue',
        title: 'Ödeme Hatırlatması', body: 'Ödemeniz bekliyor.',
      }],
    };
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'payment_overdue', dedupKey: 'pay:cycle:1:day3',
      scheduledAt: nightUtc, urgent: false, payload,
    });
    const job1 = await NotificationJob.findOne({ where: { dedupKey: 'pay:cycle:1:day3' } });
    // Deferred to 09:00 local (06:00 UTC).
    assert.ok(job1.scheduledAt > nightUtc, 'deferred to quiet-hours end');

    // Re-enqueue the SAME content under a DIFFERENT dedup key (retry/re-trigger).
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'payment_overdue', dedupKey: 'pay:cycle:1:day3:retry',
      scheduledAt: new Date(job1.scheduledAt.getTime() + 1000), urgent: true, payload,
    });

    // Process both at 09:00.
    await notificationWorker.processDueJobs({ now: new Date(job1.scheduledAt.getTime() + 2000) });
    assert.strictEqual(await inboxCount('payment_overdue'), 1, 'ONE inbox row for duplicate content');
    console.log('D1 OK: deferred + retry -> single inbox row (09:00 duplicate fixed)');
  }

  // --- D2: same job retried after crash -> still ONE row (existing behavior preserved) ---
  {
    const payload = {
      notifications: [{
        recipientType: 'admin', recipientId: adminA.id, type: 'package_expiring',
        title: 'Paket Sona Eriyor', body: 'Paket 7 gün içinde bitiyor.',
      }],
    };
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'package_expiring', dedupKey: 'pkg:exp:1', urgent: true, payload,
    });
    // Crash after insert, then retry.
    let crashed = false;
    const crashHandler = async (job) => {
      if (!crashed) {
        await notificationWorker.defaultJobHandler(job);
        crashed = true;
        throw new Error('simulated crash');
      }
      return notificationWorker.defaultJobHandler(job);
    };
    const now = new Date(Date.now() + 60000);
    await notificationWorker.processDueJobs({ handler: crashHandler, now });
    const job = await NotificationJob.findOne({ where: { dedupKey: 'pkg:exp:1' } });
    await job.update({ nextAttemptAt: new Date(Date.now() - 1000) });
    await notificationWorker.processDueJobs({ handler: crashHandler, now: new Date() });
    assert.strictEqual(await inboxCount('package_expiring'), 1, 'crash/retry still deduped');
    console.log('D2 OK: crash/retry idempotency preserved');
  }

  // --- D3: genuinely different notifications -> separate rows ---
  {
    // Same type+recipient, different body (different class date).
    const mk = (date) => ({
      notifications: [{
        recipientType: 'admin', recipientId: adminA.id, type: 'class_reminder',
        title: 'Ders Hatırlatması', body: `Dersiniz ${date} 10:00 tarihinde.`,
      }],
    });
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'class_reminder', dedupKey: 'rem:a', urgent: true, payload: mk('2026-11-15'),
    });
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'class_reminder', dedupKey: 'rem:b', urgent: true, payload: mk('2026-11-16'),
    });
    await notificationWorker.processDueJobs({ now: new Date(Date.now() + 60000) });
    assert.strictEqual(await inboxCount('class_reminder'), 2, 'different class dates -> separate rows');
    console.log('D3 OK: different content -> separate rows');
  }

  // --- D4: same content to DIFFERENT recipients -> separate rows ---
  {
    const adminB = await User.create({ username: 'adminB', password: 'h', role: 'admin', studioId: studioA.id });
    const payload = {
      notifications: [
        { recipientType: 'admin', recipientId: adminA.id, type: 'member_inactive', title: 'Üye İnaktif', body: 'Üye 14 gündür gelmiyor.' },
        { recipientType: 'admin', recipientId: adminB.id, type: 'member_inactive', title: 'Üye İnaktif', body: 'Üye 14 gündür gelmiyor.' },
      ],
    };
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'member_inactive', dedupKey: 'inact:1', urgent: true, payload,
    });
    await notificationWorker.processDueJobs({ now: new Date(Date.now() + 60000) });
    assert.strictEqual(await inboxCount('member_inactive'), 2, 'same content, different recipients -> separate rows');
    console.log('D4 OK: per-recipient dedup preserved');
  }

  // --- D5: same-name members -> memberId in payloadKey separates them ---
  {
    // Two members named "Ali" with low lessons: identical body text, but
    // memberId differs -> must NOT be suppressed. (package_low_lessons has no
    // delivery-time member revalidation, so it exercises the dedup directly.)
    for (const memberId of [5, 6]) {
      await notificationService.enqueueNotification({
        studioId: studioA.id, type: 'package_low_lessons', dedupKey: `low:${memberId}:2:cycle:1`, urgent: true,
        payload: { notifications: [{ recipientType: 'admin', recipientId: adminA.id, type: 'package_low_lessons', title: 'Ders Paketi Azalıyor', body: 'Ali adlı üyenin ders paketinde 2 ders kaldı.', payload: { memberId, remainingLessons: 2, cycle: 1 } }] },
      });
    }
    await notificationWorker.processDueJobs({ now: new Date(Date.now() + 60000) });
    assert.strictEqual(await inboxCount('package_low_lessons'), 2, 'same-name members both notified (memberId separates)');
    console.log('D5 OK: same-name members not suppressed (memberId in key)');
  }

  // --- D6: same-text reservation cancellations on different reservations -> separate ---
  {
    for (const id of [301, 302]) {
      await notificationService.enqueueNotification({
        studioId: studioA.id, type: 'reservation_cancelled', dedupKey: `cancel:${id}`, urgent: true,
        payload: { notifications: [{ recipientType: 'admin', recipientId: adminA.id, type: 'reservation_cancelled', title: 'Rezervasyon İptali', body: 'Ali üyenin 2026-11-10 10:00 tarihli rezervasyonu iptal edildi.', payload: { reservationIds: [id], memberId: 5, date: '2026-11-10', time: '10:00' } }] },
      });
    }
    await notificationWorker.processDueJobs({ now: new Date(Date.now() + 60000) });
    assert.strictEqual(await inboxCount('reservation_cancelled'), 2, 'same-text cancellations on different reservations both delivered');
    console.log('D6 OK: same-text reservation cancellations not suppressed (reservationIds in key)');
  }

  console.log('All notification-dedup cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
