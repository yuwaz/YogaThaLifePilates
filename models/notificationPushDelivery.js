const { DataTypes } = require('sequelize');

const DELIVERY_STATES = Object.freeze(['pending', 'processing', 'sent', 'failed']);

module.exports = (sequelize) => {
  const NotificationPushDelivery = sequelize.define('NotificationPushDelivery', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    notificationId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'Notifications', key: 'id' },
    },
    deviceTokenId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'DeviceTokens', key: 'id' },
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'pending',
      validate: { isIn: [DELIVERY_STATES] },
    },
    attempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    maxAttempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 5,
    },
    nextAttemptAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    lastError: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    sentAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  }, {
    indexes: [
      {
        name: 'push_deliveries_notification_device_unique',
        unique: true,
        fields: ['notificationId', 'deviceTokenId'],
      },
      {
        name: 'push_deliveries_due_idx',
        fields: ['status', 'nextAttemptAt'],
      },
    ],
  });
  return NotificationPushDelivery;
};

module.exports.DELIVERY_STATES = DELIVERY_STATES;
