const { sequelize, User, Studio } = require('./models');

async function tableExists(tableName) {
  const [rows] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    { replacements: [tableName] }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function ensureUserFeeHistoryTable() {
  const hasTable = await tableExists('UserFeeHistories');
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE UserFeeHistories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        studioId INTEGER NOT NULL,
        groupSessionFee DECIMAL(10,2) NOT NULL DEFAULT 0,
        individualSessionFee DECIMAL(10,2) NOT NULL DEFAULT 0,
        effectiveFromDate DATEONLY NOT NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB MIGRATION] Created UserFeeHistories table');
  }

  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS user_fee_histories_studio_user_effective_unique
    ON UserFeeHistories (studioId, userId, effectiveFromDate);
  `);

  // Baseline seed: one history row per teaching-capable user (instructor or stable
  // owner admin) with CURRENT fees. The baseline is anchored at a virtual date
  // (1970-01-01) before all real history so it stays immutable: sessions before
  // the migration date always resolve to it, while fee edits on the migration
  // date itself create a separate row at the real studio-local date. Historical
  // rates are never reconstructed; pre-migration report amounts do not change.
  const hasUsers = await tableExists('Users');
  const hasStudios = await tableExists('Studios');
  if (!hasUsers || !hasStudios) return;

  const BASELINE_DATE = '1970-01-01';

  const studios = await Studio.findAll({ attributes: ['id', 'ownerUserId'] });
  for (const studio of studios) {
    const users = await User.findAll({
      where: { studioId: studio.id },
      attributes: ['id', 'role', 'groupSessionFee', 'individualSessionFee'],
    });
    const eligible = users.filter(
      (user) => user.role === 'instructor' || (studio.ownerUserId !== null && Number(studio.ownerUserId) === Number(user.id))
    );
    if (eligible.length === 0) continue;

    for (const user of eligible) {
      await sequelize.query(
        `INSERT INTO UserFeeHistories (userId, studioId, groupSessionFee, individualSessionFee, effectiveFromDate, createdAt)
         SELECT ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
         WHERE NOT EXISTS (
           SELECT 1 FROM UserFeeHistories WHERE studioId = ? AND userId = ?
         );`,
        {
          replacements: [
            user.id,
            studio.id,
            Number(user.groupSessionFee || 0),
            Number(user.individualSessionFee || 0),
            BASELINE_DATE,
            studio.id,
            user.id,
          ],
        }
      );
    }
  }
}

module.exports = ensureUserFeeHistoryTable;
