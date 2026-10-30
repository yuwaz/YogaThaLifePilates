const { DataTypes } = require('sequelize');

const RECIPIENT_TYPES = Object.freeze(['member', 'instructor', 'admin']);

module.exports = (sequelize) => {
  const Notification = sequelize.define('Notification', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    studioId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'Studios', key: 'id' },
    },
    recipientType: {
      type: DataTypes.STRING(16),
      allowNull: false,
      validate: { isIn: [RECIPIENT_TYPES] },
    },
    // member -> MemberAccount.id; instructor/admin -> User.id
    recipientId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // Durable delivery key for crash-safe idempotency: uniquely identifies the
    // inbox row a job produced, so a crash between INSERT and job completion
    // cannot create a duplicate on retry.
    deliveryKey: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  }, {
    indexes: [
      {
        name: 'notifications_recipient_read_idx',
        fields: ['studioId', 'recipientType', 'recipientId', 'readAt'],
      },
      {
        name: 'notifications_delivery_key_unique',
        unique: true,
        fields: ['studioId', 'deliveryKey'],
      },
    ],
  });
  return Notification;
};

module.exports.RECIPIENT_TYPES = RECIPIENT_TYPES;
