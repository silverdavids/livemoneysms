const crypto = require("crypto");
const { getPool, createRequest, sql } = require("../db");

async function listDevicesForUser(user) {
  const request = await createRequest();
  request.input("userId", sql.UniqueIdentifier, user.userId);
  request.input("canViewAllDevices", sql.Bit, user.canViewAllDevices);

  const result = await request.query(`
    SELECT
      d.DeviceId,
      d.DeviceName,
      d.Description,
      d.IsActive,
      d.CreatedOnUtc,
      CASE WHEN ud.UserDeviceId IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS IsAssignedToUser
    FROM sms.Devices d
    LEFT JOIN sms.UserDevices ud
      ON ud.DeviceId = d.DeviceId
     AND ud.UserId = @userId
     AND ud.IsActive = 1
    WHERE d.IsActive = 1
      AND (
        @canViewAllDevices = 1
        OR ud.UserDeviceId IS NOT NULL
      )
    ORDER BY d.DeviceId;
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
