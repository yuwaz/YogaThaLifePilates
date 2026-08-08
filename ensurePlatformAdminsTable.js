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

function assertPlatformAdminsSchemaCompatible(columns) {
  const requiredColumns = {
    id: { notnull: 0, pk: 1 },
    email: { notnull: 1 },
    passwordHash: { notnull: 1 },
    status: { notnull: 1 },
    mfaRequired: { notnull: 1 },
    lastLoginAt: { notnull: 0 },
    createdAt: { notnull: 1 },
    updatedAt: { notnull: 1 },
  };

  const byName = new Map(columns.map((column) => [column.name, column]));
  for (const [name, expected] of Object.entries(requiredColumns)) {
    const column = byName.get(name);
    if (!column) {
      throw new Error(`PlatformAdmins schema is incompatible: missing required column ${name}`);
    }

    if (typeof expected.pk !== 'undefined' && Number(column.pk) !== Number(expected.pk)) {
      throw new Error(`PlatformAdmins schema is incompatible: column ${name} has unexpected primary key definition`);
    }

    if (typeof expected.notnull !== 'undefined' && Number(column.notnull) !== Number(expected.notnull)) {
      throw new Error(`PlatformAdmins schema is incompatible: column ${name} has unexpected nullability`);
    }
  }

  if (byName.has('studioId')) {
    throw new Error('PlatformAdmins schema is incompatible: studioId must not exist on PlatformAdmins');
  }
}

async function hasUniqueIndexOnEmail() {
  const [indexes] = await sequelize.query('PRAGMA index_list("PlatformAdmins")');
  if (!Array.isArray(indexes)) return false;

  for (const indexRow of indexes) {
    if (Number(indexRow.unique) !== 1 || !indexRow.name) {
      continue;
    }

    const [indexInfo] = await sequelize.query(`PRAGMA index_info(${quoteIdentifier(indexRow.name)})`);
    if (!Array.isArray(indexInfo)) {
      continue;
    }

    if (indexInfo.length === 1 && indexInfo[0] && indexInfo[0].name === 'email') {
      return true;
    }
  }

  return false;
}

async function ensurePlatformAdminsTable() {
  const hasTable = await tableExists('PlatformAdmins');
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE PlatformAdmins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email VARCHAR(255) NOT NULL,
        passwordHash VARCHAR(255) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        mfaRequired BOOLEAN NOT NULL DEFAULT 0,
        lastLoginAt DATETIME NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB MIGRATION] Created PlatformAdmins table');
  }

  const columns = await getTableColumns('PlatformAdmins');
  assertPlatformAdminsSchemaCompatible(columns);

  const tableSql = await getTableSql('PlatformAdmins');
  if (!/CHECK\s*\(\s*status\s+IN\s*\(\s*'active'\s*,\s*'disabled'\s*\)\s*\)/i.test(tableSql)) {
    throw new Error('PlatformAdmins schema is incompatible: status CHECK constraint is missing or incompatible');
  }

  const requiredIndexName = 'platform_admins_email_unique';
  if (!(await hasUniqueIndexOnEmail())) {
    if (!(await indexExists(requiredIndexName))) {
      await sequelize.query('CREATE UNIQUE INDEX platform_admins_email_unique ON PlatformAdmins(email);');
    }

    if (!(await hasUniqueIndexOnEmail())) {
      throw new Error('PlatformAdmins schema is incompatible: unique email index could not be ensured');
    }
  }
}

module.exports = ensurePlatformAdminsTable;