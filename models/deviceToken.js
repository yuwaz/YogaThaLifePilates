const { DataTypes } = require('sequelize');

const OWNER_TYPES = Object.freeze(['staff', 'member']);
const PLATFORMS = Object.freeze(['ios', 'android', 'web']);

module.exports = (sequelize) => {
  const DeviceToken = sequelize.define('DeviceToken', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    ownerType: {
      type: DataTypes.STRING(16),
      allowNull: false,
      validate: { isIn: [OWNER_TYPES] },
    },
    // staff -> User.id; member -> MemberAccount.id
    ownerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // Required for staff (studio-scoped), NULL for member (global account).
    studioId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'Studios', key: 'id' },
    },
    token: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    platform: {
      type: DataTypes.STRING(16),
      allowNull: false,
      validate: { isIn: [PLATFORMS] },
    },
    lastSeenAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    invalidatedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  }, {
    indexes: [
      {
        name: 'device_tokens_token_unique',
        unique: true,
        fields: ['token'],
      },
      {
        name: 'device_tokens_owner_idx',
        fields: ['ownerType', 'ownerId'],
      },
      {
        name: 'device_tokens_studio_idx',
        fields: ['studioId'],
      },
    ],
  });
  return DeviceToken;
};

module.exports.OWNER_TYPES = OWNER_TYPES;
module.exports.PLATFORMS = PLATFORMS;
