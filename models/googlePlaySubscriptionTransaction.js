const { DataTypes } = require('sequelize');
const {
  GOOGLE_PLAY_ENVIRONMENTS,
} = require('./googlePlaySubscriptionMetadata');

module.exports = (sequelize) => {
  const GooglePlaySubscriptionTransaction = sequelize.define(
    'GooglePlaySubscriptionTransaction',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      studioId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Studios',
          key: 'id',
        },
      },
      environment: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
          isIn: [GOOGLE_PLAY_ENVIRONMENTS],
        },
      },
      packageName: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      productId: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      basePlanId: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      offerId: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      purchaseToken: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      linkedPurchaseToken: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      latestSuccessfulOrderId: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      subscriptionState: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      acknowledgementState: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      autoRenewEnabled: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
      },
      startTime: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      expiryTime: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      cancelSurveyResultJson: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      cancellationContextJson: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      testPurchaseFlag: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
      },
      externalAccountIdentifier: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      rawApiResponseJson: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      providerEventTime: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      ingestedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'google_play_subscription_transactions',
    }
  );

  return GooglePlaySubscriptionTransaction;
};
