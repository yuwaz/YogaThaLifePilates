const { sequelize } = require('./models');

async function ensureAttendanceReservationColumn() {
  const [results] = await sequelize.query("PRAGMA table_info('Attendances')");

  // On a fresh database, Attendances may not exist yet; sequelize.sync() will create it.
  if (!Array.isArray(results) || results.length === 0) {
    return;
  }

  const hasReservationId = results.some((col) => col.name === 'reservationId');

  if (!hasReservationId) {
    await sequelize.query("ALTER TABLE Attendances ADD COLUMN reservationId INTEGER NULL;");
    console.log('[DB MIGRATION] Added reservationId column to Attendances');
  }
}

module.exports = ensureAttendanceReservationColumn;
