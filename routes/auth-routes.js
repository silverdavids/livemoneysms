const express = require("express");
const {
  authenticateUser,
  changePassword,
  getSessionUserById,
  toPublicUser,
} = require("../services/auth-service");
const { requireAuth } = require("../middleware/require-auth");

const router = express.Router();

router.post("/login", async (req, res, next) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    const user = await authenticateUser(username, password);
    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    return req.session.regenerate((sessionError) => {
      if (sessionError) {
        return next(sessionError);
      }

      req.session.userId = user.userId;
      req.session.user = {
        userId: user.userId,
        userName: user.username,
        fullName: user.fullName,
        canViewAllDevices: user.canViewAllDevices,
        mustChangePassword: user.mustChangePassword,
      };

      return req.session.save((saveError) => {
        if (saveError) {
          return next(saveError);
        }

        return res.json({
          user: toPublicUser(user),
          redirectTo: user.mustChangePassword ? "/change-password" : null,
        });
      });
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/logout", (req, res, next) => {
  if (!req.session) {
    return res.json({ ok: true });
  }

  return req.session.destroy((error) => {
    if (error) {
      return next(error);
    }

    res.clearCookie(process.env.SESSION_COOKIE_NAME || "live_sms_session");
    return res.json({ ok: true });
  });
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await getSessionUserById(req.user.userId);
    return res.json({ user: toPublicUser(user) });
  } catch (error) {
    return next(error);
  }
});

router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const password = String(req.body?.password || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    await changePassword(req.user.userId, password);
    req.session.user = {
      userId: req.user.userId,
      userName: req.user.username,
      fullName: req.user.fullName,
      canViewAllDevices: req.user.canViewAllDevices,
      mustChangePassword: false,
    };

    return req.session.save((saveError) => {
      if (saveError) {
        return next(saveError);
      }

      return res.json({ ok: true });
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
