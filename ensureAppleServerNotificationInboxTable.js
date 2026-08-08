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

async function assertNoNotificationUuidConflicts() {
  const [rows] = await sequelize.query(`
    SELECT environment, notificationUUID, COUNT(*) AS count
    FROM apple_server_notification_inbox
    GROUP BY environment, notificationUUID
    HAVING COUNT(*) > 1
    LIMIT 1;
  `);

  if (Array.isArray(rows) && rows.length > 0) {
    throw new Error('apple_server_notification_inbox has duplicate environment + notificationUUID rows');
  }
}

async function ensureAppleServerNotificationInboxTable() {
  const hasTable = await tableExists('apple_server_notification_inbox');
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE apple_server_notification_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        environment VARCHAR(32) NOT NULL,
        notificationUUID VARCHAR(255) NOT NULL,
        notificationType VARCHAR(255) NOT NULL,
        notificationSubtype VARCHAR(255) NULL,
        signedPayload TEXT NOT NULL,
        originalTransactionId VARCHAR(255) NULL,
        transactionId VARCHAR(255) NULL,
        eventTime DATETIME NULL,
        processingState VARCHAR(64) NOT NULL DEFAULT 'pending',
        processedAt DATETIME NULL,
        lastError TEXT NULL,
        attemptCount INTEGER NOT NULL DEFAULT 0,
        nextAttemptAt DATETIME NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB MIGRATION] Created apple_server_notification_inbox table');
  }

  const columns = await getTableColumns('apple_server_notification_inbox');
  const columnDefinitions = [
    ['notificationSubtype', 'ALTER TABLE apple_server_notification_inbox ADD COLUMN notificationSubtype VARCHAR(255) NULL;'],
    ['originalTransactionId', 'ALTER TABLE apple_server_notification_inbox ADD COLUMN originalTransactionId VARCHAR(255) NULL;'],
    ['transactionId', 'ALTER TABLE apple_server_notification_inbox ADD COLUMN transactionId VARCHAR(255) NULL;'],
    ['eventTime', 'ALTER TABLE apple_server_notification_inbox ADD COLUMN eventTime DATETIME NULL;'],
    ['processingState', "ALTER TABLE apple_server_notification_inbox ADD COLUMN processingState VARCHAR(64) NOT NULL DEFAULT 'pending';"],
    ['processedAt', 'ALTER TABLE apple_server_notification_inbox ADD COLUMN processedAt DATETIME NULL;'],
    ['lastError', 'ALTER TABLE apple_server_notification_inbox ADD COLUMN lastError TEXT NULL;'],
    ['attemptCount', 'ALTER TABLE apple_server_notification_inbox ADD COLUMN attemptCount INTEGER NOT NULL DEFAULT 0;'],
    ['nextAttemptAt', 'ALTER TABLE apple_server_notification_inbox ADD COLUMN nextAttemptAt DATETIME NULL;'],
  ];

  for (const [columnName, sql] of columnDefinitions) {
    if (!columns.includes(columnName)) {
      await sequelize.query(sql);
      console.log(`[DB MIGRATION] Added ${columnName} column to apple_server_notification_inbox`);
    }
  }

  if (!(await indexExists('apple_server_notification_inbox_environment_notification_uuid_unique'))) {
    await assertNoNotificationUuidConflicts();
    await sequelize.query(
      'CREATE UNIQUE INDEX apple_server_notification_inbox_environment_notification_uuid_unique ON apple_server_notification_inbox(environment, notificationUUID);'
    );
  }

  await ensureIndex(
    'apple_server_notification_inbox_processing_state_idx',
    'CREATE INDEX apple_server_notification_inbox_processing_state_idx ON apple_server_notification_inbox(processingState);'
  );
  await ensureIndex(
    'apple_server_notification_inbox_next_attempt_at_idx',
    'CREATE INDEX apple_server_notification_inbox_next_attempt_at_idx ON apple_server_notification_inbox(nextAttemptAt);'
  );
  await ensureIndex(
    'apple_server_notification_inbox_environment_original_transaction_id_idx',
    'CREATE INDEX apple_server_notification_inbox_environment_original_transaction_id_idx ON apple_server_notification_inbox(environment, originalTransactionId);'
  );
  await ensureIndex(
    'apple_server_notification_inbox_environment_transaction_id_idx',
    'CREATE INDEX apple_server_notification_inbox_environment_transaction_id_idx ON apple_server_notification_inbox(environment, transactionId);'
  );
  await ensureIndex(
    'apple_server_notification_inbox_event_time_idx',
    'CREATE INDEX apple_server_notification_inbox_event_time_idx ON apple_server_notification_inbox(eventTime);'
  );
  await ensureIndex(
    'apple_server_notification_inbox_created_at_idx',
    'CREATE INDEX apple_server_notification_inbox_created_at_idx ON apple_server_notification_inbox(createdAt);'
  );
}

module.exports = ensureAppleServerNotificationInboxTable;