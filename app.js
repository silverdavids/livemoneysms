const express = require("express");
const session = require("express-session");
const path = require("path");

require("dotenv").config({ quiet: true });

const authRoutes = require("./routes/auth-routes");
const messageRoutes = require("./routes/message-routes");
const deviceRoutes = require("./routes/device-routes");
const userDeviceRoutes = require("./routes/user-device-routes");
const cashflowRoutes = require("./routes/cashflow-routes");
const matchesRoutes = require("./routes/matches-routes");

const app = express();

app.set("trust proxy", 1);
app.set("etag", false);

const sessionMiddleware = session({
  name: process.env.SESSION_COOKIE_NAME || "live_sms_session",
  secret: process.env.SESSION_SECRET || "replace-me-in-env",
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: Number(process.env.SESSION_MAX_AGE_MS || 8 * 60 * 60 * 1000),
  },
});

app.use(express.json({ limit: "20kb" }));
app.use(sessionMiddleware);

app.use("/api", authRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/user-devices", userDeviceRoutes);
app.use(cashflowRoutes);
app.use(matchesRoutes);

app.get("/change-password", (req, res) => {
  if (!req.session?.userId) {
    return res.redirect("/");
  }

  return res.sendFile(path.join(__dirname, "public", "change-password.html"));
});

app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  console.error("request error:", err);
  return res.status(500).json({ error: "Internal server error" });
});

module.exports = {
  app,
  sessionMiddleware,
};
