const { DataTypes } = require('sequelize');
const {
  GOOGLE_PLAY_NOTIFICATION_INBOX_ENVIRONMENTS,
  GOOGLE_PLAY_NOTIFICATION_PROCESSING_STATES,
} = require('./googlePlaySubscriptionMetadata');

module.exports = (sequelize) => {
  const GooglePubSubNotificationInbox = sequelize.define(
    'GooglePubSubNotificationInbox',
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
          isIn: [GOOGLE_PLAY_NOTIFICATION_INBOX_ENVIRONMENTS],
        },
      },
      pubsubMessageId: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      publishTime: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      packageName: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      purchaseToken: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      subscriptionNotificationType: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      oneTimeProductNotificationType: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      testNotificationFlag: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
      },
      rawPayloadJson: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      processingState: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'pending',
        validate: {
          isIn: [GOOGLE_PLAY_NOTIFICATION_PROCESSING_STATES],
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
      tableName: 'google_pubsub_notification_inbox',
    }
  );

  return GooglePubSubNotificationInbox;
};
