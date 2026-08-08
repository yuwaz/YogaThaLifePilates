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
  return Array.isArray(rows) ? rows : [];
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

function assertSchemaCompatible(columns) {
  const requiredColumns = {
    id: { notnull: 0, pk: 1 },
    studioId: { notnull: 1 },
    subscriptionPlan: { notnull: 1 },
    subscriptionStatus: { notnull: 1 },
    effectiveFrom: { notnull: 1 },
    expiresAt: { notnull: 0 },
    reason: { notnull: 1 },
    createdByPlatformAdminId: { notnull: 1 },
    previousSubscriptionPlan: { notnull: 0 },
    previousSubscriptionStatus: { notnull: 0 },
    previousTrialEndsAt: { notnull: 0 },
    revokedAt: { notnull: 0 },
    revokedByPlatformAdminId: { notnull: 0 },
    revokeReason: { notnull: 0 },
    createdAt: { notnull: 1 },
    updatedAt: { notnull: 1 },
  };

  const byName = new Map(columns.map((column) => [column.name, column]));
  for (const [name, expected] of Object.entries(requiredColumns)) {
    const column = byName.get(name);
    if (!column) {
      throw new Error(`StudioManualSubscriptionOverrides schema is incompatible: missing required column ${name}`);
    }

    if (typeof expected.pk !== 'undefined' && Number(column.pk) !== Number(expected.pk)) {
      throw new Error(`StudioManualSubscriptionOverrides schema is incompatible: column ${name} has unexpected primary key definition`);
    }

    if (typeof expected.notnull !== 'undefined' && Number(column.notnull) !== Number(expected.notnull)) {
      throw new Error(`StudioManualSubscriptionOverrides schema is incompatible: column ${name} has unexpected nullability`);
    }
  }
}

async function ensureStudioManualSubscriptionOverridesTable() {
  const tableName = 'StudioManualSubscriptionOverrides';
  const hasTable = await tableExists(tableName);

  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE StudioManualSubscriptionOverrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        studioId INTEGER NOT NULL REFERENCES Studios(id),
        subscriptionPlan VARCHAR(255) NOT NULL,
        subscriptionStatus VARCHAR(255) NOT NULL,
        effectiveFrom DATETIME NOT NULL,
        expiresAt DATETIME NULL,
        reason TEXT NOT NULL,
        createdByPlatformAdminId INTEGER NOT NULL REFERENCES PlatformAdmins(id),
        previousSubscriptionPlan VARCHAR(255) NULL,
        previousSubscriptionStatus VARCHAR(255) NULL,
        previousTrialEndsAt DATETIME NULL,
        revokedAt DATETIME NULL,
        revokedByPlatformAdminId INTEGER NULL REFERENCES PlatformAdmins(id),
        revokeReason TEXT NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB MIGRATION] Created StudioManualSubscriptionOverrides table');
  }

  const columns = await getTableColumns(tableName);
  assertSchemaCompatible(columns);

  await ensureIndex(
    'studio_manual_subscription_overrides_studio_id_idx',
    'CREATE INDEX studio_manual_subscription_overrides_studio_id_idx ON StudioManualSubscriptionOverrides(studioId);'
  );
  await ensureIndex(
    'studio_manual_subscription_overrides_created_by_idx',
    'CREATE INDEX studio_manual_subscription_overrides_created_by_idx ON StudioManualSubscriptionOverrides(createdByPlatformAdminId);'
  );
  await ensureIndex(
    'studio_manual_subscription_overrides_revoked_by_idx',
    'CREATE INDEX studio_manual_subscription_overrides_revoked_by_idx ON StudioManualSubscriptionOverrides(revokedByPlatformAdminId);'
  );
  await ensureIndex(
    'studio_manual_subscription_overrides_effective_from_idx',
    'CREATE INDEX studio_manual_subscription_overrides_effective_from_idx ON StudioManualSubscriptionOverrides(effectiveFrom);'
  );
  await ensureIndex(
    'studio_manual_subscription_overrides_expires_at_idx',
    'CREATE INDEX studio_manual_subscription_overrides_expires_at_idx ON StudioManualSubscriptionOverrides(expiresAt);'
  );
  await ensureIndex(
    'studio_manual_subscription_overrides_one_active_per_studio_unique',
    'CREATE UNIQUE INDEX studio_manual_subscription_overrides_one_active_per_studio_unique ON StudioManualSubscriptionOverrides(studioId) WHERE revokedAt IS NULL;'
  );
}

module.exports = ensureStudioManualSubscriptionOverridesTable;