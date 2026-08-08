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

async function assertNoPurchaseTokenConflicts() {
  const [rows] = await sequelize.query(`
    SELECT environment, purchaseToken, COUNT(*) AS count
    FROM google_play_subscription_transactions
    GROUP BY environment, purchaseToken
    HAVING COUNT(*) > 1
    LIMIT 1;
  `);

  if (Array.isArray(rows) && rows.length > 0) {
    throw new Error('google_play_subscription_transactions has duplicate environment + purchaseToken rows');
  }
}

async function ensureGooglePlaySubscriptionTransactionsTable() {
  const hasTable = await tableExists('google_play_subscription_transactions');
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE google_play_subscription_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        studioId INTEGER NOT NULL REFERENCES Studios(id),
        environment VARCHAR(32) NOT NULL,
        packageName VARCHAR(255) NOT NULL,
        productId VARCHAR(255) NOT NULL,
        basePlanId VARCHAR(255) NULL,
        offerId VARCHAR(255) NULL,
        purchaseToken VARCHAR(1024) NOT NULL,
        linkedPurchaseToken VARCHAR(1024) NULL,
        latestSuccessfulOrderId VARCHAR(255) NULL,
        subscriptionState VARCHAR(128) NULL,
        acknowledgementState VARCHAR(128) NULL,
        autoRenewEnabled BOOLEAN NULL,
        startTime DATETIME NULL,
        expiryTime DATETIME NULL,
        cancelSurveyResultJson TEXT NULL,
        cancellationContextJson TEXT NULL,
        testPurchaseFlag BOOLEAN NULL,
        externalAccountIdentifier VARCHAR(255) NULL,
        rawApiResponseJson TEXT NOT NULL,
        providerEventTime DATETIME NULL,
        ingestedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB MIGRATION] Created google_play_subscription_transactions table');
  }

  const columns = await getTableColumns('google_play_subscription_transactions');
  const columnDefinitions = [
    ['basePlanId', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN basePlanId VARCHAR(255) NULL;'],
    ['offerId', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN offerId VARCHAR(255) NULL;'],
    ['linkedPurchaseToken', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN linkedPurchaseToken VARCHAR(1024) NULL;'],
    ['latestSuccessfulOrderId', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN latestSuccessfulOrderId VARCHAR(255) NULL;'],
    ['subscriptionState', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN subscriptionState VARCHAR(128) NULL;'],
    ['acknowledgementState', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN acknowledgementState VARCHAR(128) NULL;'],
    ['autoRenewEnabled', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN autoRenewEnabled BOOLEAN NULL;'],
    ['startTime', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN startTime DATETIME NULL;'],
    ['expiryTime', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN expiryTime DATETIME NULL;'],
    ['cancelSurveyResultJson', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN cancelSurveyResultJson TEXT NULL;'],
    ['cancellationContextJson', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN cancellationContextJson TEXT NULL;'],
    ['testPurchaseFlag', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN testPurchaseFlag BOOLEAN NULL;'],
    ['externalAccountIdentifier', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN externalAccountIdentifier VARCHAR(255) NULL;'],
    ['providerEventTime', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN providerEventTime DATETIME NULL;'],
    ['ingestedAt', 'ALTER TABLE google_play_subscription_transactions ADD COLUMN ingestedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;'],
  ];

  for (const [columnName, sql] of columnDefinitions) {
    if (!columns.includes(columnName)) {
      await sequelize.query(sql);
      console.log(`[DB MIGRATION] Added ${columnName} column to google_play_subscription_transactions`);
    }
  }

  if (!(await indexExists('google_play_subscription_transactions_environment_purchase_token_unique'))) {
    await assertNoPurchaseTokenConflicts();
    await sequelize.query(
      'CREATE UNIQUE INDEX google_play_subscription_transactions_environment_purchase_token_unique ON google_play_subscription_transactions(environment, purchaseToken);'
    );
  }

  await ensureIndex(
    'google_play_subscription_transactions_studio_id_idx',
    'CREATE INDEX google_play_subscription_transactions_studio_id_idx ON google_play_subscription_transactions(studioId);'
  );
  await ensureIndex(
    'google_play_subscription_transactions_environment_linked_purchase_token_idx',
    'CREATE INDEX google_play_subscription_transactions_environment_linked_purchase_token_idx ON google_play_subscription_transactions(environment, linkedPurchaseToken);'
  );
  await ensureIndex(
    'google_play_subscription_transactions_package_product_idx',
    'CREATE INDEX google_play_subscription_transactions_package_product_idx ON google_play_subscription_transactions(packageName, productId);'
  );
  await ensureIndex(
    'google_play_subscription_transactions_expiry_time_idx',
    'CREATE INDEX google_play_subscription_transactions_expiry_time_idx ON google_play_subscription_transactions(expiryTime);'
  );
  await ensureIndex(
    'google_play_subscription_transactions_ingested_at_idx',
    'CREATE INDEX google_play_subscription_transactions_ingested_at_idx ON google_play_subscription_transactions(ingestedAt);'
  );
  await ensureIndex(
    'google_play_subscription_transactions_provider_event_time_idx',
    'CREATE INDEX google_play_subscription_transactions_provider_event_time_idx ON google_play_subscription_transactions(providerEventTime);'
  );
  await ensureIndex(
    'google_play_subscription_transactions_latest_successful_order_id_idx',
    'CREATE INDEX google_play_subscription_transactions_latest_successful_order_id_idx ON google_play_subscription_transactions(latestSuccessfulOrderId) WHERE latestSuccessfulOrderId IS NOT NULL;'
  );
}

module.exports = ensureGooglePlaySubscriptionTransactionsTable;
