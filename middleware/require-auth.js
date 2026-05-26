const { getSessionUserById } = require("../services/auth-service");

async function requireAuth(req, res, next) {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const user = await getSessionUserById(userId);
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: "Authentication required" });
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requirePasswordChanged(req, res, next) {
  if (req.user?.mustChangePassword) {
    return res.status(403).json({
      error: "Password change required",
      code: "PASSWORD_CHANGE_REQUIRED",
      redirectTo: "/change-password",
    });
  }

  return next();
}

module.exports = {
  requireAuth,
  requirePasswordChanged,
};
