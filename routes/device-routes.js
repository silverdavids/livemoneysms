const express = require("express");
const { requireAuth } = require("../middleware/require-auth");
const { listDevicesForUser } = require("../services/device-service");

const router = express.Router();

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const rows = await listDevicesForUser(req.user);
    return res.json({ rows });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
