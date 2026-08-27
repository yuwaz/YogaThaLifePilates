const { sequelize } = require('./models');

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

async function ensureMemberNormalizedPhoneColumn() {
  if (!(await tableExists('Members'))) {
    return { addedColumn: false, membersTableExists: false };
  }

  const columns = await getTableColumns('Members');
  let addedColumn = false;
  if (!columns.includes('normalizedPhone')) {
    await sequelize.query('ALTER TABLE Members ADD COLUMN normalizedPhone VARCHAR(255) NULL;');
    console.log('[DB MIGRATION] Added nullable normalizedPhone column to Members');
    addedColumn = true;
  }

  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS members_normalized_phone_idx
    ON Members(normalizedPhone);
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS members_studio_normalized_phone_idx
    ON Members(studioId, normalizedPhone);
  `);

  return { addedColumn, membersTableExists: true };
}

module.exports = ensureMemberNormalizedPhoneColumn;
