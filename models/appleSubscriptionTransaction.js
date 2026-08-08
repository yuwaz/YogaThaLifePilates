const { DataTypes } = require('sequelize');
const { APPLE_ENVIRONMENTS } = require('./appleSubscriptionMetadata');

module.exports = (sequelize) => {
  const AppleSubscriptionTransaction = sequelize.define(
    'AppleSubscriptionTransaction',
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
          isIn: [APPLE_ENVIRONMENTS],
        },
      },
      originalTransactionId: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      transactionId: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      productId: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      subscriptionGroupIdentifier: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      purchaseDate: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      originalPurchaseDate: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      expiresDate: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      revocationDate: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      autoRenewStatus: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
      },
      signedTransactionInfo: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      signedRenewalInfo: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      appAccountToken: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      notificationType: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      notificationSubtype: {
        type: DataTypes.STRING,
        allowNull: true,
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
      tableName: 'apple_subscription_transactions',
    }
  );

  return AppleSubscriptionTransaction;
};