const { sequelize } = require('./models');

async function ensureNotificationPushDeliveriesTable() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS NotificationPushDeliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notificationId INTEGER NOT NULL REFERENCES Notifications(id) ON DELETE NO ACTION ON UPDATE CASCADE,
      deviceTokenId INTEGER NOT NULL REFERENCES DeviceTokens(id) ON DELETE NO ACTION ON UPDATE CASCADE,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      maxAttempts INTEGER NOT NULL DEFAULT 5,
      nextAttemptAt DATETIME NULL,
      lastError TEXT NULL,
      sentAt DATETIME NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS push_deliveries_notification_device_unique
    ON NotificationPushDeliveries(notificationId, deviceTokenId);
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS push_deliveries_due_idx
    ON NotificationPushDeliveries(status, nextAttemptAt);
  `);
}

module.exports = ensureNotificationPushDeliveriesTable;
