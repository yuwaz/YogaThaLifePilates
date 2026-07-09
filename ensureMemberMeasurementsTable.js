const { sequelize } = require('./models');

const measurementColumns = [
  'height',
  'weight',
  'waist',
  'hip',
  'chest',
  'arm',
  'leg',
  'shoulder',
  'bodyFatPercentage',
];

function toDateOnly(value) {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

async function tableExists(tableName) {
  const [rows] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    { replacements: [tableName] }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function getTableColumns(tableName) {
  const [rows] = await sequelize.query(`PRAGMA table_info('${tableName}')`);
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => row.name);
}

async function createIndexIfColumnExists(tableName, columnName, indexName) {
  const columns = await getTableColumns(tableName);
  if (!columns.includes(columnName)) {
    return;
  }

  try {
    await sequelize.query(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${columnName});`);
  } catch (err) {
    console.warn(`[DB MIGRATION] Optional index ${indexName} was not created: ${err.message}`);
  }
}

async function ensureMemberMeasurementsTable() {
  const hasMemberMeasurements = await tableExists('MemberMeasurements');
  if (!hasMemberMeasurements) {
    await sequelize.query(`
      CREATE TABLE MemberMeasurements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memberId INTEGER NOT NULL,
        measuredAt DATETIME NOT NULL,
        height DECIMAL(10,2) NULL,
        weight DECIMAL(10,2) NULL,
        waist DECIMAL(10,2) NULL,
        hip DECIMAL(10,2) NULL,
        chest DECIMAL(10,2) NULL,
        arm DECIMAL(10,2) NULL,
        leg DECIMAL(10,2) NULL,
        shoulder DECIMAL(10,2) NULL,
        bodyFatPercentage DECIMAL(10,2) NULL,
        notes TEXT NULL,
        createdByUserId INTEGER NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  await createIndexIfColumnExists('MemberMeasurements', 'memberId', 'idx_member_measurements_member_id');
  await createIndexIfColumnExists('MemberMeasurements', 'measuredAt', 'idx_member_measurements_measured_at');

  const membersTableExists = await tableExists('Members');
  if (!membersTableExists) {
    return;
  }

  const [countRows] = await sequelize.query('SELECT COUNT(*) AS count FROM MemberMeasurements;');
  const measurementCount = Number(countRows?.[0]?.count || 0);
  if (measurementCount > 0) {
    return;
  }

  const whereMeasurementsNotNull = measurementColumns
    .map((column) => `${column} IS NOT NULL`)
    .join(' OR ');

  const [members] = await sequelize.query(`
    SELECT id, updatedAt, ${measurementColumns.join(', ')}
    FROM Members
    WHERE ${whereMeasurementsNotNull};
  `);

  for (const member of members) {
    const measuredAt = toDateOnly(member.updatedAt);
    const values = measurementColumns.map((column) => member[column]);
    await sequelize.query(
      `
      INSERT INTO MemberMeasurements (
        memberId,
        measuredAt,
        ${measurementColumns.join(', ')},
        notes,
        createdByUserId,
        createdAt,
        updatedAt
      ) VALUES (
        ?,
        ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        NULL,
        NULL,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      );
      `,
      {
        replacements: [member.id, measuredAt, ...values],
      }
    );
  }

  if (members.length > 0) {
    console.log(`[DB MIGRATION] Backfilled ${members.length} MemberMeasurements rows`);
  }
}

module.exports = ensureMemberMeasurementsTable;