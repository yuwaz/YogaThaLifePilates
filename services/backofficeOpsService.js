const { Studio, User } = require('../models');

function groupCountRows(rows, keyField, valueField) {
  const grouped = {};
  for (const row of rows || []) {
    const key = String(row[keyField]);
    grouped[key] = Number(row[valueField]);
  }
  return grouped;
}

async function getPlatformSummary() {
  const [
    totalStudios,
    activeStudios,
    trialStudios,
    suspendedStudios,
    cancelledStudios,
    onboardingCompletedCount,
    onboardingIncompleteCount,
    totalTenantUsers,
    totalStudioAdmins,
    totalInstructors,
    studiosByPlanRows,
  ] = await Promise.all([
    Studio.count(),
    Studio.count({ where: { subscriptionStatus: 'active' } }),
    Studio.count({ where: { subscriptionStatus: 'trial' } }),
    Studio.count({ where: { subscriptionStatus: 'suspended' } }),
    Studio.count({ where: { subscriptionStatus: 'cancelled' } }),
    Studio.count({ where: { onboardingCompleted: true } }),
    Studio.count({ where: { onboardingCompleted: false } }),
    User.count(),
    User.count({ where: { role: 'admin' } }),
    User.count({ where: { role: 'instructor' } }),
    Studio.findAll({
      attributes: [
        'subscriptionPlan',
        [Studio.sequelize.fn('COUNT', Studio.sequelize.col('subscriptionPlan')), 'count'],
      ],
      group: ['subscriptionPlan'],
      raw: true,
    }),
  ]);

  return {
    totalStudios: Number(totalStudios || 0),
    activeStudios: Number(activeStudios || 0),
    trialStudios: Number(trialStudios || 0),
    suspendedStudios: Number(suspendedStudios || 0),
    cancelledStudios: Number(cancelledStudios || 0),
    studiosByPlan: groupCountRows(studiosByPlanRows, 'subscriptionPlan', 'count'),
    onboardingCompletedCount: Number(onboardingCompletedCount || 0),
    onboardingIncompleteCount: Number(onboardingIncompleteCount || 0),
    totalTenantUsers: Number(totalTenantUsers || 0),
    totalStudioAdmins: Number(totalStudioAdmins || 0),
    totalInstructors: Number(totalInstructors || 0),
  };
}

module.exports = {
  getPlatformSummary,
};