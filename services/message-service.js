const { createRequest, sql } = require("../db");

let lastCreatedOnUtc = null;
let mobileMoneyColumnsPromise = null;
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

async function getMobileMoneyColumns() {
  if (!mobileMoneyColumnsPromise) {
    mobileMoneyColumnsPromise = getTableColumns("cashbook", "MobileMoneyTransactions").catch((error) => {
      mobileMoneyColumnsPromise = null;
      throw error;
    });
  }

  return mobileMoneyColumnsPromise;
}

function safeMobileMoneySelect(columns, columnName, fallbackSql, alias = columnName) {
  return columns.has(columnName)
    ? `t.${columnName} AS ${alias}`
    : `${fallbackSql} AS ${alias}`;
}

function selectExistingColumn(columns, candidates) {
  return candidates.find((candidate) => columns.has(candidate)) || null;
}

function sqlNull(alias, type = "nvarchar(255)") {
  return `CAST(NULL AS ${type}) AS ${alias}`;
}

async function fetchMobileMoneyDetailsByForwardedSmsIds(forwardedSmsIds) {
  const ids = [...new Set((forwardedSmsIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (ids.length === 0) {
    return new Map();
  }

  const columns = await getMobileMoneyColumns();
  if (!columns.has("ForwardedSmsId")) {
    return new Map();
  }

  const request = await createRequest();
  const placeholders = [];

  for (let index = 0; index < ids.length; index += 1) {
    const name = `ForwardedSmsId${index}`;
    placeholders.push(`@${name}`);
    request.input(name, sql.NVarChar(200), ids[index]);
  }

  const result = await request.query(`
    WITH RankedTransactions AS (
      SELECT
        ${safeMobileMoneySelect(columns, "MobileMoneyTransactionId", "CAST(NULL AS nvarchar(100))")},
        t.ForwardedSmsId,
        ${safeMobileMoneySelect(columns, "ClientId", "CAST(NULL AS nvarchar(100))", "TransactionClientId")},
        ${safeMobileMoneySelect(columns, "TransactionCode", "CAST(NULL AS nvarchar(200))")},
        ${safeMobileMoneySelect(columns, "Amount", "CAST(NULL AS decimal(18, 2))")},
        ${safeMobileMoneySelect(columns, "Provider", "CAST(NULL AS nvarchar(50))")},
        ${safeMobileMoneySelect(columns, "Direction", "CAST(NULL AS nvarchar(30))")},
        ${safeMobileMoneySelect(columns, "CounterpartyPhone", "CAST(NULL AS nvarchar(100))")},
        ${safeMobileMoneySelect(columns, "CounterpartyName", "CAST(NULL AS nvarchar(255))")},
        ${safeMobileMoneySelect(columns, "ReferenceText", "CAST(NULL AS nvarchar(1000))")},
        ${safeMobileMoneySelect(columns, "ParsedTransferId", "CAST(NULL AS nvarchar(100))")},
        ${safeMobileMoneySelect(columns, "MatchStatus", "CAST(NULL AS nvarchar(100))")},
        ${safeMobileMoneySelect(columns, "MatchMethod", "CAST(NULL AS nvarchar(100))")},
        ${safeMobileMoneySelect(columns, "MatchCandidateType", "CAST(NULL AS nvarchar(100))")},
        ${safeMobileMoneySelect(columns, "SmsDate", "CAST(NULL AS datetime2)")},
        ${safeMobileMoneySelect(columns, "CreatedOnUtc", "CAST(NULL AS datetime2)", "MobileMoneyCreatedOnUtc")},
        ROW_NUMBER() OVER (
          PARTITION BY t.ForwardedSmsId
          ORDER BY
            ${columns.has("CreatedOnUtc") ? "t.CreatedOnUtc DESC" : "t.ForwardedSmsId DESC"},
            ${columns.has("MobileMoneyTransactionId") ? "t.MobileMoneyTransactionId DESC" : "t.ForwardedSmsId DESC"}
        ) AS RowNum
      FROM cashbook.MobileMoneyTransactions t
      WHERE CONVERT(nvarchar(200), t.ForwardedSmsId) IN (${placeholders.join(", ")})
    )
    SELECT
      MobileMoneyTransactionId,
      ForwardedSmsId,
      TransactionClientId,
      TransactionCode,
      Amount,
      Provider,
      Direction,
      CounterpartyPhone,
      CounterpartyName,
      ReferenceText,
      ParsedTransferId,
      MatchStatus,
      MatchMethod,
      MatchCandidateType,
      SmsDate,
      MobileMoneyCreatedOnUtc
    FROM RankedTransactions
    WHERE RowNum = 1;
  `);

  const detailsByForwardedSmsId = new Map();
  for (const row of result.recordset || []) {
    detailsByForwardedSmsId.set(String(row.ForwardedSmsId), row);
  }

  return detailsByForwardedSmsId;
}

async function fetchClientDetailsByForwardedSmsIds(forwardedSmsIds) {
  const ids = [...new Set((forwardedSmsIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (ids.length === 0) {
    return new Map();
  }

  const [
    forwardedSmsColumns,
    mobileMoneyColumns,
    clientColumns,
    clientDeviceColumns,
  ] = await Promise.all([
    getTableColumns("sms", "ForwardedSms"),
    getMobileMoneyColumns(),
    getTableColumns("sms", "Clients"),
    getTableColumns("sms", "ClientDevices"),
  ]);

  if (!forwardedSmsColumns.has("ForwardedSmsId")) {
    return new Map();
  }

  const canUseClients = clientColumns.has("ClientId");
  const canUseClientDevices = clientDeviceColumns.has("ClientId");
  const forwardedClientSelect = forwardedSmsColumns.has("ClientId")
    ? "f.ClientId"
    : "CAST(NULL AS nvarchar(100))";
  const transactionClientSelect = mobileMoneyColumns.has("ClientId")
    ? "rt.TransactionClientId"
    : "CAST(NULL AS nvarchar(100))";
  const effectiveClientSql = `COALESCE(CONVERT(nvarchar(100), ${forwardedClientSelect}), CONVERT(nvarchar(100), ${transactionClientSelect}))`;

  const clientNameColumn = selectExistingColumn(clientColumns, ["BusinessName", "ClientName", "Name"]);
  const clientTypeColumn = selectExistingColumn(clientColumns, ["BusinessType", "ClientType", "Type"]);
  const deviceNameColumn = selectExistingColumn(clientDeviceColumns, ["DeviceName", "Name"]);
  const devicePhoneColumn = selectExistingColumn(clientDeviceColumns, ["DevicePhone", "PhoneNumber", "Phone", "Msisdn", "DeviceMsisdn"]);
  const lastSeenColumn = selectExistingColumn(clientDeviceColumns, ["LastSeenOnUtc", "LastSeenUtc", "LastSeen"]);
  const clientDeviceDeviceIdColumn = selectExistingColumn(clientDeviceColumns, ["DeviceId", "ForwardingDeviceId"]);

  const request = await createRequest();
  const placeholders = [];

  for (let index = 0; index < ids.length; index += 1) {
    const name = `ForwardedSmsId${index}`;
    placeholders.push(`@${name}`);
    request.input(name, sql.NVarChar(200), ids[index]);
  }

  const mobileMoneyCte = mobileMoneyColumns.has("ForwardedSmsId")
    ? `
    RankedTransactions AS (
      SELECT
        t.ForwardedSmsId,
        ${mobileMoneyColumns.has("ClientId") ? "t.ClientId" : "CAST(NULL AS nvarchar(100))"} AS TransactionClientId,
        ROW_NUMBER() OVER (
          PARTITION BY t.ForwardedSmsId
          ORDER BY
            ${mobileMoneyColumns.has("CreatedOnUtc") ? "t.CreatedOnUtc DESC" : "t.ForwardedSmsId DESC"},
            ${mobileMoneyColumns.has("MobileMoneyTransactionId") ? "t.MobileMoneyTransactionId DESC" : "t.ForwardedSmsId DESC"}
        ) AS RowNum
      FROM cashbook.MobileMoneyTransactions t
      WHERE CONVERT(nvarchar(200), t.ForwardedSmsId) IN (${placeholders.join(", ")})
    )`
    : `
    RankedTransactions AS (
      SELECT
        CAST(NULL AS nvarchar(200)) AS ForwardedSmsId,
        CAST(NULL AS nvarchar(100)) AS TransactionClientId,
        CAST(1 AS int) AS RowNum
      WHERE 1 = 0
    )`;

  const clientJoin = canUseClients
    ? `
    LEFT JOIN sms.Clients c
      ON CONVERT(nvarchar(100), c.ClientId) = ${effectiveClientSql}`
    : "";

  const clientDeviceApply = canUseClientDevices
    ? `
    OUTER APPLY (
      SELECT TOP (1)
        ${deviceNameColumn ? `cd.${deviceNameColumn}` : "CAST(NULL AS nvarchar(255))"} AS DeviceName,
        ${devicePhoneColumn ? `cd.${devicePhoneColumn}` : "CAST(NULL AS nvarchar(100))"} AS DevicePhone,
        ${lastSeenColumn ? `cd.${lastSeenColumn}` : "CAST(NULL AS datetime2)"} AS LastSeenOnUtc
      FROM sms.ClientDevices cd
      WHERE CONVERT(nvarchar(100), cd.ClientId) = ${effectiveClientSql}
      ORDER BY
        ${clientDeviceDeviceIdColumn && forwardedSmsColumns.has("DeviceId") ? `CASE WHEN CONVERT(nvarchar(200), cd.${clientDeviceDeviceIdColumn}) = CONVERT(nvarchar(200), f.DeviceId) THEN 0 ELSE 1 END,` : ""}
        ${lastSeenColumn ? `cd.${lastSeenColumn} DESC` : "DeviceName ASC"}
    ) cd`
    : "";

  const result = await request.query(`
    WITH ${mobileMoneyCte}
    SELECT
      f.ForwardedSmsId,
      ${forwardedSmsColumns.has("ClientId") ? "f.ClientId" : "CAST(NULL AS nvarchar(100))"} AS ForwardedSmsClientId,
      rt.TransactionClientId,
      ${effectiveClientSql} AS ClientId,
      ${canUseClients && clientNameColumn ? `c.${clientNameColumn} AS BusinessName` : sqlNull("BusinessName")},
      ${canUseClients && clientTypeColumn ? `c.${clientTypeColumn} AS BusinessType` : sqlNull("BusinessType", "nvarchar(100)")},
      ${canUseClientDevices ? "cd.DeviceName" : sqlNull("DeviceName")},
      ${canUseClientDevices ? "cd.DevicePhone" : sqlNull("DevicePhone", "nvarchar(100)")},
      ${canUseClientDevices ? "cd.LastSeenOnUtc" : "CAST(NULL AS datetime2) AS LastSeenOnUtc"}
    FROM sms.ForwardedSms f
    LEFT JOIN RankedTransactions rt
      ON CONVERT(nvarchar(200), rt.ForwardedSmsId) = CONVERT(nvarchar(200), f.ForwardedSmsId)
     AND rt.RowNum = 1
    ${clientJoin}
    ${clientDeviceApply}
    WHERE CONVERT(nvarchar(200), f.ForwardedSmsId) IN (${placeholders.join(", ")});
  `);

  const detailsByForwardedSmsId = new Map();
  for (const row of result.recordset || []) {
    const hasClient = Boolean(row.ClientId);
    detailsByForwardedSmsId.set(String(row.ForwardedSmsId), {
      ...row,
      BusinessName: hasClient ? (row.BusinessName || "Registered Business") : "Unregistered / Legacy Device",
      BusinessType: hasClient ? row.BusinessType : "Legacy",
    });
  }

  return detailsByForwardedSmsId;
}

async function enrichMessagesWithMobileMoney(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return rows || [];
  }

  try {
    const forwardedSmsIds = rows.map((row) => row.ForwardedSmsId);
    const [detailsByForwardedSmsId, clientDetailsByForwardedSmsId] = await Promise.all([
      fetchMobileMoneyDetailsByForwardedSmsIds(forwardedSmsIds),
      fetchClientDetailsByForwardedSmsIds(forwardedSmsIds),
    ]);

    return rows.map((row) => ({
      ...row,
      ...(detailsByForwardedSmsId.get(String(row.ForwardedSmsId)) || {}),
      ...(clientDetailsByForwardedSmsId.get(String(row.ForwardedSmsId)) || {
        BusinessName: "Unregistered / Legacy Device",
        BusinessType: "Legacy",
      }),
    }));
  } catch (error) {
    console.error("message enrichment error:", error);
    return rows.map((row) => ({
      ...row,
      BusinessName: row.BusinessName || "Unregistered / Legacy Device",
      BusinessType: row.BusinessType || "Legacy",
    }));
  }
}

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
  return enrichMessagesWithMobileMoney(result.recordset || []);
}

async function fetchNewMessages() {
  if (!lastCreatedOnUtc) {
    await initializeMessageCursor();
  }

  const request = await createRequest();
  request.input("since", sql.DateTime2, lastCreatedOnUtc);
  const forwardedSmsColumns = await getTableColumns("sms", "ForwardedSms");

  const result = await request.query(`
    SELECT TOP (100)
      ForwardedSmsId,
      DeviceId,
      ${forwardedSmsColumns.has("ClientId") ? "ClientId," : ""}
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

  return enrichMessagesWithMobileMoney(rows);
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
