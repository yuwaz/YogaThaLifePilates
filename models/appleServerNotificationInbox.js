const { DataTypes } = require('sequelize');
const {
  APPLE_ENVIRONMENTS,
  APPLE_NOTIFICATION_PROCESSING_STATES,
} = require('./appleSubscriptionMetadata');

module.exports = (sequelize) => {
  const AppleServerNotificationInbox = sequelize.define(
    'AppleServerNotificationInbox',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      environment: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
          isIn: [APPLE_ENVIRONMENTS],
        },
      },
      notificationUUID: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      notificationType: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      notificationSubtype: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      signedPayload: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      originalTransactionId: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      transactionId: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      eventTime: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      processingState: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'pending',
        validate: {
          isIn: [APPLE_NOTIFICATION_PROCESSING_STATES],
        },
      },
      processedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      lastError: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      attemptCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      nextAttemptAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'apple_server_notification_inbox',
    }
  );

  return AppleServerNotificationInbox;
};