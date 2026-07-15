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

  return res.status(501).json({ error: 'Studio registration is not implemented yet' });
};
