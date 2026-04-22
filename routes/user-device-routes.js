const express = require("express");
const { requireAuth } = require("../middleware/require-auth");
const { requireAdmin } = require("../middleware/require-admin");
const { upsertUserDeviceAssignment } = require("../services/device-service");

const router = express.Router();

router.post("/", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const deviceId = String(req.body?.deviceId || "").trim();
    const isActive = req.body?.isActive !== false;

    if (!userId || !deviceId) {
      return res.status(400).json({ error: "userId and deviceId are required" });
    }

    const row = await upsertUserDeviceAssignment({ userId, deviceId, isActive });
    return res.status(201).json({ row });
  } catch (error) {
    if (error.code === "USER_NOT_FOUND" || error.code === "DEVICE_NOT_FOUND") {
      return res.status(404).json({ error: error.message });
    }

    return next(error);
  }
});

module.exports = router;
