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

async function getTableSql(tableName) {
  const [rows] = await sequelize.query(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    { replacements: [tableName] }
  );
  return Array.isArray(rows) && rows[0] && rows[0].sql ? String(rows[0].sql) : '';
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

function assertPlatformAuditLogsSchemaCompatible(columns) {
  const requiredColumns = {
    id: { notnull: 0, pk: 1 },
    eventId: { notnull: 1 },
    actorPlatformAdminId: { notnull: 0 },
    actionType: { notnull: 1 },
    targetType: { notnull: 0 },
    targetId: { notnull: 0 },
    studioId: { notnull: 0 },
    reason: { notnull: 0 },
    requestId: { notnull: 0 },
    ip: { notnull: 0 },
    userAgent: { notnull: 0 },
    beforeSnapshot: { notnull: 0 },
    afterSnapshot: { notnull: 0 },
    createdAt: { notnull: 1 },
    updatedAt: { notnull: 1 },
  };

  const byName = new Map(columns.map((column) => [column.name, column]));
  for (const [name, expected] of Object.entries(requiredColumns)) {
    const column = byName.get(name);
    if (!column) {
      throw new Error(`PlatformAuditLogs schema is incompatible: missing required column ${name}`);
    }

    if (typeof expected.pk !== 'undefined' && Number(column.pk) !== Number(expected.pk)) {
      throw new Error(`PlatformAuditLogs schema is incompatible: column ${name} has unexpected primary key definition`);
    }

    if (typeof expected.notnull !== 'undefined' && Number(column.notnull) !== Number(expected.notnull)) {
      throw new Error(`PlatformAuditLogs schema is incompatible: column ${name} has unexpected nullability`);
    }
  }
}

async function ensureActorForeignKeyCompatibility() {
  const tableSql = await getTableSql('PlatformAuditLogs');
  if (!/FOREIGN\s+KEY\s*\(\s*actorPlatformAdminId\s*\)\s*REFERENCES\s+PlatformAdmins\s*\(\s*id\s*\)/i.test(tableSql)) {
    throw new Error('PlatformAuditLogs schema is incompatible: actorPlatformAdminId foreign key must reference PlatformAdmins(id)');
  }
}

async function ensurePlatformAuditLogsTable() {
  const hasTable = await tableExists('PlatformAuditLogs');
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE PlatformAuditLogs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        eventId VARCHAR(255) NOT NULL,
        actorPlatformAdminId INTEGER NULL,
        actionType VARCHAR(255) NOT NULL,
        targetType VARCHAR(255) NULL,
        targetId VARCHAR(255) NULL,
        studioId INTEGER NULL,
        reason TEXT NULL,
        requestId VARCHAR(255) NULL,
        ip VARCHAR(255) NULL,
        userAgent TEXT NULL,
        beforeSnapshot JSON NULL,
        afterSnapshot JSON NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (actorPlatformAdminId) REFERENCES PlatformAdmins(id)
      );
    `);
    console.log('[DB MIGRATION] Created PlatformAuditLogs table');
  }

  const columns = await getTableColumns('PlatformAuditLogs');
  assertPlatformAuditLogsSchemaCompatible(columns);
  await ensureActorForeignKeyCompatibility();

  await ensureIndex(
    'platform_audit_logs_event_id_unique',
    'CREATE UNIQUE INDEX platform_audit_logs_event_id_unique ON PlatformAuditLogs(eventId);'
  );
  await ensureIndex(
    'platform_audit_logs_actor_platform_admin_id_idx',
    'CREATE INDEX platform_audit_logs_actor_platform_admin_id_idx ON PlatformAuditLogs(actorPlatformAdminId);'
  );
  await ensureIndex(
    'platform_audit_logs_studio_id_idx',
    'CREATE INDEX platform_audit_logs_studio_id_idx ON PlatformAuditLogs(studioId);'
  );
  await ensureIndex(
    'platform_audit_logs_action_type_idx',
    'CREATE INDEX platform_audit_logs_action_type_idx ON PlatformAuditLogs(actionType);'
  );
  await ensureIndex(
    'platform_audit_logs_created_at_idx',
    'CREATE INDEX platform_audit_logs_created_at_idx ON PlatformAuditLogs(createdAt);'
  );
}

module.exports = ensurePlatformAuditLogsTable;