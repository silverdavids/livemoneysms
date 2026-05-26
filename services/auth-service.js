const bcrypt = require("bcrypt");
const { createRequest, sql } = require("../db");

function normalizePhoneUsername(username) {
  const raw = String(username || "").trim();
  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10 && digits.startsWith("0")) {
    return `256${digits.slice(1)}`;
  }

  if (digits.length === 9) {
    return `256${digits}`;
  }

  return digits || raw;
}

function mapUserRow(row) {
  if (!row) {
    return null;
  }

  return {
    userId: row.UserId,
    username: row.UserName,
    fullName: row.FullName,
    isActive: Boolean(row.IsActive),
    canViewAllDevices: Boolean(row.CanViewAllDevices),
    mustChangePassword: Boolean(row.MustChangePassword),
    passwordHash: row.PasswordHash,
    clientIds: [],
  };
}

async function getActiveClientIdsForUser(userId) {
  const request = await createRequest();
  request.input("userId", sql.UniqueIdentifier, userId);

  const result = await request.query(`
    SELECT
      ClientId
    FROM sms.DashboardUserClients
    WHERE UserId = @userId
      AND IsActive = 1
    ORDER BY ClientId;
  `);

  const clientIds = (result.recordset || []).map((row) => String(row.ClientId || "").trim()).filter(Boolean);
  console.log("auth allowed clients loaded:", { userId, count: clientIds.length });
  return clientIds;
}

async function getSessionUserById(userId) {
  const request = await createRequest();
  request.input("userId", sql.UniqueIdentifier, userId);

  const result = await request.query(`
    SELECT TOP (1)
      u.UserId,
      u.UserName,
      u.FullName,
      u.PasswordHash,
      u.IsActive,
      u.CanViewAllDevices,
      u.MustChangePassword
    FROM sms.Users u
    WHERE u.UserId = @userId
      AND u.IsActive = 1
  `);

  const user = mapUserRow(result.recordset[0]);
  if (!user) {
    return null;
  }

  user.clientIds = user.canViewAllDevices ? [] : await getActiveClientIdsForUser(user.userId);
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
      u.PasswordHash,
      u.IsActive,
      u.CanViewAllDevices,
      u.MustChangePassword
    FROM sms.Users u
    WHERE u.UserName = @username
      AND u.IsActive = 1
  `);

  const user = mapUserRow(result.recordset[0]);
  console.log("auth user lookup:", { username, found: Boolean(user) });
  if (!user) {
    return null;
  }

  user.clientIds = user.canViewAllDevices ? [] : await getActiveClientIdsForUser(user.userId);
  return user;
}

async function authenticateUser(username, password) {
  const normalizedUsername = normalizePhoneUsername(username);
  console.log("auth login attempt:", {
    usernameRaw: String(username || "").trim(),
    usernameNormalized: normalizedUsername,
  });

  const user = await getUserByUsername(normalizedUsername);
  if (!user) {
    return null;
  }

  try {
    const isValid = await bcrypt.compare(password, String(user.passwordHash || ""));
    console.log("auth bcrypt result:", {
      usernameNormalized: normalizedUsername,
      valid: isValid,
      canViewAllDevices: user.canViewAllDevices,
      allowedClientCount: user.clientIds.length,
    });
    return isValid ? user : null;
  } catch {
    console.log("auth bcrypt result:", {
      usernameNormalized: normalizedUsername,
      valid: false,
      canViewAllDevices: user.canViewAllDevices,
      allowedClientCount: user.clientIds.length,
    });
    return null;
  }
}

async function changePassword(userId, newPassword) {
  const passwordHash = await bcrypt.hash(newPassword, 10);
  const request = await createRequest();
  request.input("userId", sql.UniqueIdentifier, userId);
  request.input("passwordHash", sql.NVarChar(sql.MAX), passwordHash);

  await request.query(`
    UPDATE sms.Users
    SET PasswordHash = @passwordHash,
        MustChangePassword = 0
    WHERE UserId = @userId
      AND IsActive = 1;
  `);
}

function toPublicUser(user) {
  return {
    userId: user.userId,
    userName: user.username,
    username: user.username,
    name: user.fullName || user.username,
    fullName: user.fullName,
    canViewAll: user.canViewAllDevices,
    canViewAllDevices: user.canViewAllDevices,
    mustChangePassword: user.mustChangePassword,
    clientIds: user.clientIds,
  };
}

module.exports = {
  authenticateUser,
  changePassword,
  getSessionUserById,
  normalizePhoneUsername,
  toPublicUser,
};
