const { sequelize } = require('./models');

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function tableExists(tableName) {
  const [rows] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    { replacements: [tableName] }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function getTableColumns(tableName) {
  const [rows] = await sequelize.query(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => row.name);
}

async function indexExists(indexName) {
  const [rows] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
    { replacements: [indexName] }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function ensureIndex(indexName, sql) {
  if (await indexExists(indexName)) {
    return false;
  }

  await sequelize.query(sql);
  return true;
}

async function assertNoMessageIdConflicts() {
  const [rows] = await sequelize.query(`
    SELECT environment, pubsubMessageId, COUNT(*) AS count
    FROM google_pubsub_notification_inbox
    GROUP BY environment, pubsubMessageId
    HAVING COUNT(*) > 1
    LIMIT 1;
  `);

  if (Array.isArray(rows) && rows.length > 0) {
    throw new Error('google_pubsub_notification_inbox has duplicate environment + pubsubMessageId rows');
  }
}

async function ensureGooglePubSubNotificationInboxTable() {
  const hasTable = await tableExists('google_pubsub_notification_inbox');
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE google_pubsub_notification_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        environment VARCHAR(32) NOT NULL,
        pubsubMessageId VARCHAR(255) NOT NULL,
        publishTime DATETIME NULL,
        packageName VARCHAR(255) NULL,
        purchaseToken VARCHAR(1024) NULL,
        subscriptionNotificationType VARCHAR(128) NULL,
        oneTimeProductNotificationType VARCHAR(128) NULL,
        testNotificationFlag BOOLEAN NULL,
        rawPayloadJson TEXT NOT NULL,
        processingState VARCHAR(64) NOT NULL DEFAULT 'pending',
        processedAt DATETIME NULL,
        lastError TEXT NULL,
        attemptCount INTEGER NOT NULL DEFAULT 0,
        nextAttemptAt DATETIME NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB MIGRATION] Created google_pubsub_notification_inbox table');
  }

  const columns = await getTableColumns('google_pubsub_notification_inbox');
  const columnDefinitions = [
    ['publishTime', 'ALTER TABLE google_pubsub_notification_inbox ADD COLUMN publishTime DATETIME NULL;'],
    ['packageName', 'ALTER TABLE google_pubsub_notification_inbox ADD COLUMN packageName VARCHAR(255) NULL;'],
    ['purchaseToken', 'ALTER TABLE google_pubsub_notification_inbox ADD COLUMN purchaseToken VARCHAR(1024) NULL;'],
    ['subscriptionNotificationType', 'ALTER TABLE google_pubsub_notification_inbox ADD COLUMN subscriptionNotificationType VARCHAR(128) NULL;'],
    ['oneTimeProductNotificationType', 'ALTER TABLE google_pubsub_notification_inbox ADD COLUMN oneTimeProductNotificationType VARCHAR(128) NULL;'],
    ['testNotificationFlag', 'ALTER TABLE google_pubsub_notification_inbox ADD COLUMN testNotificationFlag BOOLEAN NULL;'],
    ['processingState', "ALTER TABLE google_pubsub_notification_inbox ADD COLUMN processingState VARCHAR(64) NOT NULL DEFAULT 'pending';"],
    ['processedAt', 'ALTER TABLE google_pubsub_notification_inbox ADD COLUMN processedAt DATETIME NULL;'],
    ['lastError', 'ALTER TABLE google_pubsub_notification_inbox ADD COLUMN lastError TEXT NULL;'],
    ['attemptCount', 'ALTER TABLE google_pubsub_notification_inbox ADD COLUMN attemptCount INTEGER NOT NULL DEFAULT 0;'],
    ['nextAttemptAt', 'ALTER TABLE google_pubsub_notification_inbox ADD COLUMN nextAttemptAt DATETIME NULL;'],
  ];

  for (const [columnName, sql] of columnDefinitions) {
    if (!columns.includes(columnName)) {
      await sequelize.query(sql);
      console.log(`[DB MIGRATION] Added ${columnName} column to google_pubsub_notification_inbox`);
    }
  }

  if (!(await indexExists('google_pubsub_notification_inbox_environment_message_id_unique'))) {
    await assertNoMessageIdConflicts();
    await sequelize.query(
      'CREATE UNIQUE INDEX google_pubsub_notification_inbox_environment_message_id_unique ON google_pubsub_notification_inbox(environment, pubsubMessageId);'
    );
  }

  await ensureIndex(
    'google_pubsub_notification_inbox_processing_state_idx',
    'CREATE INDEX google_pubsub_notification_inbox_processing_state_idx ON google_pubsub_notification_inbox(processingState);'
  );
  await ensureIndex(
    'google_pubsub_notification_inbox_next_attempt_at_idx',
    'CREATE INDEX google_pubsub_notification_inbox_next_attempt_at_idx ON google_pubsub_notification_inbox(nextAttemptAt);'
  );
  await ensureIndex(
    'google_pubsub_notification_inbox_environment_purchase_token_idx',
    'CREATE INDEX google_pubsub_notification_inbox_environment_purchase_token_idx ON google_pubsub_notification_inbox(environment, purchaseToken);'
  );
  await ensureIndex(
    'google_pubsub_notification_inbox_publish_time_idx',
    'CREATE INDEX google_pubsub_notification_inbox_publish_time_idx ON google_pubsub_notification_inbox(publishTime);'
  );
  await ensureIndex(
    'google_pubsub_notification_inbox_created_at_idx',
    'CREATE INDEX google_pubsub_notification_inbox_created_at_idx ON google_pubsub_notification_inbox(createdAt);'
  );
  await ensureIndex(
    'google_pubsub_notification_inbox_package_name_idx',
    'CREATE INDEX google_pubsub_notification_inbox_package_name_idx ON google_pubsub_notification_inbox(packageName);'
  );
}

module.exports = ensureGooglePubSubNotificationInboxTable;
