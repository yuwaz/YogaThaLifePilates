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

async function assertNoTransactionIdConflicts() {
  const [rows] = await sequelize.query(`
    SELECT environment, transactionId, COUNT(*) AS count
    FROM apple_subscription_transactions
    GROUP BY environment, transactionId
    HAVING COUNT(*) > 1
    LIMIT 1;
  `);

  if (Array.isArray(rows) && rows.length > 0) {
    throw new Error('apple_subscription_transactions has duplicate environment + transactionId rows');
  }
}

async function ensureAppleSubscriptionTransactionsTable() {
  const hasTable = await tableExists('apple_subscription_transactions');
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE apple_subscription_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        studioId INTEGER NOT NULL REFERENCES Studios(id),
        environment VARCHAR(32) NOT NULL,
        originalTransactionId VARCHAR(255) NOT NULL,
        transactionId VARCHAR(255) NOT NULL,
        productId VARCHAR(255) NOT NULL,
        subscriptionGroupIdentifier VARCHAR(255) NULL,
        purchaseDate DATETIME NULL,
        originalPurchaseDate DATETIME NULL,
        expiresDate DATETIME NULL,
        revocationDate DATETIME NULL,
        autoRenewStatus BOOLEAN NULL,
        signedTransactionInfo TEXT NOT NULL,
        signedRenewalInfo TEXT NULL,
        appAccountToken VARCHAR(255) NULL,
        notificationType VARCHAR(255) NULL,
        notificationSubtype VARCHAR(255) NULL,
        providerEventTime DATETIME NULL,
        ingestedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB MIGRATION] Created apple_subscription_transactions table');
  }

  const columns = await getTableColumns('apple_subscription_transactions');
  const columnDefinitions = [
    ['subscriptionGroupIdentifier', 'ALTER TABLE apple_subscription_transactions ADD COLUMN subscriptionGroupIdentifier VARCHAR(255) NULL;'],
    ['purchaseDate', 'ALTER TABLE apple_subscription_transactions ADD COLUMN purchaseDate DATETIME NULL;'],
    ['originalPurchaseDate', 'ALTER TABLE apple_subscription_transactions ADD COLUMN originalPurchaseDate DATETIME NULL;'],
    ['expiresDate', 'ALTER TABLE apple_subscription_transactions ADD COLUMN expiresDate DATETIME NULL;'],
    ['revocationDate', 'ALTER TABLE apple_subscription_transactions ADD COLUMN revocationDate DATETIME NULL;'],
    ['autoRenewStatus', 'ALTER TABLE apple_subscription_transactions ADD COLUMN autoRenewStatus BOOLEAN NULL;'],
    ['signedRenewalInfo', 'ALTER TABLE apple_subscription_transactions ADD COLUMN signedRenewalInfo TEXT NULL;'],
    ['appAccountToken', 'ALTER TABLE apple_subscription_transactions ADD COLUMN appAccountToken VARCHAR(255) NULL;'],
    ['notificationType', 'ALTER TABLE apple_subscription_transactions ADD COLUMN notificationType VARCHAR(255) NULL;'],
    ['notificationSubtype', 'ALTER TABLE apple_subscription_transactions ADD COLUMN notificationSubtype VARCHAR(255) NULL;'],
    ['providerEventTime', 'ALTER TABLE apple_subscription_transactions ADD COLUMN providerEventTime DATETIME NULL;'],
    ['ingestedAt', 'ALTER TABLE apple_subscription_transactions ADD COLUMN ingestedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;'],
  ];

  for (const [columnName, sql] of columnDefinitions) {
    if (!columns.includes(columnName)) {
      await sequelize.query(sql);
      console.log(`[DB MIGRATION] Added ${columnName} column to apple_subscription_transactions`);
    }
  }

  if (!(await indexExists('apple_subscription_transactions_environment_transaction_id_unique'))) {
    await assertNoTransactionIdConflicts();
    await sequelize.query(
      'CREATE UNIQUE INDEX apple_subscription_transactions_environment_transaction_id_unique ON apple_subscription_transactions(environment, transactionId);'
    );
  }

  await ensureIndex(
    'apple_subscription_transactions_environment_original_transaction_id_idx',
    'CREATE INDEX apple_subscription_transactions_environment_original_transaction_id_idx ON apple_subscription_transactions(environment, originalTransactionId);'
  );
  await ensureIndex(
    'apple_subscription_transactions_studio_id_idx',
    'CREATE INDEX apple_subscription_transactions_studio_id_idx ON apple_subscription_transactions(studioId);'
  );
  await ensureIndex(
    'apple_subscription_transactions_product_id_idx',
    'CREATE INDEX apple_subscription_transactions_product_id_idx ON apple_subscription_transactions(productId);'
  );
  await ensureIndex(
    'apple_subscription_transactions_expires_date_idx',
    'CREATE INDEX apple_subscription_transactions_expires_date_idx ON apple_subscription_transactions(expiresDate);'
  );
  await ensureIndex(
    'apple_subscription_transactions_ingested_at_idx',
    'CREATE INDEX apple_subscription_transactions_ingested_at_idx ON apple_subscription_transactions(ingestedAt);'
  );
  await ensureIndex(
    'apple_subscription_transactions_app_account_token_idx',
    'CREATE INDEX apple_subscription_transactions_app_account_token_idx ON apple_subscription_transactions(appAccountToken) WHERE appAccountToken IS NOT NULL;'
  );
}

module.exports = ensureAppleSubscriptionTransactionsTable;