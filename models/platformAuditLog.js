const { DataTypes } = require('sequelize');

const FORBIDDEN_SNAPSHOT_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'jwt',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'purchasetoken',
  'applesignedpayload',
  'privatekey',
  'providercredentials',
  'secret',
]);

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function findForbiddenSnapshotKey(value, pathParts = []) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const nestedResult = findForbiddenSnapshotKey(value[i], [...pathParts, String(i)]);
      if (nestedResult) return nestedResult;
    }
    return null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = String(key).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (FORBIDDEN_SNAPSHOT_KEYS.has(normalizedKey)) {
      return [...pathParts, key].join('.');
    }

    const nestedResult = findForbiddenSnapshotKey(nestedValue, [...pathParts, key]);
    if (nestedResult) return nestedResult;
  }

  return null;
}

module.exports = (sequelize) => {
  const PlatformAuditLog = sequelize.define('PlatformAuditLog', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    eventId: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    actorPlatformAdminId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'PlatformAdmins',
        key: 'id',
      },
    },
    actionType: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    targetType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    targetId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    studioId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    requestId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    ip: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    userAgent: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    beforeSnapshot: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    afterSnapshot: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  }, {
    validate: {
      noForbiddenSnapshotKeys() {
        const beforePath = findForbiddenSnapshotKey(this.beforeSnapshot);
        if (beforePath) {
          throw new Error(`beforeSnapshot contains forbidden field: ${beforePath}`);
        }

        const afterPath = findForbiddenSnapshotKey(this.afterSnapshot);
        if (afterPath) {
          throw new Error(`afterSnapshot contains forbidden field: ${afterPath}`);
        }
      },
    },
    indexes: [
      {
        name: 'platform_audit_logs_event_id_unique',
        unique: true,
        fields: ['eventId'],
      },
      {
        name: 'platform_audit_logs_actor_platform_admin_id_idx',
        fields: ['actorPlatformAdminId'],
      },
      {
        name: 'platform_audit_logs_studio_id_idx',
        fields: ['studioId'],
      },
      {
        name: 'platform_audit_logs_action_type_idx',
        fields: ['actionType'],
      },
      {
        name: 'platform_audit_logs_created_at_idx',
        fields: ['createdAt'],
      },
    ],
  });

  return PlatformAuditLog;
};