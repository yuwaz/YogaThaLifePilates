const { DeviceToken } = require('../models');

const PLATFORMS = ['ios', 'android', 'web'];
const TOKEN_MIN_LENGTH = 10;
const TOKEN_MAX_LENGTH = 512;

class DeviceTokenError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function validateToken(token) {
  if (typeof token !== 'string') throw new DeviceTokenError('Invalid token');
  const trimmed = token.trim();
  if (trimmed.length < TOKEN_MIN_LENGTH || trimmed.length > TOKEN_MAX_LENGTH) {
    throw new DeviceTokenError('Invalid token');
  }
  return trimmed;
}

function validatePlatform(platform) {
  if (typeof platform !== 'string' || !PLATFORMS.includes(platform.trim().toLowerCase())) {
    throw new DeviceTokenError('Invalid platform');
  }
  return platform.trim().toLowerCase();
}

// Registers (or refreshes) a device token for an authenticated owner.
// ownerId/studioId are ALWAYS derived from authentication, never from the client.
// Idempotent: re-registering the same token for the same owner updates lastSeenAt.
// Token takeover: if the token is currently registered to a DIFFERENT owner, it is
// reassigned to the caller (shared-device account switching) — the previous owner's
// row is updated, not duplicated (token is globally unique).
async function registerDeviceToken({ ownerType, ownerId, studioId, token, platform }) {
  const safeToken = validateToken(token);
  const safePlatform = validatePlatform(platform);
  if (ownerType !== 'staff' && ownerType !== 'member') {
    throw new DeviceTokenError('Invalid ownerType');
  }
  if (!Number.isInteger(Number(ownerId)) || Number(ownerId) <= 0) {
    throw new DeviceTokenError('Invalid ownerId');
  }
  // staff requires a studio; member is global (studioId must be null).
  const safeStudioId = ownerType === 'staff' ? Number(studioId) : null;
  if (ownerType === 'staff' && (!Number.isInteger(safeStudioId) || safeStudioId <= 0)) {
    throw new DeviceTokenError('Invalid studioId');
  }

  const now = new Date();
  const existing = await DeviceToken.findOne({ where: { token: safeToken } });
  if (existing) {
    // Same owner -> refresh lastSeenAt, clear any invalidation, update platform.
    // Different owner -> reassign to the caller (shared device / account switch).
    existing.ownerType = ownerType;
    existing.ownerId = Number(ownerId);
    existing.studioId = safeStudioId;
    existing.platform = safePlatform;
    existing.lastSeenAt = now;
    existing.invalidatedAt = null;
    await existing.save();
    return { deviceToken: existing, created: false, refreshed: true };
  }

  const deviceToken = await DeviceToken.create({
    ownerType,
    ownerId: Number(ownerId),
    studioId: safeStudioId,
    token: safeToken,
    platform: safePlatform,
    lastSeenAt: now,
    invalidatedAt: null,
  });
  return { deviceToken, created: true, refreshed: false };
}

// Unregisters a device token, but ONLY if the caller owns it. Returns whether a
// row was removed. Never removes another owner's token.
async function unregisterDeviceToken({ ownerType, ownerId, studioId, token }) {
  const safeToken = validateToken(token);
  if (ownerType !== 'staff' && ownerType !== 'member') {
    throw new DeviceTokenError('Invalid ownerType');
  }
  const safeStudioId = ownerType === 'staff' ? Number(studioId) : null;

  const existing = await DeviceToken.findOne({ where: { token: safeToken } });
  if (!existing) return { removed: false };

  const isOwner = existing.ownerType === ownerType
    && Number(existing.ownerId) === Number(ownerId)
    && (ownerType === 'member' || Number(existing.studioId) === Number(safeStudioId));
  if (!isOwner) {
    // Not the caller's token -> do not remove, do not reveal existence.
    return { removed: false };
  }

  await existing.destroy();
  return { removed: true };
}

module.exports = {
  DeviceTokenError,
  registerDeviceToken,
  unregisterDeviceToken,
};
