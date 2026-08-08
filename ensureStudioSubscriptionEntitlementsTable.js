const { sequelize } = require('./models');
const {
  EFFECTIVE_ENTITLEMENT_STATUSES,
} = require('./models/subscriptionInfrastructureMetadata');

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

async function assertNoConflictingEffectiveRows() {
  const placeholders = EFFECTIVE_ENTITLEMENT_STATUSES.map(() => '?').join(', ');
  const [rows] = await sequelize.query(
    `SELECT studioId, COUNT(*) AS count
       FROM StudioSubscriptionEntitlements
      WHERE normalizedStatus IN (${placeholders})
   GROUP BY studioId
     HAVING COUNT(*) > 1
      LIMIT 1;`,
    { replacements: EFFECTIVE_ENTITLEMENT_STATUSES }
  );

  if (Array.isArray(rows) && rows.length > 0) {
    throw new Error('StudioSubscriptionEntitlements has conflicting effective rows for a studio');
  }
}

async function assertNoConflictingProviderSubscriptionBindings() {
  const [rows] = await sequelize.query(`
    SELECT provider, environment, providerSubscriptionId, COUNT(*) AS count
      FROM StudioSubscriptionEntitlements
     WHERE providerSubscriptionId IS NOT NULL
  GROUP BY provider, environment, providerSubscriptionId
    HAVING COUNT(*) > 1
     LIMIT 1;
  `);

  if (Array.isArray(rows) && rows.length > 0) {
    throw new Error('StudioSubscriptionEntitlements has conflicting provider subscription bindings');
  }
}

async function ensureStudioSubscriptionEntitlementsTable() {
  const hasTable = await tableExists('StudioSubscriptionEntitlements');
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE StudioSubscriptionEntitlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        studioId INTEGER NOT NULL REFERENCES Studios(id),
        provider VARCHAR(255) NOT NULL,
        plan VARCHAR(255) NOT NULL,
        normalizedStatus VARCHAR(255) NOT NULL,
        providerProductId VARCHAR(255) NOT NULL,
        providerSubscriptionId VARCHAR(255) NULL,
        currentPeriodStart DATETIME NULL,
        currentPeriodEnd DATETIME NULL,
        trialEndsAt DATETIME NULL,
        autoRenewEnabled BOOLEAN NULL,
        gracePeriodEndsAt DATETIME NULL,
        revokedAt DATETIME NULL,
        refundedAt DATETIME NULL,
        pausedAt DATETIME NULL,
        lastVerifiedAt DATETIME NULL,
        sourceLastUpdate VARCHAR(255) NOT NULL,
        environment VARCHAR(255) NOT NULL,
        providerStateVersion VARCHAR(255) NULL,
        providerEventTime DATETIME NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB MIGRATION] Created StudioSubscriptionEntitlements table');
  }

  const columns = await getTableColumns('StudioSubscriptionEntitlements');
  const columnDefinitions = [
    ['providerStateVersion', 'ALTER TABLE StudioSubscriptionEntitlements ADD COLUMN providerStateVersion VARCHAR(255) NULL;'],
    ['providerEventTime', 'ALTER TABLE StudioSubscriptionEntitlements ADD COLUMN providerEventTime DATETIME NULL;'],
    ['refundedAt', 'ALTER TABLE StudioSubscriptionEntitlements ADD COLUMN refundedAt DATETIME NULL;'],
    ['pausedAt', 'ALTER TABLE StudioSubscriptionEntitlements ADD COLUMN pausedAt DATETIME NULL;'],
    ['lastVerifiedAt', 'ALTER TABLE StudioSubscriptionEntitlements ADD COLUMN lastVerifiedAt DATETIME NULL;'],
    ['sourceLastUpdate', "ALTER TABLE StudioSubscriptionEntitlements ADD COLUMN sourceLastUpdate VARCHAR(255) NOT NULL DEFAULT 'verify_endpoint';"],
    ['environment', "ALTER TABLE StudioSubscriptionEntitlements ADD COLUMN environment VARCHAR(255) NOT NULL DEFAULT 'test';"],
  ];

  for (const [columnName, sql] of columnDefinitions) {
    if (!columns.includes(columnName)) {
      await sequelize.query(sql);
      console.log(`[DB MIGRATION] Added ${columnName} column to StudioSubscriptionEntitlements`);
    }
  }

  await ensureIndex(
    'studio_subscription_entitlements_studio_id_idx',
    'CREATE INDEX studio_subscription_entitlements_studio_id_idx ON StudioSubscriptionEntitlements(studioId);'
  );
  await ensureIndex(
    'studio_subscription_entitlements_normalized_status_idx',
    'CREATE INDEX studio_subscription_entitlements_normalized_status_idx ON StudioSubscriptionEntitlements(normalizedStatus);'
  );
  await ensureIndex(
    'studio_subscription_entitlements_provider_subscription_id_idx',
    'CREATE INDEX studio_subscription_entitlements_provider_subscription_id_idx ON StudioSubscriptionEntitlements(provider, providerSubscriptionId);'
  );
  await ensureIndex(
    'studio_subscription_entitlements_provider_environment_idx',
    'CREATE INDEX studio_subscription_entitlements_provider_environment_idx ON StudioSubscriptionEntitlements(provider, environment);'
  );
  await ensureIndex(
    'studio_subscription_entitlements_current_period_end_idx',
    'CREATE INDEX studio_subscription_entitlements_current_period_end_idx ON StudioSubscriptionEntitlements(currentPeriodEnd);'
  );
  await ensureIndex(
    'studio_subscription_entitlements_last_verified_at_idx',
    'CREATE INDEX studio_subscription_entitlements_last_verified_at_idx ON StudioSubscriptionEntitlements(lastVerifiedAt);'
  );

  if (!(await indexExists('studio_subscription_entitlements_one_effective_per_studio_unique'))) {
    await assertNoConflictingEffectiveRows();
    await sequelize.query(
      "CREATE UNIQUE INDEX studio_subscription_entitlements_one_effective_per_studio_unique ON StudioSubscriptionEntitlements(studioId) WHERE normalizedStatus IN ('trialing', 'active', 'grace_period', 'billing_retry', 'paused');"
    );
  }

  if (!(await indexExists('studio_subscription_entitlements_provider_subscription_unique'))) {
    await assertNoConflictingProviderSubscriptionBindings();
    await sequelize.query(
      'CREATE UNIQUE INDEX studio_subscription_entitlements_provider_subscription_unique ON StudioSubscriptionEntitlements(provider, environment, providerSubscriptionId) WHERE providerSubscriptionId IS NOT NULL;'
    );
  }
}

module.exports = ensureStudioSubscriptionEntitlementsTable;