#!/usr/bin/env node

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const readline = require('readline');
const { PlatformAdmin, PlatformAuditLog, sequelize } = require('../models');
const ensurePlatformAdminsTable = require('../ensurePlatformAdminsTable');
const ensurePlatformAuditLogsTable = require('../ensurePlatformAuditLogsTable');
const { normalizePlatformAdminEmail } = require('../services/platformAuthService');
const { toSafeSnapshotValue } = require('../services/platformAuditService');

const BCRYPT_ROUNDS = 10;
const VALID_COMMANDS = new Set(['create', 'disable', 'enable', 'reset-password', 'help']);

function createCliError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/managePlatformAdmin.js create --email admin@example.com [--reason "..."] [--password-stdin]');
  console.log('  node scripts/managePlatformAdmin.js disable --email admin@example.com --reason "..."');
  console.log('  node scripts/managePlatformAdmin.js enable --email admin@example.com --reason "..."');
  console.log('  node scripts/managePlatformAdmin.js reset-password --email admin@example.com --reason "..." [--password-stdin]');
  console.log('');
  console.log('Options:');
  console.log('  --email <value>          Required for create/disable/enable/reset-password');
  console.log('  --reason <value>         Required for disable/enable/reset-password');
  console.log('  --password-stdin         Read password and confirmation from stdin lines (non-interactive)');
  console.log('  --debug                  Print full errors for debugging');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || 'help';
  const options = {
    debug: false,
    passwordStdin: false,
  };

  for (let i = 1; i < args.length; i += 1) {
    const current = args[i];

    if (current === '--debug') {
      options.debug = true;
      continue;
    }

    if (current === '--password-stdin') {
      options.passwordStdin = true;
      continue;
    }

    if (current === '--email' || current === '--reason') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        throw createCliError('CLI_INVALID_ARGUMENT', `Missing value for ${current}`);
      }
      if (current === '--email') options.email = value;
      if (current === '--reason') options.reason = value;
      i += 1;
      continue;
    }

    throw createCliError('CLI_INVALID_ARGUMENT', `Unknown option: ${current}`);
  }

  if (!VALID_COMMANDS.has(command)) {
    throw createCliError('CLI_INVALID_COMMAND', `Unknown command: ${command}`);
  }

  return { command, options };
}

function validateEmail(inputEmail) {
  const normalized = normalizePlatformAdminEmail(inputEmail);
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalized)) {
    throw createCliError('CLI_INVALID_EMAIL', 'Invalid email format');
  }
  return normalized;
}

function validateRequiredReason(reason) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw createCliError('CLI_MISSING_REASON', 'Reason is required');
  }

  const normalized = reason.trim();
  if (normalized.length > 5000) {
    throw createCliError('CLI_INVALID_REASON', 'Reason exceeds max length');
  }

  return normalized;
}

function validatePasswordPolicy(password) {
  if (typeof password !== 'string') {
    throw createCliError('CLI_INVALID_PASSWORD', 'Password must be a string');
  }

  if (password.length < 12) {
    throw createCliError('CLI_INVALID_PASSWORD', 'Password must be at least 12 characters');
  }

  if (!/[a-z]/.test(password)) {
    throw createCliError('CLI_INVALID_PASSWORD', 'Password must include a lowercase letter');
  }

  if (!/[A-Z]/.test(password)) {
    throw createCliError('CLI_INVALID_PASSWORD', 'Password must include an uppercase letter');
  }

  if (!/[0-9]/.test(password)) {
    throw createCliError('CLI_INVALID_PASSWORD', 'Password must include a number');
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    throw createCliError('CLI_INVALID_PASSWORD', 'Password must include a symbol');
  }

  if (/\s/.test(password)) {
    throw createCliError('CLI_INVALID_PASSWORD', 'Password must not contain whitespace');
  }
}

function toSafeAdminSnapshot(adminLike) {
  if (!adminLike) return null;

  const admin = adminLike && typeof adminLike.get === 'function'
    ? adminLike.get({ plain: true })
    : adminLike;

  return {
    id: admin.id,
    email: admin.email,
    status: admin.status,
    mfaRequired: Boolean(admin.mfaRequired),
    lastLoginAt: admin.lastLoginAt || null,
    createdAt: admin.createdAt || null,
    updatedAt: admin.updatedAt || null,
  };
}

function generateRequestId() {
  const rand = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  return `cli-${rand}`;
}

function generateEventId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

async function promptText(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer));
    });
  } finally {
    rl.close();
  }
}

async function promptHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw createCliError('CLI_INTERACTIVE_REQUIRED', 'Interactive hidden password input requires a TTY. Use --password-stdin for non-interactive usage.');
  }

  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let value = '';

    function cleanup() {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      process.stdout.write('\n');
    }

    function onData(char) {
      if (char === '\u0003') {
        cleanup();
        reject(createCliError('CLI_CANCELLED', 'Operation cancelled'));
        return;
      }

      if (char === '\r' || char === '\n') {
        cleanup();
        resolve(value);
        return;
      }

      if (char === '\u007f') {
        if (value.length > 0) {
          value = value.slice(0, -1);
        }
        return;
      }

      value += char;
    }

    stdin.on('data', onData);
  });
}

async function readPasswordAndConfirm({ passwordStdin, actionLabel }) {
  if (passwordStdin) {
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    const lines = [];
    for await (const line of rl) {
      lines.push(line);
      if (lines.length >= 2) {
        rl.close();
        break;
      }
    }

    if (lines.length < 2) {
      throw createCliError('CLI_PASSWORD_REQUIRED', 'Expected password and confirmation via stdin');
    }

    const password = lines[0];
    const confirmation = lines[1];

    if (password !== confirmation) {
      throw createCliError('CLI_PASSWORD_CONFIRMATION_MISMATCH', 'Password confirmation does not match');
    }

    validatePasswordPolicy(password);
    return password;
  }

  const password = await promptHidden(`Enter new password for ${actionLabel}: `);
  const confirmation = await promptHidden(`Confirm new password for ${actionLabel}: `);
  if (password !== confirmation) {
    throw createCliError('CLI_PASSWORD_CONFIRMATION_MISMATCH', 'Password confirmation does not match');
  }
  validatePasswordPolicy(password);
  return password;
}

async function writeAuditLog({
  transaction,
  actionType,
  targetId,
  reason,
  beforeSnapshot,
  afterSnapshot,
}) {
  await PlatformAuditLog.create({
    eventId: generateEventId(),
    actorPlatformAdminId: null,
    actionType,
    targetType: 'platform_admin',
    targetId: String(targetId),
    studioId: null,
    reason,
    requestId: generateRequestId(),
    ip: 'cli',
    userAgent: 'managePlatformAdmin.js',
    beforeSnapshot: toSafeSnapshotValue(beforeSnapshot),
    afterSnapshot: toSafeSnapshotValue(afterSnapshot),
  }, { transaction });
}

async function createPlatformAdmin({ email, reason, passwordStdin }) {
  const normalizedEmail = validateEmail(email);
  const defaultReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'Initial platform bootstrap via CLI';
  const password = await readPasswordAndConfirm({ passwordStdin, actionLabel: normalizedEmail });

  return sequelize.transaction(async (transaction) => {
    const existing = await PlatformAdmin.findOne({
      where: { email: normalizedEmail },
      transaction,
    });

    if (existing) {
      throw createCliError('CLI_DUPLICATE_ADMIN', 'PlatformAdmin already exists for this email');
    }

    const adminCount = await PlatformAdmin.count({ transaction });
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const created = await PlatformAdmin.create({
      email: normalizedEmail,
      passwordHash,
      status: 'active',
      mfaRequired: false,
    }, { transaction });

    const actionType = adminCount === 0
      ? 'PLATFORM_ADMIN_BOOTSTRAP_CREATED'
      : 'PLATFORM_ADMIN_CREATED_BY_CLI';

    await writeAuditLog({
      transaction,
      actionType,
      targetId: created.id,
      reason: defaultReason,
      beforeSnapshot: null,
      afterSnapshot: toSafeAdminSnapshot(created),
    });

    return created;
  });
}

async function setPlatformAdminStatus({ email, reason, nextStatus }) {
  const normalizedEmail = validateEmail(email);
  const normalizedReason = validateRequiredReason(reason);

  return sequelize.transaction(async (transaction) => {
    const admin = await PlatformAdmin.findOne({
      where: { email: normalizedEmail },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!admin) {
      throw createCliError('CLI_ADMIN_NOT_FOUND', 'PlatformAdmin not found');
    }

    if (admin.status === nextStatus) {
      throw createCliError('CLI_NOOP_STATUS_CHANGE', `PlatformAdmin is already ${nextStatus}`);
    }

    const beforeSnapshot = toSafeAdminSnapshot(admin);
    admin.status = nextStatus;
    await admin.save({ fields: ['status'], transaction });

    await writeAuditLog({
      transaction,
      actionType: nextStatus === 'disabled' ? 'PLATFORM_ADMIN_DISABLED_BY_CLI' : 'PLATFORM_ADMIN_ENABLED_BY_CLI',
      targetId: admin.id,
      reason: normalizedReason,
      beforeSnapshot,
      afterSnapshot: toSafeAdminSnapshot(admin),
    });

    return admin;
  });
}

async function resetPlatformAdminPassword({ email, reason, passwordStdin }) {
  const normalizedEmail = validateEmail(email);
  const normalizedReason = validateRequiredReason(reason);
  const password = await readPasswordAndConfirm({ passwordStdin, actionLabel: normalizedEmail });

  return sequelize.transaction(async (transaction) => {
    const admin = await PlatformAdmin.findOne({
      where: { email: normalizedEmail },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!admin) {
      throw createCliError('CLI_ADMIN_NOT_FOUND', 'PlatformAdmin not found');
    }

    const beforeSnapshot = toSafeAdminSnapshot(admin);
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    admin.passwordHash = passwordHash;
    await admin.save({ fields: ['passwordHash'], transaction });

    await writeAuditLog({
      transaction,
      actionType: 'PLATFORM_ADMIN_PASSWORD_RESET_BY_CLI',
      targetId: admin.id,
      reason: normalizedReason,
      beforeSnapshot,
      afterSnapshot: toSafeAdminSnapshot(admin),
    });

    return admin;
  });
}

async function ensurePlatformTables() {
  await ensurePlatformAdminsTable();
  await ensurePlatformAuditLogsTable();
}

function requireOption(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createCliError('CLI_MISSING_ARGUMENT', `${name} is required`);
  }
}

async function run() {
  const { command, options } = parseArgs(process.argv);

  if (command === 'help') {
    printUsage();
    return;
  }

  await ensurePlatformTables();

  if (command === 'create') {
    requireOption(options.email, '--email');
    const created = await createPlatformAdmin({
      email: options.email,
      reason: options.reason,
      passwordStdin: options.passwordStdin,
    });
    console.log(`PlatformAdmin created: id=${created.id} email=${created.email} status=${created.status}`);
    return;
  }

  if (command === 'disable') {
    requireOption(options.email, '--email');
    requireOption(options.reason, '--reason');
    const updated = await setPlatformAdminStatus({
      email: options.email,
      reason: options.reason,
      nextStatus: 'disabled',
    });
    console.log(`PlatformAdmin disabled: id=${updated.id} email=${updated.email} status=${updated.status}`);
    return;
  }

  if (command === 'enable') {
    requireOption(options.email, '--email');
    requireOption(options.reason, '--reason');
    const updated = await setPlatformAdminStatus({
      email: options.email,
      reason: options.reason,
      nextStatus: 'active',
    });
    console.log(`PlatformAdmin enabled: id=${updated.id} email=${updated.email} status=${updated.status}`);
    return;
  }

  if (command === 'reset-password') {
    requireOption(options.email, '--email');
    requireOption(options.reason, '--reason');
    const updated = await resetPlatformAdminPassword({
      email: options.email,
      reason: options.reason,
      passwordStdin: options.passwordStdin,
    });
    console.log(`PlatformAdmin password reset: id=${updated.id} email=${updated.email}`);
    return;
  }

  throw createCliError('CLI_INVALID_COMMAND', `Unknown command: ${command}`);
}

run()
  .catch((err) => {
    const message = err && err.message ? err.message : 'Unexpected error';
    console.error(`Error: ${message}`);

    const debugMode = process.argv.includes('--debug');
    if (debugMode && err && err.stack) {
      console.error(err.stack);
    }

    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await sequelize.close();
    } catch (err) {
      process.exitCode = 1;
      console.error('Error: Failed to close database connection cleanly');
    }
  });