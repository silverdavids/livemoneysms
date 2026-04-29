const { createRequest, sql } = require("../db");

const PROVIDERS = new Set(["airtel", "mtn"]);
const DIRECTIONS = new Set(["IN", "OUT"]);
const TRANSACTION_TYPES = new Set([
  "RECEIVED",
  "SENT",
  "PAID",
  "WITHDRAWN",
  "WITHDRAWAL_REQUEST",
  "SYSTEM_CREDIT",
  "DEDUCTED",
]);

let lastCashflowCreatedOnUtc = null;

function normalizeDateInput(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function normalizeEnum(value, allowedValues, mode = "upper") {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const normalized = mode === "lower" ? text.toLowerCase() : text.toUpperCase();
  return allowedValues.has(normalized) ? normalized : "";
}

function normalizeFilters(query = {}) {
  const requestedPage = Number.parseInt(query.page, 10);
  const requestedPageSize = Number.parseInt(query.pageSize, 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pageSize = [25, 50, 100].includes(requestedPageSize) ? requestedPageSize : 50;

  return {
    dateFrom: normalizeDateInput(query.dateFrom),
    dateTo: normalizeDateInput(query.dateTo),
    provider: normalizeEnum(query.provider, PROVIDERS, "lower"),
    direction: normalizeEnum(query.direction, DIRECTIONS),
    transactionType: normalizeEnum(query.transactionType, TRANSACTION_TYPES),
    deviceId: String(query.deviceId || "").trim(),
    search: String(query.search || "").trim(),
    page,
    pageSize,
  };
}

async function initializeCashflowCursor() {
  const request = await createRequest();
  const result = await request.query(`
    SELECT DATEADD(HOUR, -36, SYSDATETIME()) AS SinceTime
  `);

  lastCashflowCreatedOnUtc = result.recordset[0]?.SinceTime || new Date();
  console.log("Cashflow cursor initialized from SQL Server time:", lastCashflowCreatedOnUtc);
}

function appendAccessScope(clauses, request, user) {
  if (user.canViewAllDevices) {
    return true;
  }

  const deviceIds = Array.isArray(user.deviceIds)
    ? user.deviceIds.map((deviceId) => String(deviceId || "").trim()).filter(Boolean)
    : [];

  if (deviceIds.length === 0) {
    clauses.push("1 = 0");
    return false;
  }

  const placeholders = [];
  for (let index = 0; index < deviceIds.length; index += 1) {
    const name = `AllowedDevice${index}`;
    placeholders.push(`@${name}`);
    request.input(name, sql.NVarChar(200), deviceIds[index]);
  }

  clauses.push(`DeviceId IN (${placeholders.join(", ")})`);
  return true;
}

function buildWhereClause(request, user, filters) {
  const clauses = ["1 = 1"];
  appendAccessScope(clauses, request, user);

  if (filters.dateFrom) {
    request.input("dateFrom", sql.Date, filters.dateFrom);
    clauses.push("SmsDate >= @dateFrom");
  }

  if (filters.dateTo) {
    request.input("dateTo", sql.Date, filters.dateTo);
    clauses.push("SmsDate < DATEADD(day, 1, @dateTo)");
  }

  if (filters.provider) {
    request.input("provider", sql.NVarChar(50), filters.provider);
    clauses.push("LOWER(Provider) = @provider");
  }

  if (filters.direction) {
    request.input("direction", sql.NVarChar(20), filters.direction);
    clauses.push("UPPER(Direction) = @direction");
  }

  if (filters.transactionType) {
    request.input("transactionType", sql.NVarChar(50), filters.transactionType);
    clauses.push("UPPER(TransactionType) = @transactionType");
  }

  if (filters.deviceId) {
    request.input("deviceId", sql.NVarChar(200), filters.deviceId);
    clauses.push("DeviceId = @deviceId");
  }

  if (filters.search) {
    request.input("search", sql.NVarChar(sql.MAX), `%${filters.search}%`);
    clauses.push(`(
      CounterpartyName LIKE @search OR
      CounterpartyPhone LIKE @search OR
      TransactionCode LIKE @search OR
      Reason LIKE @search OR
      RawBody LIKE @search
    )`);
  }

  return clauses.join("\n      AND ");
}

async function fetchNewCashflowTransactions() {
  if (!lastCashflowCreatedOnUtc) {
    await initializeCashflowCursor();
  }

  const request = await createRequest();
  request.input("since", sql.DateTime2, lastCashflowCreatedOnUtc);

  const result = await request.query(`
    SELECT TOP (100)
      MobileMoneyTransactionId,
      DeviceId,
      Provider,
      Direction,
      TransactionType,
      Amount,
      Fee,
      Tax,
      Balance,
      CounterpartyName,
      CounterpartyPhone,
      TransactionCode,
      Reason,
      RawBody,
      SmsDate,
      CreatedOnUtc
    FROM cashbook.MobileMoneyTransactions
    WHERE CreatedOnUtc > @since
    ORDER BY CreatedOnUtc ASC, MobileMoneyTransactionId ASC;
  `);

  const rows = result.recordset || [];
  if (rows.length > 0) {
    lastCashflowCreatedOnUtc = rows[rows.length - 1].CreatedOnUtc;
  }

  return rows;
}

function filterCashflowRowsForUser(rows, user) {
  if (!user) {
    return [];
  }

  if (user.canViewAllDevices) {
    return rows;
  }

  const allowedDeviceIds = new Set((user.deviceIds || []).map(String));
  return rows.filter((row) => allowedDeviceIds.has(String(row.DeviceId)));
}

async function fetchCashflowForUser(user, rawFilters = {}) {
  const filters = normalizeFilters(rawFilters);
  const request = await createRequest();
  const whereClause = buildWhereClause(request, user, filters);
  const offset = (filters.page - 1) * filters.pageSize;

  request.input("offset", sql.Int, offset);
  request.input("pageSize", sql.Int, filters.pageSize);

  const result = await request.query(`
    SELECT
      COALESCE(SUM(CASE WHEN UPPER(Direction) = 'IN' THEN ABS(COALESCE(Amount, 0)) ELSE 0 END), 0) AS TotalIn,
      COALESCE(SUM(CASE WHEN UPPER(Direction) = 'OUT' THEN ABS(COALESCE(Amount, 0)) ELSE 0 END), 0) AS TotalOut,
      COUNT(1) AS TransactionCount
    FROM cashbook.MobileMoneyTransactions
    WHERE ${whereClause};

    SELECT TOP (1)
      Balance AS LatestBalance
    FROM cashbook.MobileMoneyTransactions
    WHERE ${whereClause}
      AND Balance IS NOT NULL
    ORDER BY SmsDate DESC, CreatedOnUtc DESC;

    SELECT COUNT(1) AS TotalRows
    FROM cashbook.MobileMoneyTransactions
    WHERE ${whereClause};

    SELECT
      MobileMoneyTransactionId,
      ForwardedSmsId,
      DeviceId,
      Provider,
      Direction,
      TransactionType,
      Amount,
      Fee,
      Tax,
      Balance,
      CounterpartyName,
      CounterpartyPhone,
      TransactionCode,
      Reason,
      RawBody,
      SmsDate,
      CreatedOnUtc
    FROM cashbook.MobileMoneyTransactions
    WHERE ${whereClause}
    ORDER BY SmsDate DESC, CreatedOnUtc DESC
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
  `);

  const summaryRow = result.recordsets[0]?.[0] || {};
  const latestBalanceRow = result.recordsets[1]?.[0] || {};
  const totalRowsRow = result.recordsets[2]?.[0] || {};
  const rows = result.recordsets[3] || [];
  const totalIn = Number(summaryRow.TotalIn || 0);
  const totalOut = Number(summaryRow.TotalOut || 0);

  return {
    summary: {
      totalIn,
      totalOut,
      net: totalIn - totalOut,
      transactionCount: Number(summaryRow.TransactionCount || 0),
      latestBalance: latestBalanceRow.LatestBalance == null ? null : Number(latestBalanceRow.LatestBalance),
    },
    rows,
    page: filters.page,
    pageSize: filters.pageSize,
    totalRows: Number(totalRowsRow.TotalRows || 0),
    filters,
  };
}

module.exports = {
  initializeCashflowCursor,
  fetchNewCashflowTransactions,
  filterCashflowRowsForUser,
  fetchCashflowForUser,
  normalizeFilters,
};
