const { DataTypes } = require('sequelize');
const {
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_ENVIRONMENTS,
  NORMALIZED_SUBSCRIPTION_STATUSES,
  PROVIDER_BACKED_SUBSCRIPTION_PLANS,
  ENTITLEMENT_UPDATE_SOURCES,
} = require('./subscriptionInfrastructureMetadata');

module.exports = (sequelize) => {
  const StudioSubscriptionEntitlement = sequelize.define('StudioSubscriptionEntitlement', {
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
    plan: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [PROVIDER_BACKED_SUBSCRIPTION_PLANS],
      },
    },
    normalizedStatus: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [NORMALIZED_SUBSCRIPTION_STATUSES],
      },
    },
    providerProductId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    providerSubscriptionId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    currentPeriodStart: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    currentPeriodEnd: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    trialEndsAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    autoRenewEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    gracePeriodEndsAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    refundedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    pausedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    lastVerifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    sourceLastUpdate: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [ENTITLEMENT_UPDATE_SOURCES],
      },
    },
    environment: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [SUBSCRIPTION_ENVIRONMENTS],
      },
    },
    providerStateVersion: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    providerEventTime: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  });

  return StudioSubscriptionEntitlement;
};