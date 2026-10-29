const { Op } = require('sequelize');
const { sequelize, User, UserFeeHistory, Studio } = require('../models');
const { getStudioOwnerUserId } = require('./studioOwnerService');

// The ensure-script creates the table at bootstrap, but reports must keep working
// in the pre-migration window (legacy current-fee behavior). Checked on each call:
// the table may be created later in the process lifetime.
async function hasUserFeeHistoryTable() {
  const [rows] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'UserFeeHistories'"
  );
  return Array.isArray(rows) && rows.length > 0;
}

const DEFAULT_TIMEZONE = 'Europe/Istanbul';

function toLocalDateString(value, timeZone) {
  const parsedDate = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(parsedDate);

    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

async function getStudioLocalDate(studioId, atDate = new Date()) {
  const studio = await Studio.findOne({ where: { id: studioId }, attributes: ['timezone'] });
  const timeZone = studio && studio.timezone ? studio.timezone : DEFAULT_TIMEZONE;
  return toLocalDateString(atDate, timeZone) || toLocalDateString(atDate, DEFAULT_TIMEZONE);
}

// Teaching-capable = role 'instructor' OR the Studio's stable owner admin (never later admins).
async function isTeachingCapableUser(studioId, user) {
  if (!user) return false;
  if (user.role === 'instructor') return true;
  if (user.role === 'admin') {
    const ownerUserId = await getStudioOwnerUserId(studioId);
    return ownerUserId !== null && ownerUserId === Number(user.id);
  }
  return false;
}

// Records a fee history entry for a teaching-capable user when fees actually change.
// Same-day edits update the same effective-date row (latest rate wins for the whole
// calendar date). The migration baseline (anchored at 1970-01-01) is never mutated:
// an edit on the migration date creates a separate row at the real date, so sessions
// before the migration date keep the baseline while same-day sessions use the new rate.
// Returns true when a history row was created/updated.
async function recordFeeChangeIfNeeded({ user, studioId, groupSessionFee, individualSessionFee, atDate }) {
  if (!user || !Number.isInteger(Number(user.id))) return false;
  if (!(await hasUserFeeHistoryTable())) return false;
  if (!(await isTeachingCapableUser(studioId, user))) return false;

  const nextGroupFee = Number(groupSessionFee || 0);
  const nextIndividualFee = Number(individualSessionFee || 0);
  const effectiveFromDate = await getStudioLocalDate(studioId, atDate || new Date());
  if (!effectiveFromDate) return false;

  const sameDayRow = await UserFeeHistory.findOne({
    where: { studioId, userId: user.id, effectiveFromDate },
  });
  if (sameDayRow) {
    if (
      Number(sameDayRow.groupSessionFee) === nextGroupFee &&
      Number(sameDayRow.individualSessionFee) === nextIndividualFee
    ) {
      return false;
    }
    sameDayRow.groupSessionFee = nextGroupFee;
    sameDayRow.individualSessionFee = nextIndividualFee;
    await sameDayRow.save();
    return true;
  }

  const latestRow = await UserFeeHistory.findOne({
    where: { studioId, userId: user.id },
    order: [['effectiveFromDate', 'DESC'], ['id', 'DESC']],
  });
  if (
    latestRow &&
    Number(latestRow.groupSessionFee) === nextGroupFee &&
    Number(latestRow.individualSessionFee) === nextIndividualFee
  ) {
    return false;
  }

  await UserFeeHistory.create({
    userId: user.id,
    studioId,
    groupSessionFee: nextGroupFee,
    individualSessionFee: nextIndividualFee,
    effectiveFromDate,
  });
  return true;
}

// Loads fee history for the given instructors once and returns a resolver:
// feeFor(instructorId, sessionDate) -> { groupSessionFee, individualSessionFee }.
// Resolution: latest history entry with effectiveFromDate <= sessionDate.
// Sessions predating the first history entry keep legacy behavior: the current
// Users fee is applied, so pre-migration report amounts never change.
async function buildFeeResolver({ studioId, instructorIds }) {
  const ids = [...new Set((instructorIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];

  const users = ids.length
    ? await User.findAll({
        where: { studioId, id: { [Op.in]: ids } },
        attributes: ['id', 'groupSessionFee', 'individualSessionFee'],
      })
    : [];
  const currentFeeById = new Map(users.map((u) => [
    Number(u.id),
    {
      groupSessionFee: Number(u.groupSessionFee || 0),
      individualSessionFee: Number(u.individualSessionFee || 0),
    },
  ]));

  const historyRows = ids.length && (await hasUserFeeHistoryTable())
    ? await UserFeeHistory.findAll({
        where: { studioId, userId: { [Op.in]: ids } },
        attributes: ['userId', 'groupSessionFee', 'individualSessionFee', 'effectiveFromDate'],
        order: [['effectiveFromDate', 'ASC'], ['id', 'ASC']],
      })
    : [];
  const historyById = new Map();
  for (const row of historyRows) {
    const key = Number(row.userId);
    if (!historyById.has(key)) historyById.set(key, []);
    historyById.get(key).push({
      effectiveFromDate: String(row.effectiveFromDate),
      groupSessionFee: Number(row.groupSessionFee || 0),
      individualSessionFee: Number(row.individualSessionFee || 0),
    });
  }

  function feeFor(instructorId, sessionDate) {
    const id = Number(instructorId);
    const currentFee = currentFeeById.get(id) || { groupSessionFee: 0, individualSessionFee: 0 };
    const history = historyById.get(id);
    if (!history || history.length === 0 || !sessionDate) {
      return currentFee;
    }

    const dateStr = String(sessionDate);
    let applicable = null;
    for (const entry of history) {
      if (entry.effectiveFromDate <= dateStr) {
        applicable = entry;
      } else {
        break;
      }
    }
    if (applicable) {
      return { groupSessionFee: applicable.groupSessionFee, individualSessionFee: applicable.individualSessionFee };
    }
    // Pre-history sessions: pinned to the earliest recorded rate (the migration
    // baseline), so later fee changes never reprice them. When no baseline exists
    // (e.g. user created before the table existed and never seeded), fall back to
    // the legacy current fee.
    const earliest = history[0];
    return { groupSessionFee: earliest.groupSessionFee, individualSessionFee: earliest.individualSessionFee };
  }

  // Exposed for tests/tooling: raw history accessor by instructor.
  function historyFor(instructorId) {
    return historyById.get(Number(instructorId)) || [];
  }

  return { feeFor, currentFeeById, historyFor };
}

module.exports = {
  getStudioLocalDate,
  isTeachingCapableUser,
  recordFeeChangeIfNeeded,
  buildFeeResolver,
};
