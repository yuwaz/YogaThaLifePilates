const bcrypt = require('bcrypt');
const { sequelize, Studio, User } = require('../models');
const { buildAuthPayload, signAuthToken } = require('../utils/authToken');

exports.registerStudio = async (req, res) => {
  const requiredFields = [
    'studioName',
    'country',
    'currency',
    'timezone',
    'adminUsername',
    'adminPassword',
  ];

  for (const field of requiredFields) {
    const value = req.body ? req.body[field] : undefined;
    if (typeof value !== 'string') {
      return res.status(400).json({ error: `Missing required fields: ${field}` });
    }

    if (value.trim() === '') {
      return res.status(400).json({ error: `Missing required fields: ${field}` });
    }
  }

  const studioName = req.body.studioName.trim();
  const country = req.body.country.trim();
  const currency = req.body.currency.trim();
  const timezone = req.body.timezone.trim();
  const adminUsername = req.body.adminUsername.trim();
  const adminPassword = req.body.adminPassword;

  const phone = typeof req.body.phone === 'string' && req.body.phone.trim() !== ''
    ? req.body.phone.trim()
    : null;
  const email = typeof req.body.email === 'string' && req.body.email.trim() !== ''
    ? req.body.email.trim()
    : null;

  let createdStudio;
  let createdUser;

  try {
    await sequelize.transaction(async (t) => {
      const now = new Date();
      const trialEndsAt = new Date(now);
      trialEndsAt.setUTCDate(trialEndsAt.getUTCDate() + 7);

      createdStudio = await Studio.create({
        name: studioName,
        country,
        currency,
        timezone,
        phone,
        email,
        subscriptionStatus: 'trial',
        trialEndsAt,
      }, { transaction: t });

      const hashedPassword = await bcrypt.hash(adminPassword, 10);

      createdUser = await User.create({
        username: adminUsername,
        password: hashedPassword,
        role: 'admin',
        assignedSalonIds: [],
        permissions: [],
        groupSessionFee: 0,
        individualSessionFee: 0,
        studioId: createdStudio.id,
      }, { transaction: t });
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'Validation error' });
    }
    return res.status(500).json({ error: 'Server error' });
  }

  try {
    const payload = buildAuthPayload(createdUser);
    const token = signAuthToken(payload);

    return res.status(201).json({
      message: 'Studio registered successfully',
      token,
      user: {
        id: createdUser.id,
        username: createdUser.username,
        role: payload.role,
        assignedSalonIds: payload.assignedSalonIds,
        permissions: payload.permissions,
        studioId: payload.studioId,
      },
      studio: {
        id: createdStudio.id,
        name: createdStudio.name,
        country: createdStudio.country,
        currency: createdStudio.currency,
        timezone: createdStudio.timezone,
        subscriptionStatus: createdStudio.subscriptionStatus,
        trialEndsAt: createdStudio.trialEndsAt,
        onboardingCompleted: Boolean(createdStudio.onboardingCompleted),
        onboardingStep: createdStudio.onboardingStep,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
};
