const { poolPromise, sql } = require("../db/sql");
const moment = require("moment");

async function handleAttendance({ uid, timestamp }) {
  const pool = await poolPromise;

  // 1. Kiểm tra UID có tồn tại không
  const { recordset: uidRecords } = await pool
    .request()
    .input("uid", sql.NVarChar, uid)
    .query(`SELECT CardID FROM AttendanceCard WHERE UID = @uid`);

  if (uidRecords.length === 0) {
    console.log(`UID ${uid} không tồn tại trong hệ thống.`);
    return;
  }

  const cardID = uidRecords[0].CardID;

  // 2. Tìm account tương ứng
  const { recordset: accountRecords } = await pool
    .request()
    .input("cardID", sql.Int, cardID)
    .query(`SELECT AccountID FROM Account WHERE CardID = @cardID`);

  if (accountRecords.length === 0) {
    console.log(`Không tìm thấy Account cho CardID ${cardID}`);
    return;
  }

  const accountID = accountRecords[0].AccountID;

  // 3. Ghi vào AttendanceLog
  await pool
    .request()
    .input("accountID", sql.Int, accountID)
    .input("scanTime", sql.DateTime, timestamp).query(`
            INSERT INTO AttendanceLog (AccountID, ScanTime)
            VALUES (@accountID, @scanTime)
        `);

  console.log(`Ghi log chấm công cho accountID ${accountID}`);

  // (Tuỳ chọn) 4. Xử lý cập nhật Attendance nếu đúng thời điểm
  // => Để dành cho giai đoạn 2.5 hoặc khi hết ca
}

module.exports = {
  handleAttendance,
};
