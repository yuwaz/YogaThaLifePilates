const { Op } = require('sequelize');
const { Member, MemberType, Reservation, Payment, LessonPackage, Salon, Equipment } = require('../models');

exports.getReports = async (req, res) => {
  try {
    const { mode = 'daily', startDate, endDate, salonId } = req.query;
    const dateFilter = {};
    if (startDate) dateFilter[Op.gte] = startDate;
    if (endDate) dateFilter[Op.lte] = endDate;
    // Salon filter
    let salonIds = [];
    if (salonId) {
      salonIds = [Number(salonId)];
    } else {
      const salons = await Salon.findAll({ attributes: ['id'] });
      salonIds = salons.map(s => s.id);
    }
    // Member filter
    const memberWhere = salonId
      ? { assignedSalonIds: { [Op.contains]: [Number(salonId)] } }
      : {};
    const members = await Member.findAll({ where: memberWhere });
    const memberIds = members.map(m => m.id);
    // MemberType breakdown
    const memberTypes = await MemberType.findAll();
    const memberTypeMap = {};
    memberTypes.forEach(mt => { memberTypeMap[mt.id] = mt; });
    const memberTypeBreakdown = memberTypes.map(mt => ({
      memberTypeId: mt.id,
      memberTypeName: mt.name,
      memberTypeColor: mt.color,
      memberCount: members.filter(m => m.memberTypeId === mt.id).length
    }));
    // Payments
    const payments = await Payment.findAll({
      where: {
        memberId: memberIds.length ? { [Op.in]: memberIds } : undefined,
        date: dateFilter
      }
    });
    const receivedPayments = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const pendingPayments = members.reduce((sum, m) => sum + Number(m.totalDebt || 0), 0);
    const totalDebt = members.reduce((sum, m) => sum + Number(m.totalDebt || 0), 0);
    // Package sales (approximate by lesson packages assigned to members)
    const lessonPackages = await LessonPackage.findAll();
    // Assume each member has a lessonPackageId and lessonCount field
    let soldPackageCount = 0, soldLessonCount = 0, soldLessonHours = 0, packageBreakdown = [];
    for (const lp of lessonPackages) {
      const assignedMembers = members.filter(m => m.lessonPackageId === lp.id);
      const lessonCount = assignedMembers.reduce((sum, m) => sum + (m.lessonCount || 0), 0);
      const revenue = assignedMembers.length * Number(lp.price || 0);
      soldPackageCount += assignedMembers.length;
      soldLessonCount += lessonCount;
      soldLessonHours += lessonCount; // 1 hour per lesson
      packageBreakdown.push({
        lessonPackageId: lp.id,
        lessonPackageName: lp.name,
        packageCount: assignedMembers.length,
        lessonCount,
        lessonHours: lessonCount,
        revenue
      });
    }
    // Occupancy
    const reservationWhere = {
      date: dateFilter,
      salonId: salonIds.length ? { [Op.in]: salonIds } : undefined
    };
    const reservations = await Reservation.findAll({ where: reservationWhere });
    const occupiedSlots = reservations.length;
    // Equipment count for salons
    const equipments = await Equipment.findAll({ where: { salonId: salonIds.length ? { [Op.in]: salonIds } : undefined } });
    const equipmentCount = equipments.length;
    // Slot calculation
    const slotCountPerDay = equipmentCount * 15; // 07:00-21:00
    // Date range calculation
    const start = new Date(startDate);
    const end = new Date(endDate);
    const dayCount = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
    const totalSlots = slotCountPerDay * dayCount;
    const occupancyRate = totalSlots > 0 ? (occupiedSlots / totalSlots) * 100 : 0;
    // Occupancy breakdown
    let occupancyBreakdown = [];
    if (mode === 'daily') {
      for (let hour = 7; hour < 22; hour++) {
        const label = hour.toString().padStart(2, '0') + ':00';
        const occ = reservations.filter(r => Number(r.time.split(':')[0]) === hour).length;
        occupancyBreakdown.push({
          label,
          occupiedSlots: occ,
          totalSlots: equipmentCount,
          occupancyRate: equipmentCount > 0 ? (occ / equipmentCount) * 100 : 0
        });
      }
    } else {
      for (let d = 0; d < dayCount; d++) {
        const date = new Date(start);
        date.setDate(start.getDate() + d);
        const dateStr = date.toISOString().slice(0, 10);
        const occ = reservations.filter(r => r.date === dateStr).length;
        occupancyBreakdown.push({
          label: dateStr,
          occupiedSlots: occ,
          totalSlots: slotCountPerDay,
          occupancyRate: slotCountPerDay > 0 ? (occ / slotCountPerDay) * 100 : 0
        });
      }
    }
    // Response
    res.json({
      summary: {
        memberCount: members.length,
        receivedPayments,
        pendingPayments,
        totalDebt,
        soldPackageCount,
        soldLessonCount,
        soldLessonHours,
        occupiedSlots,
        totalSlots,
        occupancyRate
      },
      memberTypeBreakdown,
      packageBreakdown,
      paymentBreakdown: {
        received: receivedPayments,
        pending: pendingPayments,
        totalDebt
      },
      occupancyBreakdown
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
