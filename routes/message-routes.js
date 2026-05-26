const express = require("express");
const { requireAuth, requirePasswordChanged } = require("../middleware/require-auth");
const { fetchMessagesForUser } = require("../services/message-service");

const router = express.Router();

router.get("/", requireAuth, requirePasswordChanged, async (req, res, next) => {
  try {
    const requestedTop = Number(req.query.top || 200);
    const top = Number.isFinite(requestedTop) ? Math.min(Math.max(requestedTop, 1), 500) : 200;
    const rows = await fetchMessagesForUser(req.user, top);
    return res.json({ rows });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
