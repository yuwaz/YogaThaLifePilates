const { DataTypes } = require('sequelize');
const {
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUSES,
} = require('./studioMetadata');

module.exports = (sequelize) => {
  const StudioManualSubscriptionOverride = sequelize.define('StudioManualSubscriptionOverride', {
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
    subscriptionPlan: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [SUBSCRIPTION_PLANS],
      },
    },
    subscriptionStatus: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [SUBSCRIPTION_STATUSES],
      },
    },
    effectiveFrom: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: false,
      validate: {
        notEmpty: true,
      },
    },
    createdByPlatformAdminId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'PlatformAdmins',
        key: 'id',
      },
    },
    previousSubscriptionPlan: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: {
        isIn: [SUBSCRIPTION_PLANS],
      },
    },
    previousSubscriptionStatus: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: {
        isIn: [SUBSCRIPTION_STATUSES],
      },
    },
    previousTrialEndsAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    revokedByPlatformAdminId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'PlatformAdmins',
        key: 'id',
      },
    },
    revokeReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  }, {
    indexes: [
      {
        name: 'studio_manual_subscription_overrides_studio_id_idx',
        fields: ['studioId'],
      },
      {
        name: 'studio_manual_subscription_overrides_created_by_idx',
        fields: ['createdByPlatformAdminId'],
      },
      {
        name: 'studio_manual_subscription_overrides_revoked_by_idx',
        fields: ['revokedByPlatformAdminId'],
      },
      {
        name: 'studio_manual_subscription_overrides_effective_from_idx',
        fields: ['effectiveFrom'],
      },
      {
        name: 'studio_manual_subscription_overrides_expires_at_idx',
        fields: ['expiresAt'],
      },
      {
        name: 'studio_manual_subscription_overrides_one_active_per_studio_unique',
        unique: true,
        fields: ['studioId'],
        where: {
          revokedAt: null,
        },
      },
    ],
    validate: {
      expiresAfterEffectiveFrom() {
        if (this.expiresAt && this.effectiveFrom && new Date(this.expiresAt).getTime() <= new Date(this.effectiveFrom).getTime()) {
          throw new Error('expiresAt must be after effectiveFrom');
        }
      },
    },
  });

  return StudioManualSubscriptionOverride;
};