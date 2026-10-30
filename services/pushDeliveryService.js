const { Op } = require('sequelize');
const { sequelize, Notification, NotificationPushDelivery, DeviceToken } = require('../models');
const { getStudioNotificationSettings } = require('./notificationService');

const BASE_BACKOFF_MS = 60 * 1000; // 1 minute
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1 hour
const STALE_PROCESSING_MS = 10 * 60 * 1000; // reclaim 'processing' after 10 min

function computeBackoffMs(attempts) {
  const backoff = BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(backoff, MAX_BACKOFF_MS);
}

// Maps a notification type to its studio settings category toggle.
function categoryEnabled(settings, notificationType) {
  if (notificationType === 'class_reminder') return settings.classReminderEnabled !== false;
  if (notificationType === 'package_assigned' || notificationType === 'package_low_lessons' || notificationType === 'package_expiring') {
    return settings.packageAlertsEnabled !== false;
  }
  if (notificationType === 'payment_overdue') return settings.paymentAlertsEnabled !== false;
  if (notificationType === 'member_inactive') return settings.inactivityAlertsEnabled !== false;
  return true; // reservation confirmations/cancellations always on
}

// Enqueues one push delivery per eligible device for a persisted inbox
// notification. Never throws: push enqueue failure must not fail inbox delivery.
// Skips invalidated devices and disabled categories. Dedup via unique
// (notificationId, deviceTokenId).
async function enqueuePushDeliveries(notification, { transaction } = {}) {
  try {
    const settings = await getStudioNotificationSettings(notification.studioId);
    if (!categoryEnabled(settings, notification.type)) {
      return { enqueued: 0, skipped: 'category-disabled' };
    }

    // Eligible devices: owned by the notification recipient, not invalidated.
    // Notification recipientType 'admin'/'instructor' -> device ownerType 'staff'
    // (studio-scoped). recipientType 'member' -> device ownerType 'member' (global).
    const isMember = notification.recipientType === 'member';
    const deviceWhere = {
      ownerType: isMember ? 'member' : 'staff',
      ownerId: notification.recipientId,
      invalidatedAt: null,
    };
    if (!isMember) {
      deviceWhere.studioId = notification.studioId;
    }
    const devices = await DeviceToken.findAll({ where: deviceWhere, attributes: ['id'], transaction });

    let enqueued = 0;
    for (const device of devices) {
      try {
        await NotificationPushDelivery.create({
          notificationId: notification.id,
          deviceTokenId: device.id,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: new Date(),
        }, { transaction });
        enqueued += 1;
      } catch (error) {
        if (error.name !== 'SequelizeUniqueConstraintError') throw error;
        // duplicate (notificationId, deviceTokenId) -> already enqueued
      }
    }
    return { enqueued };
  } catch (error) {
    // Never fail inbox delivery because push enqueueing failed.
    console.error('[PushDelivery] enqueue failed for notification', notification.id, ':', error && error.message);
    return { enqueued: 0, error: error && error.message };
  }
}

// Atomically claims one due push delivery (pending -> processing).
async function claimNextDueDelivery(now = new Date()) {
  const candidate = await NotificationPushDelivery.findOne({
    where: { status: 'pending', nextAttemptAt: { [Op.lte]: now } },
    order: [['nextAttemptAt', 'ASC'], ['id', 'ASC']],
  });
  if (!candidate) return null;

  const [updated] = await NotificationPushDelivery.update(
    { status: 'processing', attempts: candidate.attempts + 1 },
    { where: { id: candidate.id, status: 'pending' } }
  );
  if (updated !== 1) return null; // claimed by another worker
  return NotificationPushDelivery.findOne({ where: { id: candidate.id } });
}

// Recovers abandoned 'processing' claims back to 'pending' (crash recovery).
async function recoverStaleDeliveries(now = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS).toISOString().replace('T', ' ').replace('Z', '');
  const [recovered] = await NotificationPushDelivery.update(
    { status: 'pending' },
    {
      where: {
        status: 'processing',
        [Op.and]: [
          sequelize.where(sequelize.fn('REPLACE', sequelize.col('updatedAt'), 'T', ' '), { [Op.lte]: staleBefore }),
        ],
      },
    }
  );
  return recovered;
}

// Processes due push deliveries through an injectable transport.
// transport.send({ token, title, body, payload, platform }) -> resolves on success,
// throws on failure. transport.isInvalidTokenError(error) -> true to invalidate.
// No real FCM here; the transport is injected (fake in tests).
async function processDuePushDeliveries({ transport, limit = 25, now = new Date() } = {}) {
  if (typeof transport !== 'object' || typeof transport.send !== 'function') {
    throw new Error('A push transport with a send() function is required');
  }
  await recoverStaleDeliveries(now);

  let processed = 0;
  while (processed < limit) {
    const delivery = await claimNextDueDelivery(now);
    if (!delivery) break;

    try {
      // Load the notification + device; revalidate before sending.
      const notification = await Notification.findOne({ where: { id: delivery.notificationId } });
      const device = await DeviceToken.findOne({ where: { id: delivery.deviceTokenId } });

      if (!notification || !device) {
        await delivery.update({ status: 'failed', lastError: 'missing notification or device' });
        processed += 1;
        continue;
      }

      // Token ownership: the device must still belong to the notification recipient.
      // recipientType 'admin'/'instructor' -> ownerType 'staff' (studio-scoped);
      // 'member' -> ownerType 'member' (global).
      const isMember = notification.recipientType === 'member';
      const expectedOwnerType = isMember ? 'member' : 'staff';
      const ownerMatches = device.ownerType === expectedOwnerType
        && Number(device.ownerId) === Number(notification.recipientId)
        && (isMember || Number(device.studioId) === Number(notification.studioId));
      if (!ownerMatches) {
        // Device was taken over by another account -> never deliver the previous
        // account's push. Mark failed (terminal, no retry).
        await delivery.update({ status: 'failed', lastError: 'token-ownership-changed' });
        processed += 1;
        continue;
      }

      // Invalidated device -> skip.
      if (device.invalidatedAt) {
        await delivery.update({ status: 'failed', lastError: 'device-invalidated' });
        processed += 1;
        continue;
      }

      // Category eligibility revalidation.
      const settings = await getStudioNotificationSettings(notification.studioId);
      if (!categoryEnabled(settings, notification.type)) {
        await delivery.update({ status: 'failed', lastError: 'category-disabled' });
        processed += 1;
        continue;
      }

      // Send via the injected transport. Never log the token. Pass the persisted
      // notification id explicitly so the transport can reference it in data.
      await transport.send({
        token: device.token,
        notificationId: notification.id,
        title: notification.title,
        body: notification.body,
        payload: notification.payload,
        platform: device.platform,
      });

      // Mark sent ONLY after confirmed success.
      await delivery.update({ status: 'sent', sentAt: new Date(), lastError: null });
    } catch (error) {
      // Invalid token -> invalidate the device, terminal failure.
      if (typeof transport.isInvalidTokenError === 'function' && transport.isInvalidTokenError(error)) {
        const device = await DeviceToken.findOne({ where: { id: delivery.deviceTokenId } });
        if (device && !device.invalidatedAt) {
          device.invalidatedAt = new Date();
          await device.save({ fields: ['invalidatedAt'] });
        }
        await delivery.update({ status: 'failed', lastError: 'invalid-token' });
        processed += 1;
        continue;
      }
      // Transient failure -> retry with backoff, or fail after maxAttempts.
      const attempts = Number(delivery.attempts);
      const exhausted = attempts >= Number(delivery.maxAttempts);
      await delivery.update({
        status: exhausted ? 'failed' : 'pending',
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
  categoryEnabled,
  enqueuePushDeliveries,
  claimNextDueDelivery,
  recoverStaleDeliveries,
  processDuePushDeliveries,
  STALE_PROCESSING_MS,
};
