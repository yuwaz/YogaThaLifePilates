const { sequelize } = require('./models');

async function getTableColumns(tableName) {
  const [rows] = await sequelize.query(`PRAGMA table_info('${tableName}')`);
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => row.name);
}

async function tableExists(tableName) {
  const [rows] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    { replacements: [tableName] }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function ensureInstructorPayoutAndSessionTypeColumns() {
  const hasMemberTypes = await tableExists('MemberTypes');
  if (hasMemberTypes) {
    const memberTypeColumns = await getTableColumns('MemberTypes');
    const hasIsCardBased = memberTypeColumns.includes('isCardBased');
    if (!memberTypeColumns.includes('sessionType')) {
      await sequelize.query("ALTER TABLE MemberTypes ADD COLUMN sessionType VARCHAR(32) NULL DEFAULT 'group';");
      console.log('[DB MIGRATION] Added sessionType column to MemberTypes');
    }

    const refreshedMemberTypeColumns = await getTableColumns('MemberTypes');
    if (refreshedMemberTypeColumns.includes('sessionType')) {
      if (hasIsCardBased) {
        await sequelize.query("UPDATE MemberTypes SET sessionType = 'group' WHERE isCardBased = 1;");
      }
      await sequelize.query("UPDATE MemberTypes SET sessionType = 'group' WHERE sessionType IS NULL OR TRIM(sessionType) = '';");
    }
  }

  const hasUsers = await tableExists('Users');
  if (hasUsers) {
    const userColumns = await getTableColumns('Users');

    if (!userColumns.includes('groupSessionFee')) {
      await sequelize.query('ALTER TABLE Users ADD COLUMN groupSessionFee DECIMAL(10,2) NULL DEFAULT 0;');
      console.log('[DB MIGRATION] Added groupSessionFee column to Users');
    }

    if (!userColumns.includes('individualSessionFee')) {
      await sequelize.query('ALTER TABLE Users ADD COLUMN individualSessionFee DECIMAL(10,2) NULL DEFAULT 0;');
      console.log('[DB MIGRATION] Added individualSessionFee column to Users');
    }

    const refreshedUserColumns = await getTableColumns('Users');
    if (refreshedUserColumns.includes('groupSessionFee')) {
      await sequelize.query('UPDATE Users SET groupSessionFee = 0 WHERE groupSessionFee IS NULL;');
    }
    if (refreshedUserColumns.includes('individualSessionFee')) {
      await sequelize.query('UPDATE Users SET individualSessionFee = 0 WHERE individualSessionFee IS NULL;');
    }
  }
}

module.exports = ensureInstructorPayoutAndSessionTypeColumns;