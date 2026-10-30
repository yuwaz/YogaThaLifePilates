const { StudioNotificationSettings } = require('../models');
const { getAuthenticatedStudioId } = require('../middleware/tenantContext');
const { getStudioLocalDate } = require('../services/instructorFeeHistoryService');
const { SETTINGS_DEFAULTS } = require('../services/notificationService');

const EDITABLE_FIELDS = [
  'quietHoursStart',
  'quietHoursEnd',
  'classReminderEnabled',
  'packageAlertsEnabled',
  'paymentAlertsEnabled',
  'inactivityAlertsEnabled',
  'memberReminderMinutes',
  'instructorReminderMinutes',
  'lowLessonsThreshold',
  'packageExpiryDays',
  'inactivityDays',
];

const INTEGER_RANGES = {
  memberReminderMinutes: [0, 1440],
  instructorReminderMinutes: [0, 1440],
  lowLessonsThreshold: [0, 100],
  packageExpiryDays: [1, 90],
  inactivityDays: [1, 365],
};

function validateTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

function settingsPayload(s) {
  return {
    quietHoursStart: s.quietHoursStart,
    quietHoursEnd: s.quietHoursEnd,
    classReminderEnabled: s.classReminderEnabled,
    packageAlertsEnabled: s.packageAlertsEnabled,
    paymentAlertsEnabled: s.paymentAlertsEnabled,
    inactivityAlertsEnabled: s.inactivityAlertsEnabled,
    paymentRemindersActivatedAt: s.paymentRemindersActivatedAt || null,
    memberReminderMinutes: Number(s.memberReminderMinutes),
    instructorReminderMinutes: Number(s.instructorReminderMinutes),
    lowLessonsThreshold: Number(s.lowLessonsThreshold),
    packageExpiryDays: Number(s.packageExpiryDays),
    inactivityDays: Number(s.inactivityDays),
  };
}

async function getOrCreateSettings(studioId) {
  let settings = await StudioNotificationSettings.findOne({ where: { studioId } });
  if (!settings) {
    settings = await StudioNotificationSettings.create({ studioId });
  }
  return settings;
}

exports.getSettings = async (req, res) => {
  try {
    const settings = await getOrCreateSettings(getAuthenticatedStudioId(req));
    res.json(settingsPayload(settings));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const studioId = getAuthenticatedStudioId(req);
    const settings = await getOrCreateSettings(studioId);
    const body = req.body || {};

    for (const field of EDITABLE_FIELDS) {
      if (body[field] === undefined) continue;
      const value = body[field];

      if (field === 'quietHoursStart' || field === 'quietHoursEnd') {
        if (!validateTime(value)) {
          return res.status(400).json({ error: `${field} must be HH:MM (24h)` });
        }
        settings[field] = value.trim();
      } else if (field.endsWith('Enabled')) {
        if (typeof value !== 'boolean') {
          return res.status(400).json({ error: `${field} must be a boolean` });
        }
        settings[field] = value;
      } else if (INTEGER_RANGES[field]) {
        const num = Number(value);
        const [min, max] = INTEGER_RANGES[field];
        if (!Number.isInteger(num) || num < min || num > max) {
          return res.status(400).json({ error: `${field} must be an integer between ${min} and ${max}` });
        }
        settings[field] = num;
      }
    }

    // Payment activation: on first explicit enablement, set the activation
    // boundary to the studio's current local date. Never backdate; never reset
    // on disable/re-enable (preserves the boundary, no retroactive reminders).
    if (body.paymentAlertsEnabled === true && !settings.paymentRemindersActivatedAt) {
      settings.paymentRemindersActivatedAt = await getStudioLocalDate(studioId);
    }

    await settings.save();
    res.json(settingsPayload(settings));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};
