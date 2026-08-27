const { Member, sequelize } = require('../models');
const { CLASSIFICATIONS, normalizePhone } = require('../utils/phoneNormalization');

const APPLY_MODE = process.argv.includes('--apply');

function maskPhone(phone) {
  if (typeof phone !== 'string') return '<empty>';
  const compact = phone.trim().replace(/[\s().-]/g, '');
  if (compact.length <= 4) return '***';
  return `${compact.slice(0, 3)}***${compact.slice(-2)}`;
}

function isEligible(result) {
  return result.classification === CLASSIFICATIONS.TURKISH_MOBILE
    || result.classification === CLASSIFICATIONS.INTERNATIONAL_E164;
}

function addToGroup(groups, key, member) {
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(member);
}

function printGroupReport(title, groups) {
  console.log(`${title}: ${groups.length}`);
  for (const group of groups) {
    console.log(`  ${maskPhone(group.normalizedPhone)} -> ${group.members.map((member) => `Member ${member.id} (studio ${member.studioId})`).join(', ')}`);
  }
}

async function loadMembers() {
  return Member.findAll({
    attributes: ['id', 'studioId', 'phone', 'normalizedPhone'],
    order: [['id', 'ASC']],
    raw: true,
  });
}

async function run() {
  const members = await loadMembers();
  const counts = {
    total: members.length,
    alreadyPopulated: members.filter((member) => member.normalizedPhone !== null && member.normalizedPhone !== '').length,
    confidentlyNormalizable: 0,
    invalid: 0,
    ambiguous: 0,
    empty: 0,
  };
  const normalizedGroups = new Map();
  const sameStudioGroups = [];
  const crossStudioGroups = [];
  const updates = [];

  for (const member of members) {
    const result = normalizePhone(member.phone);
    const desired = isEligible(result) ? result.normalizedPhone : null;

    if (isEligible(result)) {
      counts.confidentlyNormalizable += 1;
      addToGroup(normalizedGroups, desired, member);
    } else {
      counts[result.classification] += 1;
      if (APPLY_MODE && member.normalizedPhone !== null) {
        updates.push({ id: member.id, normalizedPhone: null });
      }
    }

    if (APPLY_MODE && isEligible(result) && member.normalizedPhone !== desired) {
      updates.push({ id: member.id, normalizedPhone: desired });
    }
  }

  for (const [normalizedPhone, group] of normalizedGroups) {
    const studioIds = new Set(group.map((member) => member.studioId));
    if (group.length > 1) {
      const membersByStudio = new Map();
      for (const member of group) {
        if (!membersByStudio.has(member.studioId)) membersByStudio.set(member.studioId, []);
        membersByStudio.get(member.studioId).push(member);
      }
      for (const [studioId, studioMembers] of membersByStudio) {
        if (studioMembers.length > 1) {
          sameStudioGroups.push({ normalizedPhone, studioId, members: studioMembers });
        }
      }
      if (studioIds.size > 1) crossStudioGroups.push({ normalizedPhone, members: group });
    }
  }

  console.log(JSON.stringify(counts, null, 2));
  printGroupReport('Same-studio normalized conflicts', sameStudioGroups);
  printGroupReport('Cross-studio normalized matches', crossStudioGroups);

  if (!APPLY_MODE) {
    console.log('Report-only mode: no database writes performed.');
    return;
  }

  await sequelize.transaction(async (transaction) => {
    for (const update of updates) {
      await Member.update(
        { normalizedPhone: update.normalizedPhone },
        { where: { id: update.id }, transaction }
      );
    }
  });
  console.log(`Apply mode updated ${updates.length} Member rows; Member.phone was not changed.`);
}

run()
  .catch((error) => {
    console.error(`Member normalizedPhone backfill failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });