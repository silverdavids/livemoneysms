const bcrypt = require("bcrypt");
const { createRequest, sql } = require("../db");

function mapUserRow(row) {
  if (!row) {
    return null;
  }

  return {
    userId: row.UserId,
    username: row.UserName,
    fullName: row.FullName,
    email: row.Email,
    isActive: Boolean(row.IsActive),
    canViewAllDevices: Boolean(row.CanViewAllDevices),
    passwordHash: row.PasswordHash,
    createdOnUtc: row.CreatedOnUtc,
    deviceIds: [],
  };
}

async function getActiveDeviceIdsForUser(userId) {
  const request = await createRequest();
  request.input("userId", sql.UniqueIdentifier, userId);

  const result = await request.query(`
    SELECT
      DeviceId
    FROM sms.UserDevices
    WHERE UserId = @userId
      AND IsActive = 1
    ORDER BY DeviceId;
  `);

  return (result.recordset || []).map((row) => row.DeviceId).filter(Boolean);
}

async function getSessionUserById(userId) {
  const request = await createRequest();
  request.input("userId", sql.UniqueIdentifier, userId);

  const result = await request.query(`
    SELECT TOP (1)
      u.UserId,
      u.UserName,
      u.FullName,
      u.Email,
      u.PasswordHash,
      u.IsActive,
      u.CanViewAllDevices,
      u.CreatedOnUtc
    FROM sms.Users u
    WHERE u.UserId = @userId
      AND u.IsActive = 1
    ORDER BY u.CreatedOnUtc DESC;
  `);

  const user = mapUserRow(result.recordset[0]);
  if (!user) {
    return null;
  }

  user.deviceIds = await getActiveDeviceIdsForUser(user.userId);
  return user;
}

async function getUserByUsername(username) {
  const request = await createRequest();
  request.input("username", sql.NVarChar(256), username);

  const result = await request.query(`
    SELECT TOP (1)
      u.UserId,
      u.UserName,
      u.FullName,
      u.Email,
      u.PasswordHash,
      u.IsActive,
      u.CanViewAllDevices,
      u.CreatedOnUtc
    FROM sms.Users u
    WHERE LOWER(u.UserName) = LOWER(@username)
      AND u.IsActive = 1
    ORDER BY u.CreatedOnUtc DESC;
  `);

  const user = mapUserRow(result.recordset[0]);
  if (!user) {
    return null;
  }

  user.deviceIds = await getActiveDeviceIdsForUser(user.userId);
  return user;
}

async function authenticateUser(username, password) {
  const user = await getUserByUsername(username);
  if (!user) {
    return null;
  }

  try {
    const isValid = await bcrypt.compare(password, String(user.passwordHash || ""));
    return isValid ? user : null;
  } catch {
    return null;
  }
}

function toPublicUser(user) {
  return {
    userId: user.userId,
    username: user.username,
    name: user.fullName || user.username,
    fullName: user.fullName,
    email: user.email,
    canViewAll: user.canViewAllDevices,
    canViewAllDevices: user.canViewAllDevices,
    deviceIds: user.deviceIds,
  };
}

module.exports = {
  authenticateUser,
  getSessionUserById,
  toPublicUser,
};
