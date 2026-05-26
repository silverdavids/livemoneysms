const crypto = require("crypto");
const { getPool, createRequest, sql } = require("../db");

const tableColumnsPromises = new Map();

async function getTableColumns(schemaName, tableName) {
  const key = `${schemaName}.${tableName}`;
  if (!tableColumnsPromises.has(key)) {
    tableColumnsPromises.set(key, (async () => {
      const request = await createRequest();
      request.input("schemaName", sql.NVarChar(128), schemaName);
      request.input("tableName", sql.NVarChar(128), tableName);

      const result = await request.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schemaName
          AND TABLE_NAME = @tableName;
      `);

      return new Set((result.recordset || []).map((row) => row.COLUMN_NAME).filter(Boolean));
    })().catch((error) => {
      tableColumnsPromises.delete(key);
      throw error;
    }));
  }

  return tableColumnsPromises.get(key);
}

function selectExistingColumn(columns, candidates) {
  return candidates.find((candidate) => columns.has(candidate)) || null;
}

async function listDevicesForUser(user) {
  const request = await createRequest();
  const clientDeviceColumns = await getTableColumns("sms", "ClientDevices");
  const clientColumns = await getTableColumns("sms", "Clients");
  const clauses = ["1 = 1"];

  if (!user.canViewAllDevices) {
    const clientIds = Array.isArray(user.clientIds)
      ? user.clientIds.map((clientId) => String(clientId || "").trim()).filter(Boolean)
      : [];

    if (clientIds.length === 0 || !clientDeviceColumns.has("ClientId")) {
      clauses.push("1 = 0");
    } else {
      const placeholders = [];
      for (let index = 0; index < clientIds.length; index += 1) {
        const name = `AllowedClient${index}`;
        placeholders.push(`@${name}`);
        request.input(name, sql.UniqueIdentifier, clientIds[index]);
      }
      clauses.push(`cd.ClientId IN (${placeholders.join(", ")})`);
    }
  }

  if (clientDeviceColumns.has("IsActive")) {
    clauses.push("cd.IsActive = 1");
  }

  const deviceIdColumn = selectExistingColumn(clientDeviceColumns, ["DeviceId", "ForwardingDeviceId", "ClientDeviceId"]);
  const deviceNameColumn = selectExistingColumn(clientDeviceColumns, ["DeviceName", "Name"]);
  const descriptionColumn = selectExistingColumn(clientDeviceColumns, ["Description", "DevicePhone", "PhoneNumber", "Phone", "Msisdn", "DeviceMsisdn"]);
  const createdColumn = selectExistingColumn(clientDeviceColumns, ["CreatedOnUtc", "CreatedAt", "RegisteredOnUtc"]);
  const clientNameColumn = selectExistingColumn(clientColumns, ["BusinessName", "ClientName", "Name"]);

  const result = await request.query(`
    SELECT
      ${deviceIdColumn ? `CONVERT(nvarchar(100), cd.${deviceIdColumn})` : "CAST(NULL AS nvarchar(100))"} AS DeviceId,
      ${deviceNameColumn ? `cd.${deviceNameColumn}` : "CAST(NULL AS nvarchar(255))"} AS DeviceName,
      ${descriptionColumn ? `cd.${descriptionColumn}` : "CAST(NULL AS nvarchar(255))"} AS Description,
      ${clientDeviceColumns.has("IsActive") ? "cd.IsActive" : "CAST(1 AS bit)"} AS IsActive,
      ${createdColumn ? `cd.${createdColumn}` : "CAST(NULL AS datetime2)"} AS CreatedOnUtc,
      ${clientDeviceColumns.has("ClientId") ? "cd.ClientId" : "CAST(NULL AS uniqueidentifier)"} AS ClientId,
      ${clientNameColumn ? `c.${clientNameColumn}` : "CAST(NULL AS nvarchar(255))"} AS BusinessName,
      CAST(1 AS bit) AS IsAssignedToUser
    FROM sms.ClientDevices cd
    LEFT JOIN sms.Clients c
      ON ${clientDeviceColumns.has("ClientId") && clientColumns.has("ClientId") ? "c.ClientId = cd.ClientId" : "1 = 0"}
    WHERE ${clauses.join("\n      AND ")}
    ORDER BY DeviceId;
  `);

  return result.recordset || [];
}

async function upsertUserDeviceAssignment({ userId, deviceId, isActive }) {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const validateRequest = new sql.Request(transaction);
    validateRequest.input("userId", sql.UniqueIdentifier, userId);
    validateRequest.input("deviceId", sql.NVarChar(200), deviceId);

    const validation = await validateRequest.query(`
      SELECT
        IIF(EXISTS (SELECT 1 FROM sms.Users WHERE UserId = @userId), 1, 0) AS UserExists,
        IIF(EXISTS (SELECT 1 FROM sms.Devices WHERE DeviceId = @deviceId), 1, 0) AS DeviceExists;
    `);

    const flags = validation.recordset[0] || {};
    if (!flags.UserExists) {
      const error = new Error("User not found");
      error.code = "USER_NOT_FOUND";
      throw error;
    }

    if (!flags.DeviceExists) {
      const error = new Error("Device not found");
      error.code = "DEVICE_NOT_FOUND";
      throw error;
    }

    const request = new sql.Request(transaction);
    request.input("userDeviceId", sql.UniqueIdentifier, crypto.randomUUID());
    request.input("userId", sql.UniqueIdentifier, userId);
    request.input("deviceId", sql.NVarChar(200), deviceId);
    request.input("isActive", sql.Bit, isActive);

    const result = await request.query(`
      MERGE sms.UserDevices AS target
      USING (
        SELECT @userId AS UserId, @deviceId AS DeviceId
      ) AS source
      ON target.UserId = source.UserId
         AND target.DeviceId = source.DeviceId
      WHEN MATCHED THEN
        UPDATE SET
          IsActive = @isActive,
          AssignedOnUtc = CASE WHEN @isActive = 1 THEN SYSUTCDATETIME() ELSE target.AssignedOnUtc END
      WHEN NOT MATCHED THEN
        INSERT (UserDeviceId, UserId, DeviceId, IsActive, AssignedOnUtc)
        VALUES (@userDeviceId, @userId, @deviceId, @isActive, SYSUTCDATETIME())
      OUTPUT
        inserted.UserDeviceId,
        inserted.UserId,
        inserted.DeviceId,
        inserted.IsActive,
        inserted.AssignedOnUtc;
    `);

    await transaction.commit();
    return result.recordset[0];
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

module.exports = {
  listDevicesForUser,
  upsertUserDeviceAssignment,
};
