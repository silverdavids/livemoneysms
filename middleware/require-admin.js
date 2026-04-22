function requireAdmin(req, res, next) {
  if (!req.user?.canViewAllDevices) {
    return res.status(403).json({ error: "Admin access required" });
  }

  return next();
}

module.exports = {
  requireAdmin,
};
