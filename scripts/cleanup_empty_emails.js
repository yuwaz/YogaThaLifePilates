// One-time script to convert empty string emails to NULL in Members table
const { Member } = require('../models');

async function cleanupEmptyEmails() {
  const [count] = await Member.update(
    { email: null },
    { where: { email: '' } }
  );
  console.log(`Updated ${count} members with empty email to NULL.`);
}

cleanupEmptyEmails().then(() => process.exit(0));