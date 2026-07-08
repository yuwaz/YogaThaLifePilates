const { MemberType, Member } = require('../models');

exports.createMemberType = async (req, res) => {
  try {
    const { name, color, isCardBased = false, cardUsageFee = 0 } = req.body;
    if (!name || !color) return res.status(400).json({ error: 'Missing required fields' });
    if (typeof name !== 'string' || typeof color !== 'string') return res.status(400).json({ error: 'Invalid field types' });
    if (isCardBased) {
      if (cardUsageFee === undefined || isNaN(Number(cardUsageFee)) || Number(cardUsageFee) < 0) {
        return res.status(400).json({ error: 'cardUsageFee must be >= 0 for card-based member types' });
      }
    }
    const memberType = await MemberType.create({
      name,
      color,
      isCardBased: !!isCardBased,
      cardUsageFee: isCardBased ? Number(cardUsageFee) : 0,
    });
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
    const { name, color, isCardBased, cardUsageFee } = req.body;
    const memberType = await MemberType.findByPk(req.params.id);
    if (!memberType) return res.sendStatus(404);
    if (name) memberType.name = name;
    if (color) memberType.color = color;
    if (typeof isCardBased !== 'undefined') memberType.isCardBased = !!isCardBased;
    if (typeof cardUsageFee !== 'undefined') {
      if (memberType.isCardBased && (isNaN(Number(cardUsageFee)) || Number(cardUsageFee) < 0)) {
        return res.status(400).json({ error: 'cardUsageFee must be >= 0 for card-based member types' });
      }
      memberType.cardUsageFee = memberType.isCardBased ? Number(cardUsageFee) : 0;
    }
    await memberType.save();
    res.json(memberType);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteMemberType = async (req, res) => {
  const memberType = await MemberType.findByPk(req.params.id);
  if (!memberType) return res.sendStatus(404);

  const memberCount = await Member.count({ where: { memberTypeId: memberType.id } });
  if (memberCount > 0) {
    return res.status(400).json({
      error: 'This member type cannot be deleted because it is currently assigned to one or more members.',
    });
  }

  await memberType.destroy();
  res.sendStatus(204);
};
