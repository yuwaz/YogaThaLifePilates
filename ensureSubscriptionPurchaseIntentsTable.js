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

async function assertNoConflictingReusableProviderRows() {
  const [rows] = await sequelize.query(`
    SELECT studioId, provider, COUNT(*) AS count
      FROM SubscriptionPurchaseIntents
     WHERE status IN ('created', 'started')
  GROUP BY studioId, provider
    HAVING COUNT(*) > 1
     LIMIT 1;
  `);

  if (Array.isArray(rows) && rows.length > 0) {
    throw new Error('SubscriptionPurchaseIntents has conflicting reusable rows for studio and provider');
  }
}

async function ensureSubscriptionPurchaseIntentsTable() {
  const hasTable = await tableExists('SubscriptionPurchaseIntents');
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE SubscriptionPurchaseIntents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        studioId INTEGER NOT NULL REFERENCES Studios(id),
        provider VARCHAR(255) NOT NULL,
        targetPlan VARCHAR(255) NOT NULL,
        appAccountToken VARCHAR(255) NULL,
        googleObfuscatedAccountId VARCHAR(255) NULL,
        googleObfuscatedProfileId VARCHAR(255) NULL,
        status VARCHAR(255) NOT NULL DEFAULT 'created',
        expiresAt DATETIME NOT NULL,
        consumedAt DATETIME NULL,
        createdByUserId INTEGER NULL,
        metadataJson TEXT NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB MIGRATION] Created SubscriptionPurchaseIntents table');
  }

  const columns = await getTableColumns('SubscriptionPurchaseIntents');
  const columnDefinitions = [
    ['googleObfuscatedProfileId', 'ALTER TABLE SubscriptionPurchaseIntents ADD COLUMN googleObfuscatedProfileId VARCHAR(255) NULL;'],
    ['createdByUserId', 'ALTER TABLE SubscriptionPurchaseIntents ADD COLUMN createdByUserId INTEGER NULL;'],
    ['metadataJson', 'ALTER TABLE SubscriptionPurchaseIntents ADD COLUMN metadataJson TEXT NULL;'],
  ];

  for (const [columnName, sql] of columnDefinitions) {
    if (!columns.includes(columnName)) {
      await sequelize.query(sql);
      console.log(`[DB MIGRATION] Added ${columnName} column to SubscriptionPurchaseIntents`);
    }
  }

  await ensureIndex(
    'subscription_purchase_intents_studio_id_idx',
    'CREATE INDEX subscription_purchase_intents_studio_id_idx ON SubscriptionPurchaseIntents(studioId);'
  );
  await ensureIndex(
    'subscription_purchase_intents_provider_idx',
    'CREATE INDEX subscription_purchase_intents_provider_idx ON SubscriptionPurchaseIntents(provider);'
  );
  await ensureIndex(
    'subscription_purchase_intents_status_idx',
    'CREATE INDEX subscription_purchase_intents_status_idx ON SubscriptionPurchaseIntents(status);'
  );
  await ensureIndex(
    'subscription_purchase_intents_expires_at_idx',
    'CREATE INDEX subscription_purchase_intents_expires_at_idx ON SubscriptionPurchaseIntents(expiresAt);'
  );
  await ensureIndex(
    'subscription_purchase_intents_studio_provider_status_idx',
    'CREATE INDEX subscription_purchase_intents_studio_provider_status_idx ON SubscriptionPurchaseIntents(studioId, provider, status);'
  );

  await ensureIndex(
    'subscription_purchase_intents_app_account_token_unique',
    'CREATE UNIQUE INDEX subscription_purchase_intents_app_account_token_unique ON SubscriptionPurchaseIntents(appAccountToken) WHERE appAccountToken IS NOT NULL;'
  );

  if (!(await indexExists('subscription_purchase_intents_one_reusable_per_studio_provider_unique'))) {
    await assertNoConflictingReusableProviderRows();
    await sequelize.query(
      "CREATE UNIQUE INDEX subscription_purchase_intents_one_reusable_per_studio_provider_unique ON SubscriptionPurchaseIntents(studioId, provider) WHERE status IN ('created', 'started');"
    );
  }
}

module.exports = ensureSubscriptionPurchaseIntentsTable;