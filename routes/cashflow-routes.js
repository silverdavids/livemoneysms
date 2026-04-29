const express = require("express");
const path = require("path");
const { requireAuth } = require("../middleware/require-auth");
const { getSessionUserById } = require("../services/auth-service");
const { fetchCashflowForUser } = require("../services/cashflow-service");

const router = express.Router();

router.get("/cashflow", async (req, res, next) => {
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

    return res.sendFile(path.join(__dirname, "..", "public", "cashflow.html"));
  } catch (error) {
    return next(error);
  }
});

router.get("/api/cashflow", requireAuth, async (req, res, next) => {
  try {
    const data = await fetchCashflowForUser(req.user, req.query);
    return res.json(data);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
