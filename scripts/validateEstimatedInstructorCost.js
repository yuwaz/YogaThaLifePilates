// Disposable validator (not part of product code): proves estimatedInstructorCost /
// estimatedNetProfit summation logic matches the required cases without touching
// any real database or the authoritative reportsController query paths.
const assert = require('assert');

function computeEstimated(instructorSessionBreakdown, totalIncome, totalExpenses) {
  const estimatedInstructorCost = instructorSessionBreakdown.reduce(
    (sum, row) => sum + Number(row.totalInstructorPayout || 0),
    0
  );
  const netProfit = totalIncome - totalExpenses;
  const estimatedNetProfit = totalIncome - totalExpenses - estimatedInstructorCost;
  return { estimatedInstructorCost, netProfit, estimatedNetProfit };
}

// Case A
{
  const { estimatedInstructorCost, netProfit, estimatedNetProfit } = computeEstimated(
    [{ totalInstructorPayout: 500 }, { totalInstructorPayout: 300 }],
    10000,
    2000
  );
  assert.strictEqual(estimatedInstructorCost, 800);
  assert.strictEqual(netProfit, 8000);
  assert.strictEqual(estimatedNetProfit, 7200);
  console.log('Case A OK', { estimatedInstructorCost, netProfit, estimatedNetProfit });
}

// Case B: no instructor sessions -> estimatedNetProfit === existing netProfit
{
  const { estimatedInstructorCost, netProfit, estimatedNetProfit } = computeEstimated([], 5000, 1000);
  assert.strictEqual(estimatedInstructorCost, 0);
  assert.strictEqual(estimatedNetProfit, netProfit);
  console.log('Case B OK', { estimatedInstructorCost, netProfit, estimatedNetProfit });
}

// Case C: salon-filtered breakdown (already-filtered rows only, e.g. single salon)
{
  const { estimatedInstructorCost } = computeEstimated(
    [{ totalInstructorPayout: 200 }],
    3000,
    500
  );
  assert.strictEqual(estimatedInstructorCost, 200);
  console.log('Case C OK', { estimatedInstructorCost });
}

// Case D: multiple instructors / multiple salons -> each row summed exactly once
{
  const rows = [
    { instructorId: 1, salonId: 1, totalInstructorPayout: 150 },
    { instructorId: 1, salonId: 2, totalInstructorPayout: 100 },
    { instructorId: 2, salonId: 1, totalInstructorPayout: 250 },
  ];
  const { estimatedInstructorCost } = computeEstimated(rows, 9000, 1000);
  assert.strictEqual(estimatedInstructorCost, 500);
  console.log('Case D OK', { estimatedInstructorCost });
}

console.log('All estimated-instructor-cost cases passed.');
