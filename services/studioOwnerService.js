const { Studio } = require('../models');

// Resolves the stable owner User id for a Studio, or null if unset (legacy Studios stay null; never guessed).
async function getStudioOwnerUserId(studioId) {
  const studio = await Studio.findByPk(studioId, { attributes: ['id', 'ownerUserId'] });
  return studio && Number.isInteger(studio.ownerUserId) ? studio.ownerUserId : null;
}

module.exports = { getStudioOwnerUserId };
