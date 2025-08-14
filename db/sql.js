const sql = require("mssql");
require("dotenv").config();

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  server: process.env.DB_SERVER, // thường là localhost hoặc IP LAN
  database: process.env.DB_NAME,
  options: {
    encrypt: false,
    // useUTC: false,
    trustServerCertificate: true,
  },
};

const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then((pool) => {
    console.log("Connected to MSSQL");
    return pool;
  })
  .catch((err) => console.error("Database Connection Failed:", err));

module.exports = {
  sql,
  poolPromise,
};
