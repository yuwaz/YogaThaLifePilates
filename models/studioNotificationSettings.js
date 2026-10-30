const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const StudioNotificationSettings = sequelize.define('StudioNotificationSettings', {
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
    quietHoursStart: {
      type: DataTypes.STRING(5),
      allowNull: false,
      defaultValue: '21:00',
      validate: { is: /^\d{2}:\d{2}$/ },
    },
    quietHoursEnd: {
      type: DataTypes.STRING(5),
      allowNull: false,
      defaultValue: '09:00',
      validate: { is: /^\d{2}:\d{2}$/ },
    },
    classReminderEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    packageAlertsEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    paymentAlertsEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    inactivityAlertsEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    // Activation boundary: only package assignments on/after this date start
    // payment reminder cycles. NULL = not yet activated (no payment reminders).
    // Set once when payment notifications are enabled for the studio.
    paymentRemindersActivatedAt: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    // Configurable thresholds (defaults preserve existing hardcoded behavior).
    memberReminderMinutes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 120,
      validate: { min: 0, max: 1440 },
    },
    instructorReminderMinutes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 60,
      validate: { min: 0, max: 1440 },
    },
    lowLessonsThreshold: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 2,
      validate: { min: 0, max: 100 },
    },
    packageExpiryDays: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 7,
      validate: { min: 1, max: 90 },
    },
    inactivityDays: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 14,
      validate: { min: 1, max: 365 },
    },
  }, {
    indexes: [
      {
        name: 'studio_notification_settings_studio_unique',
        unique: true,
        fields: ['studioId'],
      },
    ],
  });
  return StudioNotificationSettings;
};
