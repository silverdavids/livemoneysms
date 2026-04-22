const express = require("express");
const {
  authenticateUser,
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

      return req.session.save((saveError) => {
        if (saveError) {
          return next(saveError);
        }

        return res.json({ user: toPublicUser(user) });
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

module.exports = router;
