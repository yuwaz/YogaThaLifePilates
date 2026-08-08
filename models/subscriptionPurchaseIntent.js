const { DataTypes } = require('sequelize');
const {
  SUBSCRIPTION_PROVIDERS,
  PURCHASE_INTENT_STATUSES,
  PURCHASE_INTENT_TARGET_PLANS,
} = require('./subscriptionInfrastructureMetadata');

module.exports = (sequelize) => {
  const SubscriptionPurchaseIntent = sequelize.define('SubscriptionPurchaseIntent', {
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
    provider: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [SUBSCRIPTION_PROVIDERS],
      },
    },
    targetPlan: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [PURCHASE_INTENT_TARGET_PLANS],
      },
    },
    appAccountToken: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    googleObfuscatedAccountId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    googleObfuscatedProfileId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'created',
      validate: {
        isIn: [PURCHASE_INTENT_STATUSES],
      },
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    consumedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdByUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    metadataJson: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  });

  return SubscriptionPurchaseIntent;
};