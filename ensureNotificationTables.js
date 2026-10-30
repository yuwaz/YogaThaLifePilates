const { sequelize } = require('./models');

async function ensureNotificationTables() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS Notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      studioId INTEGER NOT NULL REFERENCES Studios(id) ON DELETE NO ACTION ON UPDATE CASCADE,
      recipientType VARCHAR(16) NOT NULL,
      recipientId INTEGER NOT NULL,
      type VARCHAR(64) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT NULL,
      payload TEXT NULL,
      readAt DATETIME NULL,
      deliveryKey VARCHAR(255) NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS notifications_recipient_read_idx
    ON Notifications(studioId, recipientType, recipientId, readAt);
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_delivery_key_unique
    ON Notifications(studioId, deliveryKey);
  `);

  // Existing databases: add deliveryKey if missing (idempotent).
  const [notifCols] = await sequelize.query("PRAGMA table_info('Notifications')");
  if (Array.isArray(notifCols) && notifCols.length > 0 && !notifCols.some((c) => c.name === 'deliveryKey')) {
    await sequelize.query("ALTER TABLE Notifications ADD COLUMN deliveryKey VARCHAR(255) NULL;");
    console.log('[DB MIGRATION] Added deliveryKey column to Notifications');
  }

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS NotificationJobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      studioId INTEGER NOT NULL REFERENCES Studios(id) ON DELETE NO ACTION ON UPDATE CASCADE,
      type VARCHAR(64) NOT NULL,
      dedupKey VARCHAR(255) NOT NULL,
      payload TEXT NULL,
      scheduledAt DATETIME NOT NULL,
      processingState VARCHAR(16) NOT NULL DEFAULT 'pending',
      attemptCount INTEGER NOT NULL DEFAULT 0,
      maxAttempts INTEGER NOT NULL DEFAULT 5,
      nextAttemptAt DATETIME NULL,
      processedAt DATETIME NULL,
      notificationId INTEGER NULL,
      lastError TEXT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS notification_jobs_dedup_unique
    ON NotificationJobs(studioId, dedupKey);
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS notification_jobs_due_idx
    ON NotificationJobs(processingState, nextAttemptAt);
  `);

  // Existing databases: add notificationId if missing (idempotent).
  const [jobCols] = await sequelize.query("PRAGMA table_info('NotificationJobs')");
  if (Array.isArray(jobCols) && jobCols.length > 0 && !jobCols.some((c) => c.name === 'notificationId')) {
    await sequelize.query("ALTER TABLE NotificationJobs ADD COLUMN notificationId INTEGER NULL;");
    console.log('[DB MIGRATION] Added notificationId column to NotificationJobs');
  }

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS StudioNotificationSettings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      studioId INTEGER NOT NULL REFERENCES Studios(id) ON DELETE NO ACTION ON UPDATE CASCADE,
      quietHoursStart VARCHAR(5) NOT NULL DEFAULT '21:00',
      quietHoursEnd VARCHAR(5) NOT NULL DEFAULT '09:00',
      classReminderEnabled INTEGER NOT NULL DEFAULT 1,
      packageAlertsEnabled INTEGER NOT NULL DEFAULT 1,
      paymentAlertsEnabled INTEGER NOT NULL DEFAULT 1,
      inactivityAlertsEnabled INTEGER NOT NULL DEFAULT 1,
      paymentRemindersActivatedAt DATEONLY NULL,
      memberReminderMinutes INTEGER NOT NULL DEFAULT 120,
      instructorReminderMinutes INTEGER NOT NULL DEFAULT 60,
      lowLessonsThreshold INTEGER NOT NULL DEFAULT 2,
      packageExpiryDays INTEGER NOT NULL DEFAULT 7,
      inactivityDays INTEGER NOT NULL DEFAULT 14,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS studio_notification_settings_studio_unique
    ON StudioNotificationSettings(studioId);
  `);

  // Existing databases: add paymentRemindersActivatedAt if missing (idempotent).
  const [settingsCols] = await sequelize.query("PRAGMA table_info('StudioNotificationSettings')");
  if (Array.isArray(settingsCols) && settingsCols.length > 0) {
    const addColumn = async (name, ddl) => {
      if (!settingsCols.some((c) => c.name === name)) {
        await sequelize.query(`ALTER TABLE StudioNotificationSettings ADD COLUMN ${ddl};`);
        console.log(`[DB MIGRATION] Added ${name} column to StudioNotificationSettings`);
      }
    };
    await addColumn('paymentRemindersActivatedAt', 'paymentRemindersActivatedAt DATEONLY NULL');
    await addColumn('memberReminderMinutes', 'memberReminderMinutes INTEGER NOT NULL DEFAULT 120');
    await addColumn('instructorReminderMinutes', 'instructorReminderMinutes INTEGER NOT NULL DEFAULT 60');
    await addColumn('lowLessonsThreshold', 'lowLessonsThreshold INTEGER NOT NULL DEFAULT 2');
    await addColumn('packageExpiryDays', 'packageExpiryDays INTEGER NOT NULL DEFAULT 7');
    await addColumn('inactivityDays', 'inactivityDays INTEGER NOT NULL DEFAULT 14');
  }
}

module.exports = ensureNotificationTables;
