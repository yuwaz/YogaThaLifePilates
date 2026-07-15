const { LessonPackage } = require('../models');
const { withStudioWhere, getAuthenticatedStudioId } = require('../middleware/tenantContext');

exports.createLessonPackage = async (req, res) => {
  try {
    const { name, lessonCount, price } = req.body;
    if (!name || lessonCount == null || price == null) return res.status(400).json({ error: 'Missing required fields' });
    if (typeof name !== 'string' || isNaN(lessonCount) || isNaN(price)) return res.status(400).json({ error: 'Invalid field types' });
    if (Number(lessonCount) <= 0) return res.status(400).json({ error: 'lessonCount must be positive' });
    if (Number(price) < 0) return res.status(400).json({ error: 'price must be non-negative' });
    const lessonPackage = await LessonPackage.create({
      name,
      lessonCount,
      price,
      studioId: getAuthenticatedStudioId(req),
    });
    res.status(201).json(lessonPackage);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};

exports.getLessonPackages = async (req, res) => {
  const lessonPackages = await LessonPackage.findAll({ where: withStudioWhere(req, {}) });
  res.json(lessonPackages);
};

exports.getLessonPackage = async (req, res) => {
  const lessonPackage = await LessonPackage.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
  if (!lessonPackage) return res.sendStatus(404);
  res.json(lessonPackage);
};

exports.updateLessonPackage = async (req, res) => {
  try {
    const { name, lessonCount, price } = req.body;
    const lessonPackage = await LessonPackage.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!lessonPackage) return res.sendStatus(404);
    if (name) lessonPackage.name = name;
    if (lessonCount) lessonPackage.lessonCount = lessonCount;
    if (price) lessonPackage.price = price;
    await lessonPackage.save();
    res.json(lessonPackage);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};

exports.deleteLessonPackage = async (req, res) => {
  const lessonPackage = await LessonPackage.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
  if (!lessonPackage) return res.sendStatus(404);
  await lessonPackage.destroy();
  res.sendStatus(204);
};
