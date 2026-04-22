const { createRequest, sql } = require("../db");

let lastCreatedOnUtc = null;

async function initializeMessageCursor() {
  const request = await createRequest();
  const result = await request.query(`
    SELECT DATEADD(HOUR, -36, SYSDATETIME()) AS SinceTime
  `);

  lastCreatedOnUtc = result.recordset[0]?.SinceTime || new Date();
  console.log("Cursor initialized from SQL Server time:", lastCreatedOnUtc);
}

async function fetchMessagesForUser(userId, top = 200) {
  const request = await createRequest();
  request.input("UserId", sql.UniqueIdentifier, userId);
  request.input("Top", sql.Int, top);

  const result = await request.execute("sms.GetForwardedSmsForUser");
  return result.recordset || [];
}

async function fetchNewMessages() {
  if (!lastCreatedOnUtc) {
    await initializeMessageCursor();
  }

  const request = await createRequest();
  request.input("since", sql.DateTime2, lastCreatedOnUtc);

  const result = await request.query(`
    SELECT TOP (100)
      ForwardedSmsId,
      DeviceId,
      [From],
      Body,
      SmsDate,
      ProviderHint,
      CorrelationId,
      BodyHash,
      CreatedOnUtc,
      RawJson
    FROM sms.ForwardedSms
    WHERE CreatedOnUtc > @since
    ORDER BY CreatedOnUtc ASC;
  `);

  const rows = result.recordset || [];
  if (rows.length > 0) {
    lastCreatedOnUtc = rows[rows.length - 1].CreatedOnUtc;
  }

  return rows;
}

function filterMessagesForUser(rows, user) {
  if (!user) {
    return [];
  }

  if (user.canViewAllDevices) {
    return rows;
  }

  const allowedDeviceIds = new Set((user.deviceIds || []).map(String));
  return rows.filter((row) => allowedDeviceIds.has(String(row.DeviceId)));
}

module.exports = {
  initializeMessageCursor,
  fetchMessagesForUser,
  fetchNewMessages,
  filterMessagesForUser,
};
