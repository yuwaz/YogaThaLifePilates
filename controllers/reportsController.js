const { Op } = require('sequelize');
const { Member, MemberType, Reservation, Payment, LessonPackage, Salon, Equipment, Attendance } = require('../models');

exports.getReports = async (req, res) => {
  try {
    const { mode = 'daily', startDate, endDate, salonId } = req.query;
    const dateFilter = {};
    if (startDate) dateFilter[Op.gte] = startDate;
    if (endDate) dateFilter[Op.lte] = endDate;
    // Salon filter (SQLite-safe)
    let salonIds = [];
    let members = [];
    if (salonId !== undefined && salonId !== null) {
      const salonIdNum = Number(salonId);
      if (isNaN(salonIdNum)) {
        return res.status(400).json({ error: 'Geçersiz salon filtresi.' });
      }
      salonIds = [salonIdNum];
      // Fetch all active members, then filter in JS
      members = await Member.findAll({ where: { isActive: true } });
      members = members.filter(m => Array.isArray(m.assignedSalonIds) && m.assignedSalonIds.includes(salonIdNum));
    } else {
      // No salon filter, use all active members
      members = await Member.findAll({ where: { isActive: true } });
      const salons = await Salon.findAll({ attributes: ['id'] });
      salonIds = salons.map(s => s.id);
    }
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
    // Card-based attendance revenue summary (safe, will not break reports)
    let totalCardBasedAttendanceCount = 0;
    let totalCardBasedRevenue = 0;
    let cardBasedSummary = [];
    // --- New: Attendance metrics ---
    let totalAttendanceCount = 0;
    let instructorAttendanceBreakdown = [];
    try {
      const cardBasedMemberTypes = memberTypes.filter(mt => mt.isCardBased === true);
      const cardBasedMemberTypeIds = cardBasedMemberTypes.map(mt => mt.id);
      let attendanceWhere = { date: dateFilter };
      if (memberIds.length) attendanceWhere.memberId = { [Op.in]: memberIds };
      const attendances = await Attendance.findAll({ where: attendanceWhere });
      totalAttendanceCount = attendances.length;
      // Instructor breakdown (by member.assignedInstructorId)
      const instructorMap = {};
      for (const a of attendances) {
        const member = members.find(m => m.id === a.memberId);
        const instructorId = member ? member.assignedInstructorId : null;
        if (instructorId) {
          if (!instructorMap[instructorId]) {
            instructorMap[instructorId] = { instructorId, instructorName: null, attendanceCount: 0 };
          }
          instructorMap[instructorId].attendanceCount++;
        }
      }
      // Fill instructor names
      for (const key in instructorMap) {
        const instructor = await Member.findByPk(instructorMap[key].instructorId);
        instructorMap[key].instructorName = instructor ? instructor.name : '';
      }
      instructorAttendanceBreakdown = Object.values(instructorMap);
      // Card-based summary (existing logic)
      const memberIdToType = {};
      members.forEach(m => { memberIdToType[m.id] = m.memberTypeId; });
      const cardBasedAttendances = attendances.filter(a => cardBasedMemberTypeIds.includes(memberIdToType[a.memberId]));
      const cardBasedSummaryMap = {};
      cardBasedAttendances.forEach(a => {
        const mtId = memberIdToType[a.memberId];
        if (!cardBasedSummaryMap[mtId]) {
          cardBasedSummaryMap[mtId] = { attendanceCount: 0 };
        }
        cardBasedSummaryMap[mtId].attendanceCount++;
      });
      cardBasedSummary = cardBasedMemberTypes.map(mt => {
        const attendanceCount = cardBasedSummaryMap[mt.id]?.attendanceCount || 0;
        const cardUsageFee = Number(mt.cardUsageFee || 0);
        return {
          memberTypeId: mt.id,
          memberTypeName: mt.name,
          attendanceCount,
          cardUsageFee,
          revenue: attendanceCount * cardUsageFee
        };
      }).filter(row => row.attendanceCount > 0);
      totalCardBasedAttendanceCount = cardBasedSummary.reduce((sum, row) => sum + row.attendanceCount, 0);
      totalCardBasedRevenue = cardBasedSummary.reduce((sum, row) => sum + row.revenue, 0);
    } catch (err) {
      totalCardBasedAttendanceCount = 0;
      totalCardBasedRevenue = 0;
      cardBasedSummary = [];
      totalAttendanceCount = 0;
      instructorAttendanceBreakdown = [];
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
    // --- New: Discount metrics ---
    // MemberLessonPackage: filter by memberId, assignedAt, and (optionally) salon
    const { MemberLessonPackage } = require('../models');
    let discountWhere = {};
    if (memberIds.length) discountWhere.memberId = { [Op.in]: memberIds };
    if (startDate || endDate) discountWhere.assignedAt = dateFilter;
    const assignments = await MemberLessonPackage.findAll({ where: discountWhere });
    let totalDiscountAmount = 0;
    for (const a of assignments) {
      const discount = (a.originalPrice || 0) - (a.finalPrice || 0);
      if (discount > 0) totalDiscountAmount += discount;
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
        occupancyRate,
        totalCardBasedAttendanceCount,
        totalCardBasedRevenue,
        totalAttendanceCount,
        totalDiscountAmount
      },
      memberTypeBreakdown,
      packageBreakdown,
      paymentBreakdown: {
        received: receivedPayments,
        pending: pendingPayments,
        totalDebt
      },
      occupancyBreakdown,
      cardBasedSummary,
      instructorAttendanceBreakdown
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
