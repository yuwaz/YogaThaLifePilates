const {
  AppleNotificationError,
  ingestAppleNotification,
  toPublicErrorResponse,
} = require('../services/appleNotificationService');

async function handleAppleServerNotification(req, res) {
  try {
    await ingestAppleNotification({
      req,
      now: new Date(),
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error instanceof AppleNotificationError) {
      const response = toPublicErrorResponse(error);
      return res.status(response.status).json(response.body);
    }

    return res.status(500).json({
      error: 'APPLE_NOTIFICATION_PROCESSING_FAILED',
    });
  }
}

module.exports = {
  handleAppleServerNotification,
};
