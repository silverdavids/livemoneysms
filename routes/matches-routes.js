const express = require("express");
const path = require("path");
const { createRequest, sql } = require("../db");
const { requireAuth, requirePasswordChanged } = require("../middleware/require-auth");
const { getSessionUserById } = require("../services/auth-service");

const router = express.Router();

const MATCHES_URL = "https://mobile.smbet.info/api/PaymentMatchCandidates?top=50";
const MATCHES_BASE_URL = "https://mobile.smbet.info/api/PaymentMatchCandidates";
const TARGET_SMART_BET_CLIENT_ID = "2229718a-5d39-4df0-a1d5-4194821d9789";

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

function normalizeIdentifier(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeIdentifierList(values) {
  return [...new Set((values || []).map(normalizeIdentifier).filter(Boolean))];
}

router.get("/matches", async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.redirect("/");
    }

    const user = await getSessionUserById(userId);
    if (!user) {
      req.session?.destroy(() => {});
      return res.redirect("/");
    }
    if (user.mustChangePassword) {
      return res.redirect("/change-password");
    }

    return res.sendFile(path.join(__dirname, "..", "public", "matches.html"));
  } catch (error) {
    return next(error);
  }
});

function normalizeRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function getCandidateClientId(row) {
  return row?.clientId ?? row?.ClientId ?? row?.clientID ?? row?.CLIENTID ?? row?.businessClientId ?? row?.BusinessClientId ?? row?.merchantClientId ?? row?.MerchantClientId ?? null;
}

function getCandidateDeviceId(row) {
  return row?.deviceId ?? row?.DeviceId ?? row?.forwardingDeviceId ?? row?.ForwardingDeviceId ?? row?.sourceDeviceId ?? row?.SourceDeviceId ?? null;
}

function getCandidateExternalTransferId(row) {
  return row?.externalTransferId ?? row?.ExternalTransferId ?? row?.transferId ?? row?.TransferId ?? null;
}

function getCandidateMatchStatus(row) {
  return row?.matchStatus ?? row?.MatchStatus ?? row?.status ?? row?.Status ?? null;
}

async function getLinkedClientIds(user) {
  if (user.canViewAllDevices) {
    return normalizeIdentifierList(user.clientIds);
  }

  const request = await createRequest();
  request.input("userId", sql.UniqueIdentifier, user.userId);

  const result = await request.query(`
    SELECT ClientId
    FROM sms.DashboardUserClients
    WHERE UserId = @userId
      AND IsActive = 1
    ORDER BY ClientId;
  `);

  return normalizeIdentifierList((result.recordset || []).map((row) => row.ClientId));
}

async function isOwnerForAnyClient(user, clientIds) {
  if (clientIds.length === 0) {
    return false;
  }

  const columns = await getTableColumns("sms", "DashboardUserClients");
  const ownerColumn = selectExistingColumn(columns, ["IsOwner", "IsClientOwner", "IsPrimaryOwner", "IsPrimary"]);
  if (!ownerColumn) {
    return clientIds.length > 0;
  }

  const request = await createRequest();
  request.input("userId", sql.UniqueIdentifier, user.userId);
  const placeholders = [];

  for (let index = 0; index < clientIds.length; index += 1) {
    const name = `ClientId${index}`;
    placeholders.push(`@${name}`);
    request.input(name, sql.UniqueIdentifier, clientIds[index]);
  }

  const result = await request.query(`
    SELECT TOP (1) 1 AS IsOwner
    FROM sms.DashboardUserClients
    WHERE UserId = @userId
      AND IsActive = 1
      AND ${ownerColumn} = 1
      AND ClientId IN (${placeholders.join(", ")});
  `);

  return Boolean(result.recordset?.[0]?.IsOwner);
}

async function getActiveClientDeviceIds(clientIds) {
  if (clientIds.length === 0) {
    return [];
  }

  const columns = await getTableColumns("sms", "ClientDevices");
  const deviceIdColumn = selectExistingColumn(columns, ["DeviceId", "ForwardingDeviceId", "ClientDeviceId"]);
  if (!deviceIdColumn || !columns.has("ClientId")) {
    return [];
  }

  const request = await createRequest();
  const placeholders = [];

  for (let index = 0; index < clientIds.length; index += 1) {
    const name = `ClientId${index}`;
    placeholders.push(`@${name}`);
    request.input(name, sql.UniqueIdentifier, clientIds[index]);
  }

  const activeClause = columns.has("IsActive") ? "AND IsActive = 1" : "";
  const result = await request.query(`
    SELECT DISTINCT CONVERT(nvarchar(100), ${deviceIdColumn}) AS DeviceId
    FROM sms.ClientDevices
    WHERE ClientId IN (${placeholders.join(", ")})
      ${activeClause};
  `);

  return normalizeIdentifierList((result.recordset || []).map((row) => row.DeviceId));
}

async function getAllActiveClientDeviceIds() {
  const columns = await getTableColumns("sms", "ClientDevices");
  const deviceIdColumn = selectExistingColumn(columns, ["DeviceId", "ForwardingDeviceId", "ClientDeviceId"]);
  if (!deviceIdColumn) {
    return [];
  }

  const request = await createRequest();
  const activeClause = columns.has("IsActive") ? "WHERE IsActive = 1" : "";
  const result = await request.query(`
    SELECT DISTINCT CONVERT(nvarchar(100), ${deviceIdColumn}) AS DeviceId
    FROM sms.ClientDevices
    ${activeClause};
  `);

  return normalizeIdentifierList((result.recordset || []).map((row) => row.DeviceId));
}

async function getActiveUserDeviceIds(user) {
  const columns = await getTableColumns("sms", "UserDevices");
  if (!columns.has("DeviceId") || !columns.has("UserId")) {
    return [];
  }

  const request = await createRequest();
  request.input("userId", sql.UniqueIdentifier, user.userId);

  const activeClause = columns.has("IsActive") ? "AND IsActive = 1" : "";
  const result = await request.query(`
    SELECT DISTINCT CONVERT(nvarchar(100), DeviceId) AS DeviceId
    FROM sms.UserDevices
    WHERE UserId = @userId
      ${activeClause};
  `);

  return normalizeIdentifierList((result.recordset || []).map((row) => row.DeviceId));
}

async function resolveMatchVisibility(user) {
  const clientIds = user.canViewAllDevices
    ? normalizeIdentifierList(user.clientIds)
    : await getLinkedClientIds(user);
  const isOwner = await isOwnerForAnyClient(user, clientIds);
  const deviceIds = user.canViewAllDevices && clientIds.length === 0
    ? await getAllActiveClientDeviceIds()
    : (user.canViewAllDevices || isOwner)
    ? await getActiveClientDeviceIds(clientIds)
    : await getActiveUserDeviceIds(user);

  return {
    clientIds,
    deviceIds,
    isOwner,
    roles: {
      canViewAllDevices: Boolean(user.canViewAllDevices),
      isOwner,
    },
  };
}

function filterPayloadForUser(payload, user, visibility) {
  const rows = normalizeRows(payload);
  const allowedClientIds = new Set(visibility.clientIds);
  const visibleDeviceIds = new Set(visibility.deviceIds);

  let filteredRows;
  if (user.canViewAllDevices && allowedClientIds.size === 0) {
    filteredRows = rows;
  } else {
    filteredRows = rows.filter((row) => {
      const clientId = normalizeIdentifier(getCandidateClientId(row));
      const deviceId = normalizeIdentifier(getCandidateDeviceId(row));
      const status = String(getCandidateMatchStatus(row) || "").trim().toLowerCase();
      const externalTransferId = String(getCandidateExternalTransferId(row) || "").trim();

      if (!clientId || !allowedClientIds.has(clientId)) {
        return false;
      }

      if ((user.canViewAllDevices || visibility.isOwner) && status === "candidate" && externalTransferId) {
        return true;
      }

      return !deviceId || visibleDeviceIds.has(deviceId);
    });
  }

  if (Array.isArray(payload)) {
    return filteredRows;
  }
  if (Array.isArray(payload?.rows)) {
    return { ...payload, rows: filteredRows };
  }
  if (Array.isArray(payload?.data)) {
    return { ...payload, data: filteredRows };
  }
  if (Array.isArray(payload?.items)) {
    return { ...payload, items: filteredRows };
  }
  return { rows: filteredRows };
}

function setNoCacheHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
}

router.get("/api/matches", requireAuth, requirePasswordChanged, async (req, res) => {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 15000);
  setNoCacheHeaders(res);

  try {
    const visibility = await resolveMatchVisibility(req.user);
    const response = await fetch(MATCHES_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
      signal: abortController.signal,
    });

    if (!response.ok) {
      console.error("matches api request failed:", response.status, response.statusText);
      return res.status(500).json({ error: "Failed to fetch matches" });
    }

    const data = await response.json();
    const rows = normalizeRows(data);
    const filteredPayload = filterPayloadForUser(data, req.user, visibility);
    const filteredRows = normalizeRows(filteredPayload);
    const transfer16141 = rows.find((row) => String(getCandidateExternalTransferId(row) || "") === "16141");

    console.log("matches visibility:", {
      userId: req.user.userId,
      username: req.user.username,
      roles: visibility.roles,
      resolvedClientIds: visibility.clientIds,
      smartBetClientLinked: visibility.clientIds.includes(TARGET_SMART_BET_CLIENT_ID),
      visibleDeviceIds: visibility.deviceIds,
      sourceCount: rows.length,
      resultCount: filteredRows.length,
      transfer16141: transfer16141 ? {
        clientId: getCandidateClientId(transfer16141),
        deviceId: getCandidateDeviceId(transfer16141),
        matchStatus: getCandidateMatchStatus(transfer16141),
        externalTransferId: getCandidateExternalTransferId(transfer16141),
      } : null,
      candidateClientIds: normalizeIdentifierList(rows.map(getCandidateClientId)).slice(0, 25),
    });

    return res.status(200).json(filteredPayload);
  } catch (error) {
    console.error("matches api fetch error:", error);
    return res.status(500).json({ error: "Failed to fetch matches" });
  } finally {
    clearTimeout(timeoutId);
  }
});

async function proxyMatchAction(req, res, action) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 15000);

  try {
    const id = encodeURIComponent(String(req.params.id || "").trim());
    if (!id) {
      return res.status(400).json({ error: "Match id is required" });
    }

    const response = await fetch(`${MATCHES_BASE_URL}/${id}/${action}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
      },
      signal: abortController.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`matches ${action} request failed:`, response.status, response.statusText, body);
      return res.status(500).json({ error: `Failed to ${action} match` });
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      return res.json(data);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(`matches ${action} fetch error:`, error);
    return res.status(500).json({ error: `Failed to ${action} match` });
  } finally {
    clearTimeout(timeoutId);
  }
}

router.post("/api/matches/:id/confirm", requireAuth, requirePasswordChanged, async (req, res) => {
  return proxyMatchAction(req, res, "confirm");
});

router.post("/api/matches/:id/reject", requireAuth, requirePasswordChanged, async (req, res) => {
  return proxyMatchAction(req, res, "reject");
});

module.exports = router;
