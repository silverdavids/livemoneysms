const express = require("express");
const path = require("path");
const { requireAuth, requirePasswordChanged } = require("../middleware/require-auth");
const { getSessionUserById } = require("../services/auth-service");

const router = express.Router();

const MATCHES_URL = "https://mobile.smbet.info/api/PaymentMatchCandidates?top=50";
const MATCHES_BASE_URL = "https://mobile.smbet.info/api/PaymentMatchCandidates";

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
  return row?.clientId ?? row?.ClientId ?? row?.businessClientId ?? row?.BusinessClientId ?? row?.merchantClientId ?? row?.MerchantClientId ?? null;
}

function filterPayloadForUser(payload, user) {
  if (user.canViewAllDevices) {
    return payload;
  }

  const allowedClientIds = new Set((user.clientIds || []).map(String));
  const filteredRows = normalizeRows(payload).filter((row) => {
    const clientId = getCandidateClientId(row);
    return clientId != null && allowedClientIds.has(String(clientId));
  });

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

router.get("/api/matches", requireAuth, requirePasswordChanged, async (req, res) => {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 15000);

  try {
    const response = await fetch(MATCHES_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: abortController.signal,
    });

    if (!response.ok) {
      console.error("matches api request failed:", response.status, response.statusText);
      return res.status(500).json({ error: "Failed to fetch matches" });
    }

    const data = await response.json();
    return res.json(filterPayloadForUser(data, req.user));
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
