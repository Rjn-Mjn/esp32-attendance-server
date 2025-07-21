const { poolPromise, sql } = require("../db/sql");
const moment = require("moment");

async function handleAttendance({
  uid,
  timestamp,
  IPAddress = null,
  Note = null,
}) {
  const pool = await poolPromise;

  // 1. Kiểm tra UID có tồn tại không
  const { recordset: uidRecords } = await pool
    .request()
    .input("uid", sql.NVarChar(20), uid)
    .query(`SELECT CardID FROM AttendanceCard WHERE UID = @uid`);

  if (uidRecords.length === 0) {
    console.log(`UID ${uid} không tồn tại trong hệ thống.`);
    return;
  }

  const cardID = uidRecords[0].CardID;

  // 2. Tìm account tương ứng
  const { recordset: accountRecords } = await pool
    .request()
    .input("cardID", sql.VarChar(10), cardID)
    .query(`SELECT AccountID FROM Account WHERE CardID = @cardID`);

  if (accountRecords.length === 0) {
    console.log(`Không tìm thấy Account cho CardID ${cardID}`);
    return;
  }

  const accountID = accountRecords[0].AccountID;

  // 3. Ghi vào AttendanceLog
  await pool
    .request()
    .input("UID", sql.VarChar(20), uid)
    .input("IPAddress", sql.VarChar(45), IPAddress)
    .input("Note", sql.NVarChar(255), Note).query(`
      INSERT INTO AttendanceLog (UID, IPAddress, Note)
      VALUES (@UID, @IPAddress, @Note)
    `);

  console.log(`✅ Ghi log chấm công cho accountID ${accountID}`);
}

module.exports = handleAttendance; // 🔥 Thêm dòng này
