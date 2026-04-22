const sql = require("mssql");

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  server: process.env.DB_HOST,
  database: process.env.DB_NAME,
  options: {
    encrypt: process.env.DB_ENCRYPT === "true",
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE !== "false",
  },
  pool: {
    max: Number(process.env.DB_POOL_MAX || 10),
    min: Number(process.env.DB_POOL_MIN || 0),
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS || 30000),
  },
};

let poolPromise;

function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(config).then((pool) => {
      pool.on("error", (error) => {
        console.error("DB pool error:", error);
        poolPromise = null;
      });
      console.log("DB connected");
      return pool;
    }).catch((error) => {
      poolPromise = null;
      throw error;
    });
  }

  return poolPromise;
}

async function createRequest() {
  const pool = await getPool();
  return pool.request();
}

module.exports = {
  sql,
  getPool,
  createRequest,
};
