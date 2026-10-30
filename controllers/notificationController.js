const { Op } = require('sequelize');
const { Notification } = require('../models');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

function parseLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, MAX_LIMIT);
}

function parseOffset(value) {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function notificationPayload(n) {
  let payload = n.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    payload,
    readAt: n.readAt,
    createdAt: n.createdAt,
  };
}

// Shared inbox query for the authenticated recipient (member account or staff user).
// recipientType/recipientId/studioId are always enforced -> strict isolation.
async function listForRecipient({ studioId, recipientType, recipientId, query }) {
  const limit = parseLimit(query.limit);
  const offset = parseOffset(query.offset);
  if (limit === null || offset === null) {
    throw { status: 400, message: 'Invalid limit or offset' };
  }
  const where = { studioId, recipientType, recipientId };
  const { rows, count } = await Notification.findAndCountAll({
    where,
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
  });
  return {
    notifications: rows.map(notificationPayload),
    total: count,
    limit,
    offset,
  };
}

async function unreadCountForRecipient({ studioId, recipientType, recipientId }) {
  const count = await Notification.count({
    where: { studioId, recipientType, recipientId, readAt: null },
  });
  return { unreadCount: count };
}

async function markReadForRecipient({ studioId, recipientType, recipientId, notificationId }) {
  const notification = await Notification.findOne({
    where: { id: notificationId, studioId, recipientType, recipientId },
  });
  if (!notification) throw { status: 404, message: 'Not found' };
  if (!notification.readAt) {
    notification.readAt = new Date();
    await notification.save({ fields: ['readAt'] });
  }
  return notificationPayload(notification);
}

async function markAllReadForRecipient({ studioId, recipientType, recipientId }) {
  const [updated] = await Notification.update(
    { readAt: new Date() },
    { where: { studioId, recipientType, recipientId, readAt: null } }
  );
  return { updated };
}

// --- Member inbox (member global token; studio from context) ---
// Members use the global token; the studio scope comes from the active membership.
// For inbox purposes we scope to the account's notifications across their studios
// is NOT allowed — member must be in a studio context. We use the member's
// membership studio via the context token when available, else all their
// memberships' studios are out of scope; simplest safe scope: the account id.
async function memberInbox(req, res) {
  try {
    const accountId = req.memberAccountId;
    // Member notifications are keyed by recipientType='member', recipientId=accountId.
    // Studio isolation: only notifications for studios the member has an active
    // membership in. Resolve those studio ids.
    const { MemberAccountMembership } = require('../models');
    const memberships = await MemberAccountMembership.findAll({
      where: { accountId },
      attributes: ['studioId'],
    });
    const studioIds = memberships.map((m) => m.studioId);
    const result = await listForRecipientMultiStudio({
      studioIds, recipientType: 'member', recipientId: accountId, query: req.query,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Failed to fetch notifications' });
  }
}

async function listForRecipientMultiStudio({ studioIds, recipientType, recipientId, query }) {
  const limit = parseLimit(query.limit);
  const offset = parseOffset(query.offset);
  if (limit === null || offset === null) {
    throw { status: 400, message: 'Invalid limit or offset' };
  }
  const where = { studioId: { [Op.in]: studioIds.length ? studioIds : [-1] }, recipientType, recipientId };
  const { rows, count } = await Notification.findAndCountAll({
    where,
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
  });
  return { notifications: rows.map(notificationPayload), total: count, limit, offset };
}

async function memberUnreadCount(req, res) {
  try {
    const { MemberAccountMembership } = require('../models');
    const memberships = await MemberAccountMembership.findAll({
      where: { accountId: req.memberAccountId },
      attributes: ['studioId'],
    });
    const studioIds = memberships.map((m) => m.studioId);
    const count = await Notification.count({
      where: { studioId: { [Op.in]: studioIds.length ? studioIds : [-1] }, recipientType: 'member', recipientId: req.memberAccountId, readAt: null },
    });
    res.json({ unreadCount: count });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

async function memberMarkRead(req, res) {
  try {
    const { MemberAccountMembership } = require('../models');
    const memberships = await MemberAccountMembership.findAll({
      where: { accountId: req.memberAccountId },
      attributes: ['studioId'],
    });
    const studioIds = memberships.map((m) => m.studioId);
    const notification = await Notification.findOne({
      where: {
        id: req.params.id,
        studioId: { [Op.in]: studioIds.length ? studioIds : [-1] },
        recipientType: 'member',
        recipientId: req.memberAccountId,
      },
    });
    if (!notification) return res.sendStatus(404);
    if (!notification.readAt) {
      notification.readAt = new Date();
      await notification.save({ fields: ['readAt'] });
    }
    res.json(notificationPayload(notification));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

async function memberMarkAllRead(req, res) {
  try {
    const { MemberAccountMembership } = require('../models');
    const memberships = await MemberAccountMembership.findAll({
      where: { accountId: req.memberAccountId },
      attributes: ['studioId'],
    });
    const studioIds = memberships.map((m) => m.studioId);
    const [updated] = await Notification.update(
      { readAt: new Date() },
      { where: { studioId: { [Op.in]: studioIds.length ? studioIds : [-1] }, recipientType: 'member', recipientId: req.memberAccountId, readAt: null } }
    );
    res.json({ updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// --- Staff inbox (admin/instructor; studio from staff token) ---
async function staffInbox(req, res) {
  try {
    const recipientType = req.user.role === 'instructor' ? 'instructor' : 'admin';
    const result = await listForRecipient({
      studioId: req.user.studioId, recipientType, recipientId: req.user.id, query: req.query,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Failed to fetch notifications' });
  }
}

async function staffUnreadCount(req, res) {
  try {
    const recipientType = req.user.role === 'instructor' ? 'instructor' : 'admin';
    const result = await unreadCountForRecipient({
      studioId: req.user.studioId, recipientType, recipientId: req.user.id,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

async function staffMarkRead(req, res) {
  try {
    const recipientType = req.user.role === 'instructor' ? 'instructor' : 'admin';
    const result = await markReadForRecipient({
      studioId: req.user.studioId, recipientType, recipientId: req.user.id, notificationId: req.params.id,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}

async function staffMarkAllRead(req, res) {
  try {
    const recipientType = req.user.role === 'instructor' ? 'instructor' : 'admin';
    const result = await markAllReadForRecipient({
      studioId: req.user.studioId, recipientType, recipientId: req.user.id,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

module.exports = {
  memberInbox,
  memberUnreadCount,
  memberMarkRead,
  memberMarkAllRead,
  staffInbox,
  staffUnreadCount,
  staffMarkRead,
  staffMarkAllRead,
};
