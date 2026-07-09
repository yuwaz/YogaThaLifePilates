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
  if (!value) {
    return new Date().toISOString().slice(0, 10);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

async function tableExists(tableName) {
  const [rows] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    { replacements: [tableName] }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function ensureMemberMeasurementsTable() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS MemberMeasurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memberId INTEGER NOT NULL,
      measurementDate DATE NOT NULL,
      height DECIMAL(10,2) NULL,
      weight DECIMAL(10,2) NULL,
      waist DECIMAL(10,2) NULL,
      hip DECIMAL(10,2) NULL,
      chest DECIMAL(10,2) NULL,
      arm DECIMAL(10,2) NULL,
      leg DECIMAL(10,2) NULL,
      shoulder DECIMAL(10,2) NULL,
      bodyFatPercentage DECIMAL(10,2) NULL,
      note TEXT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await sequelize.query('CREATE INDEX IF NOT EXISTS idx_member_measurements_member_id ON MemberMeasurements(memberId);');
  await sequelize.query('CREATE INDEX IF NOT EXISTS idx_member_measurements_measurement_date ON MemberMeasurements(measurementDate);');

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
    const measurementDate = toDateOnly(member.updatedAt);
    const values = measurementColumns.map((column) => member[column]);
    await sequelize.query(
      `
      INSERT INTO MemberMeasurements (
        memberId,
        measurementDate,
        ${measurementColumns.join(', ')},
        note,
        createdAt,
        updatedAt
      ) VALUES (
        ?,
        ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        NULL,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      );
      `,
      {
        replacements: [member.id, measurementDate, ...values],
      }
    );
  }

  if (members.length > 0) {
    console.log(`[DB MIGRATION] Backfilled ${members.length} MemberMeasurements rows`);
  }
}

module.exports = ensureMemberMeasurementsTable;