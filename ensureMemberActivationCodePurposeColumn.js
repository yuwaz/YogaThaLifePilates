const { sequelize } = require('./models');

async function ensureMemberActivationCodePurposeColumn() {
  const [results] = await sequelize.query("PRAGMA table_info('MemberActivationCodes')");

  // On a fresh database the table may not exist yet; sequelize.sync() will create it.
  if (!Array.isArray(results) || results.length === 0) {
    return;
  }

  const hasPurpose = results.some((col) => col.name === 'purpose');

  if (!hasPurpose) {
    await sequelize.query(
      "ALTER TABLE MemberActivationCodes ADD COLUMN purpose VARCHAR(16) NOT NULL DEFAULT 'activation';"
    );
    console.log('[DB MIGRATION] Added purpose column to MemberActivationCodes');
  }

  await sequelize.query(
    "UPDATE MemberActivationCodes SET purpose = 'activation' WHERE purpose IS NULL OR TRIM(purpose) = '';"
  );
}

module.exports = ensureMemberActivationCodePurposeColumn;
