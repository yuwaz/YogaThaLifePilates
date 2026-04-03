const { MemberType } = require('../models');

exports.createMemberType = async (req, res) => {
  try {
    const { name, color } = req.body;
    const memberType = await MemberType.create({ name, color });
    res.status(201).json(memberType);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getMemberTypes = async (req, res) => {
  const memberTypes = await MemberType.findAll();
  res.json(memberTypes);
};

exports.getMemberType = async (req, res) => {
  const memberType = await MemberType.findByPk(req.params.id);
  if (!memberType) return res.sendStatus(404);
  res.json(memberType);
};

exports.updateMemberType = async (req, res) => {
  try {
    const { name, color } = req.body;
    const memberType = await MemberType.findByPk(req.params.id);
    if (!memberType) return res.sendStatus(404);
    if (name) memberType.name = name;
    if (color) memberType.color = color;
    await memberType.save();
    res.json(memberType);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteMemberType = async (req, res) => {
  const memberType = await MemberType.findByPk(req.params.id);
  if (!memberType) return res.sendStatus(404);
  await memberType.destroy();
  res.sendStatus(204);
};
