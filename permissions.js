// This file defines permissions for each role. You can expand this as needed.
module.exports = {
  admin: [
    'members',
    'payments',
    'reservations',
    'salons',
    'equipment',
    'lessonPackages',
    'memberTypes',
    'paymentMethods',
    'attendances',
    'users',
  ],
  instructor: [
    'members',
    'reservations',
    'attendances',
  ],
};
