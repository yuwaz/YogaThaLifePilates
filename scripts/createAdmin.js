const bcrypt = require('bcrypt');
const { User, sequelize } = require('../models');

async function createAdmin() {
  await sequelize.sync();
  const hashedPassword = await bcrypt.hash('737213', 10);
  let user = await User.findOne({ where: { username: 'Admin' } });
  if (user) {
    user.password = hashedPassword;
    user.role = 'admin';
    user.assignedSalonIds = [];
    await user.save();
    console.log('Admin user updated');
  } else {
    await User.create({
      username: 'Admin',
      password: hashedPassword,
      role: 'admin',
      assignedSalonIds: [],
    });
    console.log('Admin user created');
  }
  process.exit();
}

createAdmin();
