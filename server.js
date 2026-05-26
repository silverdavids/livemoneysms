const http = require("http");
const { Server } = require("socket.io");
const { app, sessionMiddleware } = require("./app");
const {
  initializeMessageCursor,
  fetchMessagesForUser,
  fetchNewMessages,
  filterMessagesForUser,
} = require("./services/message-service");
const {
  initializeCashflowCursor,
  fetchNewCashflowTransactions,
  filterCashflowRowsForUser,
} = require("./services/cashflow-service");
const { getSessionUserById } = require("./services/auth-service");

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
  },
});
let isPolling = false;
let isCashflowPolling = false;

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, async (sessionError) => {
    if (sessionError) {
      return next(sessionError);
    }

    try {
      const userId = socket.request.session?.userId;
      if (!userId) {
        return next(new Error("Authentication required"));
      }

      const user = await getSessionUserById(userId);
      if (!user) {
        return next(new Error("Authentication required"));
      }
      if (user.mustChangePassword) {
        return next(new Error("Password change required"));
      }

      socket.user = user;
      return next();
    } catch (error) {
      return next(error);
    }
  });
});

io.on("connection", async (socket) => {
  console.log("client connected", socket.id, socket.user.username);

  try {
    const recent = await fetchMessagesForUser(socket.user, 50);
    socket.emit("initial_sms", recent);
    console.log(`sent initial ${recent.length} sms to ${socket.user.username}`);
  } catch (error) {
    console.error("initial load error:", error);
    socket.emit("load_error", "Could not load messages");
  }

  socket.on("disconnect", () => {
    console.log("client disconnected", socket.id);
  });
});

async function pushNewMessages() {
  if (isPolling) {
    return;
  }

  isPolling = true;
  let pushedCount = 0;

  try {
    const rows = await fetchNewMessages();
    if (rows.length === 0) {
      return;
    }

    pushedCount = rows.length;

    for (const socket of io.sockets.sockets.values()) {
      const visibleRows = filterMessagesForUser(rows, socket.user);
      if (visibleRows.length > 0) {
        socket.emit("new_sms", visibleRows);
      }
    }
  } finally {
    isPolling = false;
  }

  console.log(`pushed ${pushedCount} new sms to connected users`);
}

async function pushCashflowUpdates() {
  if (isCashflowPolling) {
    return;
  }

  isCashflowPolling = true;
  let pushedCount = 0;

  try {
    const rows = await fetchNewCashflowTransactions();
    if (rows.length === 0) {
      return;
    }

    pushedCount = rows.length;

    for (const socket of io.sockets.sockets.values()) {
      const visibleRows = filterCashflowRowsForUser(rows, socket.user);
      if (visibleRows.length > 0) {
        socket.emit("cashflow_activity", {
          count: visibleRows.length,
          ids: visibleRows.map((row) => row.MobileMoneyTransactionId),
          latestCreatedOnUtc: visibleRows[visibleRows.length - 1].CreatedOnUtc,
        });
      }
    }
  } finally {
    isCashflowPolling = false;
  }

  console.log(`pushed ${pushedCount} new cashflow transactions to connected users`);
}

async function start() {
  await initializeMessageCursor();
  await initializeCashflowCursor();

  setInterval(() => {
    pushNewMessages().catch((error) => console.error("poll error:", error));
  }, 1000);

  setInterval(() => {
    pushCashflowUpdates().catch((error) => console.error("cashflow poll error:", error));
  }, 10000);

  const port = Number(process.env.PORT || 3000);
  const host = "0.0.0.0";

  server.listen(port, host, () => {
    console.log(`Web running: http://${host}:${port}`);
  });
}

start().catch((error) => console.error("startup error:", error));
