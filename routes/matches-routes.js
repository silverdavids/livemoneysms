const express = require("express");
const path = require("path");
const { requireAuth } = require("../middleware/require-auth");
const { getSessionUserById } = require("../services/auth-service");

const router = express.Router();

const MATCHES_URL = "https://mobile.smbet.info/api/PaymentMatchCandidates?top=50";

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

    return res.sendFile(path.join(__dirname, "..", "public", "matches.html"));
  } catch (error) {
    return next(error);
  }
});

router.get("/api/matches", requireAuth, async (req, res) => {
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
    return res.json(data);
  } catch (error) {
    console.error("matches api fetch error:", error);
    return res.status(500).json({ error: "Failed to fetch matches" });
  } finally {
    clearTimeout(timeoutId);
  }
});

module.exports = router;
