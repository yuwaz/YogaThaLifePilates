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

async function ensureStudioOnboardingColumns() {
  const hasStudios = await tableExists('Studios');
  if (!hasStudios) {
    return {
      studiosTableExists: false,
      addedOnboardingCompleted: false,
      addedOnboardingStep: false,
      backfilledCompletedNullCount: 0,
      backfilledStepNullCount: 0,
      seededStudioOneCompleted: false,
    };
  }

  const columns = await getTableColumns('Studios');
  let addedOnboardingCompleted = false;
  let addedOnboardingStep = false;

  if (!columns.includes('onboardingCompleted')) {
    await sequelize.query('ALTER TABLE Studios ADD COLUMN onboardingCompleted INTEGER NOT NULL DEFAULT 0;');
    console.log('[DB MIGRATION] Added onboardingCompleted column to Studios');
    addedOnboardingCompleted = true;
  }

  if (!columns.includes('onboardingStep')) {
    await sequelize.query("ALTER TABLE Studios ADD COLUMN onboardingStep VARCHAR(64) NOT NULL DEFAULT 'studio';");
    console.log('[DB MIGRATION] Added onboardingStep column to Studios');
    addedOnboardingStep = true;
  }

  const [completedNullRows] = await sequelize.query('SELECT COUNT(*) AS count FROM Studios WHERE onboardingCompleted IS NULL;');
  const backfilledCompletedNullCount = Number(completedNullRows?.[0]?.count || 0);
  if (backfilledCompletedNullCount > 0) {
    await sequelize.query('UPDATE Studios SET onboardingCompleted = 0 WHERE onboardingCompleted IS NULL;');
    console.log(`[DB MIGRATION] Backfilled ${backfilledCompletedNullCount} Studios rows with onboardingCompleted=0`);
  }

  const [stepNullRows] = await sequelize.query("SELECT COUNT(*) AS count FROM Studios WHERE onboardingStep IS NULL OR TRIM(onboardingStep) = ''; ");
  const backfilledStepNullCount = Number(stepNullRows?.[0]?.count || 0);
  if (backfilledStepNullCount > 0) {
    await sequelize.query("UPDATE Studios SET onboardingStep = 'studio' WHERE onboardingStep IS NULL OR TRIM(onboardingStep) = '';");
    console.log(`[DB MIGRATION] Backfilled ${backfilledStepNullCount} Studios rows with onboardingStep='studio'`);
  }

  const [studioOneRows] = await sequelize.query('SELECT id, onboardingCompleted, onboardingStep FROM Studios WHERE id = ? LIMIT 1;', {
    replacements: [1],
  });

  let seededStudioOneCompleted = false;
  if (Array.isArray(studioOneRows) && studioOneRows.length > 0) {
    const studioOne = studioOneRows[0];
    const completedIsNull = studioOne.onboardingCompleted === null || typeof studioOne.onboardingCompleted === 'undefined';
    const stepIsNull = studioOne.onboardingStep === null || typeof studioOne.onboardingStep === 'undefined' || String(studioOne.onboardingStep).trim() === '';

    if (addedOnboardingCompleted || addedOnboardingStep || completedIsNull || stepIsNull) {
      await sequelize.query("UPDATE Studios SET onboardingCompleted = 1, onboardingStep = 'completed' WHERE id = ?;", {
        replacements: [1],
      });
      seededStudioOneCompleted = true;
      console.log("[DB MIGRATION] Seeded Studio id=1 onboarding state to completed");
    }
  }

  return {
    studiosTableExists: true,
    addedOnboardingCompleted,
    addedOnboardingStep,
    backfilledCompletedNullCount,
    backfilledStepNullCount,
    seededStudioOneCompleted,
  };
}

module.exports = ensureStudioOnboardingColumns;
