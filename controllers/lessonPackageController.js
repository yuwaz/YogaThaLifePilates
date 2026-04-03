const { LessonPackage } = require('../models');

exports.createLessonPackage = async (req, res) => {
  try {
    const { name, lessonCount, price } = req.body;
    const lessonPackage = await LessonPackage.create({ name, lessonCount, price });
    res.status(201).json(lessonPackage);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getLessonPackages = async (req, res) => {
  const lessonPackages = await LessonPackage.findAll();
  res.json(lessonPackages);
};

exports.getLessonPackage = async (req, res) => {
  const lessonPackage = await LessonPackage.findByPk(req.params.id);
  if (!lessonPackage) return res.sendStatus(404);
  res.json(lessonPackage);
};

exports.updateLessonPackage = async (req, res) => {
  try {
    const { name, lessonCount, price } = req.body;
    const lessonPackage = await LessonPackage.findByPk(req.params.id);
    if (!lessonPackage) return res.sendStatus(404);
    if (name) lessonPackage.name = name;
    if (lessonCount) lessonPackage.lessonCount = lessonCount;
    if (price) lessonPackage.price = price;
    await lessonPackage.save();
    res.json(lessonPackage);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteLessonPackage = async (req, res) => {
  const lessonPackage = await LessonPackage.findByPk(req.params.id);
  if (!lessonPackage) return res.sendStatus(404);
  await lessonPackage.destroy();
  res.sendStatus(204);
};
