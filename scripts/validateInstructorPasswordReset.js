const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'instructor-password-reset-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');
  process.env.DB_PATH = dbPath;

  const { sequelize, Studio, User } = require('../models');
  const { buildAuthPayload, signAuthToken } = require('../utils/authToken');

  const report = {
    disposableDbPath: dbPath,
    testsPassed: [],
    testsFailed: [],
  };

  async function test(name, fn) {
    try {
      await fn();
      report.testsPassed.push(name);
    } catch (error) {
      report.testsFailed.push({
        name,
        message: error && error.message ? String(error.message) : 'Unknown error',
      });
    }
  }

  function makeToken(userLike) {
    return signAuthToken(buildAuthPayload(userLike));
  }

  function buildApp() {
    const app = express();
    app.use(bodyParser.json());
    app.use('/auth', require('../routes/auth'));
    app.use('/settings/users', require('../routes/settings/users'));
    app.use((req, res) => res.status(404).json({ message: 'Not found' }));
    return app;
  }

  function startServer(app) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(app);
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  function stopServer(server) {
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) return reject(error);
        return resolve();
      });
    });
  }

  function requestJson(server, { method = 'GET', routePath = '/', token = null, body = undefined } = {}) {
    return new Promise((resolve, reject) => {
      const payload = typeof body === 'undefined' ? null : JSON.stringify(body);
      const address = server.address();
      const headers = {};

      if (token) headers.Authorization = `Bearer ${token}`;
      if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        method,
        path: routePath,
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch (error) {
              parsed = text;
            }
          }
          resolve({ statusCode: res.statusCode, body: parsed, text });
        });
      });

      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  function normalizeJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        return [];
      }
    }
    return [];
  }

  async function getUserSnapshot(userId) {
    const user = await User.findByPk(userId);
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      studioId: user.studioId,
      assignedSalonIds: normalizeJsonArray(user.assignedSalonIds),
      permissions: normalizeJsonArray(user.permissions),
      groupSessionFee: String(user.groupSessionFee),
      individualSessionFee: String(user.individualSessionFee),
      password: user.password,
    };
  }

  async function tableColumns(tableName) {
    const [rows] = await sequelize.query(`PRAGMA table_info('${tableName}')`);
    return rows.map((row) => ({
      name: row.name,
      type: row.type,
      notnull: row.notnull,
      dflt_value: row.dflt_value,
      pk: row.pk,
    }));
  }

  async function createStudio({ name, studioCode }) {
    return Studio.create({
      name,
      studioCode,
      email: null,
      phone: null,
      country: 'TR',
      currency: 'TRY',
      timezone: 'Europe/Istanbul',
      subscriptionStatus: 'active',
      subscriptionPlan: 'trial',
      trialEndsAt: null,
      onboardingCompleted: true,
      onboardingStep: 'completed',
    });
  }

  async function createUser({ username, password, role, studioId, assignedSalonIds = [], permissions = [], groupSessionFee = 0, individualSessionFee = 0 }) {
    return User.create({
      username,
      password: await bcrypt.hash(password, 10),
      role,
      studioId,
      assignedSalonIds,
      permissions,
      groupSessionFee,
      individualSessionFee,
    });
  }

  let server;

  try {
    await sequelize.sync({ force: true });

    const studioA = await createStudio({ name: 'Studio A', studioCode: 'studio-a' });
    const studioB = await createStudio({ name: 'Studio B', studioCode: 'studio-b' });

    const adminA = await createUser({ username: 'admin-a', password: 'admin-old-a', role: 'admin', studioId: studioA.id });
    const instructorA = await createUser({
      username: 'instructor-a',
      password: 'old-pass-a',
      role: 'instructor',
      studioId: studioA.id,
      assignedSalonIds: [11, 12],
      permissions: ['members', 'reservations'],
      groupSessionFee: 125.5,
      individualSessionFee: 275.75,
    });
    const otherAdminA = await createUser({ username: 'other-admin-a', password: 'admin-old-b', role: 'admin', studioId: studioA.id });
    const adminB = await createUser({ username: 'admin-b', password: 'admin-old-c', role: 'admin', studioId: studioB.id });
    const instructorB = await createUser({ username: 'instructor-b', password: 'old-pass-b', role: 'instructor', studioId: studioB.id });

    const adminAToken = makeToken(adminA);
    const instructorAToken = makeToken(instructorA);
    const adminBToken = makeToken(adminB);
    const routePath = `/settings/users/instructors/${instructorA.id}/password`;
    const app = buildApp();
    server = await startServer(app);

    await test('same-studio admin resets instructor password and only password changes', async () => {
      const beforeColumns = await tableColumns('Users');
      const before = await getUserSnapshot(instructorA.id);
      const response = await requestJson(server, {
        method: 'PATCH',
        routePath,
        token: adminAToken,
        body: { newPassword: 'new-pass-a' },
      });

      assert.strictEqual(response.statusCode, 200);
      assert.deepStrictEqual(response.body, { message: 'Password updated successfully' });
      assert(!response.text.includes('new-pass-a'));

      const after = await getUserSnapshot(instructorA.id);
      assert.notStrictEqual(after.password, before.password);
      assert.strictEqual(await bcrypt.compare('old-pass-a', after.password), false);
      assert.strictEqual(await bcrypt.compare('new-pass-a', after.password), true);
      assert.deepStrictEqual(await tableColumns('Users'), beforeColumns);

      const { password: beforePassword, ...beforeSafe } = before;
      const { password: afterPassword, ...afterSafe } = after;
      assert(beforePassword);
      assert(afterPassword);
      assert.deepStrictEqual(afterSafe, beforeSafe);
    });

    await test('old password no longer logs in and new password logs in', async () => {
      const oldLogin = await requestJson(server, {
        method: 'POST',
        routePath: '/auth/login',
        body: { studioCode: 'studio-a', username: 'instructor-a', password: 'old-pass-a' },
      });
      assert.strictEqual(oldLogin.statusCode, 401);

      const newLogin = await requestJson(server, {
        method: 'POST',
        routePath: '/auth/login',
        body: { studioCode: 'studio-a', username: 'instructor-a', password: 'new-pass-a' },
      });
      assert.strictEqual(newLogin.statusCode, 200);
      assert.strictEqual(newLogin.body.role, 'instructor');
      assert(newLogin.body.token);
    });

    await test('non-admin cannot reset instructor password', async () => {
      const before = await getUserSnapshot(instructorB.id);
      const response = await requestJson(server, {
        method: 'PATCH',
        routePath: `/settings/users/instructors/${instructorB.id}/password`,
        token: instructorAToken,
        body: { newPassword: 'blocked-pass' },
      });
      assert.strictEqual(response.statusCode, 403);
      const after = await getUserSnapshot(instructorB.id);
      assert.strictEqual(after.password, before.password);
    });

    await test('admin cannot reset instructor from another studio', async () => {
      const before = await getUserSnapshot(instructorA.id);
      const response = await requestJson(server, {
        method: 'PATCH',
        routePath,
        token: adminBToken,
        body: { newPassword: 'blocked-pass' },
      });
      assert.strictEqual(response.statusCode, 404);
      const after = await getUserSnapshot(instructorA.id);
      assert.strictEqual(after.password, before.password);
    });

    await test('admin cannot target another admin through instructor endpoint', async () => {
      const before = await getUserSnapshot(otherAdminA.id);
      const response = await requestJson(server, {
        method: 'PATCH',
        routePath: `/settings/users/instructors/${otherAdminA.id}/password`,
        token: adminAToken,
        body: { newPassword: 'blocked-pass' },
      });
      assert.strictEqual(response.statusCode, 404);
      const after = await getUserSnapshot(otherAdminA.id);
      assert.strictEqual(after.password, before.password);
    });

    await test('existing minimum password rule is preserved', async () => {
      const before = await getUserSnapshot(instructorA.id);
      const response = await requestJson(server, {
        method: 'PATCH',
        routePath,
        token: adminAToken,
        body: { newPassword: '12345' },
      });
      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(response.body, { error: 'newPassword must be at least 6 characters' });
      const after = await getUserSnapshot(instructorA.id);
      assert.strictEqual(after.password, before.password);
    });
  } finally {
    if (server) await stopServer(server);
    await sequelize.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  if (report.testsFailed.length > 0) {
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});