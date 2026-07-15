const { Op } = require('sequelize');
const { ManualCardUsage, MemberType } = require('../models');
const { withStudioWhere, getAuthenticatedStudioId } = require('../middleware/tenantContext');

function isValidDateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function validateCardBasedMemberType(req, memberTypeId) {
  const parsedId = Number(memberTypeId);
  if (!Number.isInteger(parsedId) || parsedId <= 0) {
    return { ok: false, status: 400, error: 'memberTypeId must be a positive integer' };
  }

  const memberType = await MemberType.findOne({ where: withStudioWhere(req, { id: parsedId }) });
  if (!memberType) {
    return { ok: false, status: 404, error: 'Not found' };
  }

  if (memberType.isCardBased !== true) {
    return { ok: false, status: 400, error: 'memberTypeId must reference a card-based member type' };
  }

  return { ok: true, memberTypeId: parsedId };
}

exports.getManualCardUsages = async (req, res) => {
  try {
    const { startDate, endDate, memberTypeId } = req.query;
    const where = withStudioWhere(req, {});

    if (startDate || endDate) {
      if (startDate && !isValidDateOnly(startDate)) {
        return res.status(400).json({ error: 'startDate must be YYYY-MM-DD' });
      }
      if (endDate && !isValidDateOnly(endDate)) {
        return res.status(400).json({ error: 'endDate must be YYYY-MM-DD' });
      }

      where.usageDate = {};
      if (startDate) where.usageDate[Op.gte] = startDate;
      if (endDate) where.usageDate[Op.lte] = endDate;
    }

    if (typeof memberTypeId !== 'undefined') {
      const parsedTypeId = Number(memberTypeId);
      if (!Number.isInteger(parsedTypeId) || parsedTypeId <= 0) {
        return res.status(400).json({ error: 'memberTypeId must be a positive integer' });
      }
      const memberTypeValidation = await validateCardBasedMemberType(req, parsedTypeId);
      if (!memberTypeValidation.ok) {
        return res.status(memberTypeValidation.status).json({ error: memberTypeValidation.error });
      }
      where.memberTypeId = parsedTypeId;
    }

    const rows = await ManualCardUsage.findAll({
      where,
      order: [['usageDate', 'DESC'], ['id', 'DESC']],
    });

    res.json(rows);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.createManualCardUsage = async (req, res) => {
  try {
    const { usageDate, memberTypeId, usageCount, note } = req.body;

    if (!usageDate) {
      return res.status(400).json({ error: 'usageDate is required' });
    }
    if (!isValidDateOnly(usageDate)) {
      return res.status(400).json({ error: 'usageDate must be YYYY-MM-DD' });
    }

    const memberTypeValidation = await validateCardBasedMemberType(req, memberTypeId);
    if (!memberTypeValidation.ok) {
      return res.status(memberTypeValidation.status).json({ error: memberTypeValidation.error });
    }

    const numericUsageCount = Number(usageCount);
    if (!Number.isInteger(numericUsageCount) || numericUsageCount <= 0) {
      return res.status(400).json({ error: 'usageCount must be a positive integer' });
    }

    const row = await ManualCardUsage.create({
      usageDate,
      memberTypeId: memberTypeValidation.memberTypeId,
      usageCount: numericUsageCount,
      note: typeof note === 'string' && note.trim() ? note.trim() : null,
      studioId: getAuthenticatedStudioId(req),
    });

    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.updateManualCardUsage = async (req, res) => {
  try {
    const row = await ManualCardUsage.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!row) return res.sendStatus(404);

    const { usageDate, memberTypeId, usageCount, note } = req.body;

    if (typeof usageDate !== 'undefined') {
      if (!isValidDateOnly(usageDate)) {
        return res.status(400).json({ error: 'usageDate must be YYYY-MM-DD' });
      }
      row.usageDate = usageDate;
    }

    if (typeof memberTypeId !== 'undefined') {
      const memberTypeValidation = await validateCardBasedMemberType(req, memberTypeId);
      if (!memberTypeValidation.ok) {
        return res.status(memberTypeValidation.status).json({ error: memberTypeValidation.error });
      }
      row.memberTypeId = memberTypeValidation.memberTypeId;
    }

    if (typeof usageCount !== 'undefined') {
      const numericUsageCount = Number(usageCount);
      if (!Number.isInteger(numericUsageCount) || numericUsageCount <= 0) {
        return res.status(400).json({ error: 'usageCount must be a positive integer' });
      }
      row.usageCount = numericUsageCount;
    }

    if (typeof note !== 'undefined') {
      row.note = typeof note === 'string' && note.trim() ? note.trim() : null;
    }

    await row.save();
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteManualCardUsage = async (req, res) => {
  try {
    const row = await ManualCardUsage.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!row) return res.sendStatus(404);
    await row.destroy();
    res.sendStatus(204);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
