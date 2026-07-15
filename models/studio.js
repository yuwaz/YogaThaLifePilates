const { DataTypes } = require('sequelize');
const {
  SUPPORTED_COUNTRY_CODES,
  SUPPORTED_CURRENCIES,
  ONBOARDING_STEPS,
  SUBSCRIPTION_STATUSES,
  normalizeUppercaseCode,
  isSupportedCountryCode,
  isValidIanaTimezone,
} = require('./studioMetadata');

module.exports = (sequelize) => {
  const Studio = sequelize.define('Studio', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: {
        isEmail: true,
      },
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    country: {
      type: DataTypes.STRING(2),
      allowNull: false,
      set(value) {
        this.setDataValue('country', normalizeUppercaseCode(value));
      },
      validate: {
        is: /^[A-Z]{2}$/,
        isIn: [SUPPORTED_COUNTRY_CODES],
        isSupportedCountryCode(value) {
          if (!isSupportedCountryCode(value)) {
            throw new Error('Unsupported country code');
          }
        },
      },
    },
    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      set(value) {
        this.setDataValue('currency', normalizeUppercaseCode(value));
      },
      validate: {
        isIn: [SUPPORTED_CURRENCIES],
      },
    },
    timezone: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isValidIanaTimezone(value) {
          if (!isValidIanaTimezone(value)) {
            throw new Error('Invalid IANA timezone');
          }
        },
      },
    },
    subscriptionStatus: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'trial',
      validate: {
        isIn: [SUBSCRIPTION_STATUSES],
      },
    },
    trialEndsAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    onboardingCompleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    onboardingStep: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'studio',
      validate: {
        isIn: [ONBOARDING_STEPS],
      },
    },
  });

  return Studio;
};