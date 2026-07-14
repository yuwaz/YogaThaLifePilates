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

async function ensureLessonPackageStudioIdColumn() {
  const hasLessonPackages = await tableExists('LessonPackages');
  if (!hasLessonPackages) {
    return { addedColumn: false, backfilledCount: 0, lessonPackagesTableExists: false };
  }

  const hasStudios = await tableExists('Studios');
  if (!hasStudios) {
    throw new Error('Studios table is required before ensuring LessonPackages.studioId');
  }

  const [studioRows] = await sequelize.query('SELECT id FROM Studios WHERE id = ? LIMIT 1', {
    replacements: [1],
  });

  if (!Array.isArray(studioRows) || studioRows.length === 0) {
    throw new Error('Studio id=1 must exist before ensuring LessonPackages.studioId');
  }

  const columns = await getTableColumns('LessonPackages');
  let addedColumn = false;
  if (!columns.includes('studioId')) {
    await sequelize.query('ALTER TABLE LessonPackages ADD COLUMN studioId INTEGER NOT NULL DEFAULT 1;');
    console.log('[DB MIGRATION] Added studioId column to LessonPackages');
    addedColumn = true;
  }

  const [countRows] = await sequelize.query('SELECT COUNT(*) AS count FROM LessonPackages WHERE studioId IS NULL;');
  const backfilledCount = Number(countRows?.[0]?.count || 0);

  if (backfilledCount > 0) {
    await sequelize.query('UPDATE LessonPackages SET studioId = 1 WHERE studioId IS NULL;');
    console.log(`[DB MIGRATION] Backfilled ${backfilledCount} LessonPackages rows with studioId=1`);
  }

  return { addedColumn, backfilledCount, lessonPackagesTableExists: true };
}

module.exports = ensureLessonPackageStudioIdColumn;