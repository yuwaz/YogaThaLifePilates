const { DataTypes } = require('sequelize');

const JOB_STATES = Object.freeze(['pending', 'processing', 'done', 'failed']);

module.exports = (sequelize) => {
  const NotificationJob = sequelize.define('NotificationJob', {
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
    type: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    dedupKey: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    scheduledAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    processingState: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'pending',
      validate: { isIn: [JOB_STATES] },
    },
    attemptCount: {
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
    processedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // Links to the created inbox notification so a crash after insertion but
    // before job completion can reuse it on retry instead of duplicating.
    notificationId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    lastError: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  }, {
    indexes: [
      {
        name: 'notification_jobs_dedup_unique',
        unique: true,
        fields: ['studioId', 'dedupKey'],
      },
      {
        name: 'notification_jobs_due_idx',
        fields: ['processingState', 'nextAttemptAt'],
      },
    ],
  });
  return NotificationJob;
};

module.exports.JOB_STATES = JOB_STATES;
