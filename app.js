const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { sequelize } = require('./models');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/settings/users');
const salonsRoutes = require('./routes/settings/salons');
const equipmentRoutes = require('./routes/settings/equipment');
const lessonPackagesRoutes = require('./routes/settings/lessonPackages');
const memberTypesRoutes = require('./routes/settings/memberTypes');
const paymentMethodsRoutes = require('./routes/settings/paymentMethods');
const membersRoutes = require('./routes/settings/members');
const reservationsRoutes = require('./routes/settings/reservations');
const paymentsRoutes = require('./routes/settings/payments');
const attendancesRoutes = require('./routes/settings/attendances');
const reportsRoutes = require('./routes/settings/reports');

const app = express();
// General CORS for all routes (existing behavior)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

// Auth routes (CORS is now handled in the router itself)
app.use('/auth', authRoutes);
app.use('/settings/users', usersRoutes);
app.use('/settings/salons', salonsRoutes);
app.use('/settings/equipment', equipmentRoutes);
app.use('/settings/lessonPackages', lessonPackagesRoutes);
app.use('/settings/members', membersRoutes);
app.use('/settings/reservations', reservationsRoutes);
app.use('/settings/payments', paymentsRoutes);
app.use('/settings/attendances', attendancesRoutes);

app.use('/settings/memberTypes', memberTypesRoutes);
app.use('/settings/paymentMethods', paymentMethodsRoutes);
app.use('/settings/reports', reportsRoutes);

// Health check
app.get('/', (req, res) => res.send('Fitness Studio API running'));

// Fallback 404 handler for unmatched routes (returns JSON, not HTML)
app.use((req, res, next) => {
  res.status(404).json({ message: 'Not found' });
});

// Start server
const PORT = process.env.PORT || 3000;
(async () => {
  await sequelize.sync();
  // Listen on all network interfaces for external access
  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
})();

module.exports = app;
