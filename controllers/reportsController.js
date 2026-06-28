const { Op } = require('sequelize');
const { Member, MemberType, Reservation, Payment, LessonPackage, Salon, Equipment, Attendance, Expense, User } = require('../models');

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
      // Fetch all members (active + inactive), then filter in JS for historical reporting
      members = await Member.findAll();
      members = members.filter(m => Array.isArray(m.assignedSalonIds) && m.assignedSalonIds.includes(salonIdNum));
    } else {
      // No salon filter, use all members for historical reporting
      members = await Member.findAll();
      const salons = await Salon.findAll({ attributes: ['id'] });
      salonIds = salons.map(s => s.id);
    }
    const activeMemberCount = members.filter(m => m.isActive === true).length;
    const inactiveMemberCount = members.length - activeMemberCount;
    console.log('[Reports] members included count:', members.length);
    console.log('[Reports] active/inactive included for historical report:', {
      active: activeMemberCount,
      inactive: inactiveMemberCount
    });
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
    // --- Sold Package Revenue Calculation ---
    const { MemberLessonPackage } = require('../models');
    let soldPackageRevenue = 0;
    let soldPackageCount = 0, soldLessonCount = 0, soldLessonHours = 0, packageBreakdown = [];
    // Build filter for MemberLessonPackage
    let packageWhere = {};
    if (memberIds.length) packageWhere.memberId = { [Op.in]: memberIds };
    if (startDate || endDate) packageWhere.assignedAt = dateFilter;
    const assignments = await MemberLessonPackage.findAll({ where: packageWhere });
    // Fetch all lesson packages for fallback price
    const lessonPackages = await LessonPackage.findAll();
    const lessonPackageMap = {};
    lessonPackages.forEach(lp => { lessonPackageMap[lp.id] = lp; });
    // For breakdown
    const packageIdToAssignments = {};
    assignments.forEach(a => {
      if (!packageIdToAssignments[a.lessonPackageId]) packageIdToAssignments[a.lessonPackageId] = [];
      packageIdToAssignments[a.lessonPackageId].push(a);
    });
    // Calculate soldPackageRevenue and breakdown
    for (const lp of lessonPackages) {
      const assigned = packageIdToAssignments[lp.id] || [];
      let packageRevenue = 0;
      let lessonCount = 0;
      assigned.forEach(a => {
        let price = a.finalPrice != null ? a.finalPrice : (a.originalPrice != null ? a.originalPrice : Number(lp.price || 0));
        packageRevenue += Number(price);
        // lessonCount fallback: use lp.lessonCount if available
        lessonCount += lp.lessonCount || 0;
      });
      soldPackageRevenue += packageRevenue;
      soldPackageCount += assigned.length;
      soldLessonCount += lessonCount;
      soldLessonHours += lessonCount; // 1 hour per lesson
      packageBreakdown.push({
        lessonPackageId: lp.id,
        lessonPackageName: lp.name,
        packageCount: assigned.length,
        lessonCount,
        lessonHours: lessonCount,
        revenue: packageRevenue
      });
    }
    // [Reports] soldPackageRevenue debug log
    console.log('[Reports] soldPackageRevenue:', soldPackageRevenue);
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
      // [Reports] totalCardBasedRevenue debug log
      console.log('[Reports] totalCardBasedRevenue:', totalCardBasedRevenue);
    } catch (err) {
      totalCardBasedAttendanceCount = 0;
      totalCardBasedRevenue = 0;
      cardBasedSummary = [];
      totalAttendanceCount = 0;
      instructorAttendanceBreakdown = [];
    }
    const cardBasedRevenue = totalCardBasedRevenue;
    const cardBasedRevenueByType = cardBasedSummary.map(row => ({
      memberTypeId: row.memberTypeId,
      name: row.memberTypeName,
      count: row.attendanceCount,
      revenue: row.revenue
    }));

    let instructorSessionBreakdown = [];
    try {
      const reservationWhereForSessions = {};
      if (startDate || endDate) reservationWhereForSessions.date = dateFilter;
      if (salonId !== undefined && salonId !== null) reservationWhereForSessions.salonId = Number(salonId);

      const sessionAttendances = await Attendance.findAll({
        where: {
          reservationId: { [Op.not]: null },
          instructorId: { [Op.not]: null },
        },
        include: [{
          model: Reservation,
          required: true,
          attributes: ['id', 'salonId', 'date', 'time'],
          where: reservationWhereForSessions,
        }, {
          model: Member,
          required: false,
          attributes: ['id', 'name'],
        }],
        attributes: ['id', 'instructorId', 'reservationId'],
      });

      const instructorIds = [...new Set(sessionAttendances.map((a) => Number(a.instructorId)).filter((id) => !Number.isNaN(id)))];
      const users = instructorIds.length
        ? await User.findAll({
            where: { id: { [Op.in]: instructorIds } },
            attributes: ['id', 'username'],
          })
        : [];
      const instructorNameById = new Map(users.map((u) => [Number(u.id), u.username]));

      const salonsForNames = await Salon.findAll({ attributes: ['id', 'name'] });
      const salonNameById = new Map(salonsForNames.map((s) => [Number(s.id), s.name]));

      const grouped = new Map();
      for (const attendance of sessionAttendances) {
        const reservation = attendance.Reservation;
        const member = attendance.Member;
        if (!reservation) continue;

        const instructorId = Number(attendance.instructorId);
        const salonIdNum = Number(reservation.salonId);
        const aggregateKey = `${instructorId}|${salonIdNum}`;
        const sessionKey = `${reservation.date}|${reservation.time}`;

        if (!grouped.has(aggregateKey)) {
          grouped.set(aggregateKey, {
            instructorId,
            instructorName: instructorNameById.get(instructorId) || 'Bilinmeyen Eğitmen',
            salonId: salonIdNum,
            salonName: salonNameById.get(salonIdNum) || `Salon ID ${salonIdNum}`,
            participantCount: 0,
            sessions: new Map(),
          });
        }

        const row = grouped.get(aggregateKey);
        row.participantCount += 1;

        if (!row.sessions.has(sessionKey)) {
          row.sessions.set(sessionKey, {
            date: reservation.date,
            time: reservation.time,
            salonId: salonIdNum,
            salonName: row.salonName,
            participantCount: 0,
            members: [],
            memberIds: new Set(),
          });
        }

        const session = row.sessions.get(sessionKey);
        const memberId = member ? Number(member.id) : null;
        const memberName = member && member.name ? member.name : '-';
        if (memberId === null || Number.isNaN(memberId)) {
          session.members.push({
            memberId: null,
            memberName,
          });
        } else if (!session.memberIds.has(String(memberId))) {
          session.memberIds.add(String(memberId));
          session.members.push({
            memberId,
            memberName,
          });
        }
      }

      instructorSessionBreakdown = Array.from(grouped.values())
        .map((row) => ({
          instructorId: row.instructorId,
          instructorName: row.instructorName,
          salonId: row.salonId,
          salonName: row.salonName,
          sessionCount: row.sessions.size,
          participantCount: row.participantCount,
          sessions: Array.from(row.sessions.values())
            .map((session) => ({
              date: session.date,
              time: session.time,
              salonId: session.salonId,
              salonName: session.salonName,
              participantCount: session.members.length,
              members: session.members,
            }))
            .sort((a, b) => {
              if (a.date === b.date) {
                return String(a.time).localeCompare(String(b.time), 'tr');
              }
              return String(a.date).localeCompare(String(b.date), 'tr');
            }),
        }))
        .sort((a, b) => {
          if (a.instructorName === b.instructorName) {
            return a.salonName.localeCompare(b.salonName, 'tr');
          }
          return a.instructorName.localeCompare(b.instructorName, 'tr');
        });
    } catch (err) {
      instructorSessionBreakdown = [];
    }

    console.log('[Reports] cardBasedRevenue:', cardBasedRevenue);
    console.log('[Reports] cardBasedRevenueByType:', cardBasedRevenueByType);
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
    // Use same assignments as above for discount calculation
    let totalDiscountAmount = 0;
    for (const a of assignments) {
      const discount = (a.originalPrice || 0) - (a.finalPrice || 0);
      if (discount > 0) totalDiscountAmount += discount;
    }
    // Expenses total in selected range/salon
    const expenseWhere = {};
    if (startDate || endDate) expenseWhere.date = dateFilter;
    if (salonId !== undefined && salonId !== null) expenseWhere.salonId = Number(salonId);
    const expenses = await Expense.findAll({ where: expenseWhere });
    const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    // Response
    // --- Total Revenue/Income/Profit Calculation ---
    const totalRevenue = soldPackageRevenue + totalCardBasedRevenue;
    const totalIncome = soldPackageRevenue + cardBasedRevenue;
    const netProfit = totalIncome - totalExpenses;
    // [Reports] totalRevenue debug log
    console.log('[Reports] totalRevenue:', totalRevenue);
    console.log('[Reports] totalIncome:', totalIncome);
    console.log('[Reports] totalExpenses:', totalExpenses);
    console.log('[Reports] netProfit:', netProfit);
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
        cardBasedRevenue,
        totalAttendanceCount,
        totalDiscountAmount,
        soldPackageRevenue, // Satılan Paket Tutarı
        totalRevenue, // Toplam Ciro
        totalIncome,
        totalExpenses,
        netProfit
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
      cardBasedRevenueByType,
      instructorAttendanceBreakdown,
      instructorSessionBreakdown
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
