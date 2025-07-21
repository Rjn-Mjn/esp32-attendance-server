// services/attendanceHandler.js

const sql = require("mssql");
const dayjs = require("dayjs");
const { poolPromise, sql } = require("../db/sql");

// 1 phút là 60 * 1000 ms
const MS_IN_MINUTE = 60000;

async function handleAttendance({ UID, timestamp, IPAddress, Note = null }) {
  const scanTime = dayjs(timestamp);
  const scanDate = scanTime.format("YYYY-MM-DD");
  const scanTimeStr = scanTime.format("HH:mm:ss");

  try {
    const pool = await poolPromise;

    // 1. Lấy AccountID dựa vào UID
    const accountResult = await pool
      .request()
      .input("uid", sql.VarChar, UID)
      .query("SELECT AccountID FROM Accounts WHERE UID = @uid");

    if (accountResult.recordset.length === 0) {
      await logUnrecognized(pool, UID, timestamp, IPAddress, "UID not found");
      return;
    }

    const AccountID = accountResult.recordset[0].AccountID;

    // 2. Lấy ca hôm nay
    const attendanceResult = await pool
      .request()
      .input("AccountID", sql.Int, AccountID)
      .input("date", sql.Date, scanDate).query(`
        SELECT A.ShiftID, A.OTStart, A.OTEnd, S.StartTime, S.Duration, ST.Interval
        FROM Attendance A
        JOIN Shift S ON A.ShiftID = S.ShiftID
        JOIN ShiftType ST ON S.STID = ST.STID
        WHERE A.AccountID = @AccountID AND A.date = @date
      `);

    if (attendanceResult.recordset.length === 0) {
      await logUnrecognized(pool, UID, timestamp, IPAddress, "No shift found");
      return;
    }

    const shift = attendanceResult.recordset[0];
    const shiftStart = dayjs(`${scanDate}T${shift.StartTime}`);
    const shiftEnd = shiftStart.add(shift.Duration, "minute");
    const intervalMs = shift.Interval * MS_IN_MINUTE;

    const checkInStart = shiftStart.subtract(intervalMs, "millisecond");
    const checkInEnd = shiftStart.add(intervalMs, "millisecond");
    const checkOutStart = shiftEnd.subtract(intervalMs, "millisecond");
    const checkOutDeadline = shiftEnd.add(intervalMs, "millisecond");

    let updated = false;

    // 3. Cập nhật OTStart nếu nằm trong thời gian check-in
    if (
      !shift.OTStart &&
      scanTime.isBetween(checkInStart, checkInEnd, null, "[]")
    ) {
      await pool
        .request()
        .input("AccountID", sql.Int, AccountID)
        .input("ShiftID", sql.Int, shift.ShiftID)
        .input("OTStart", sql.DateTime, timestamp).query(`
          UPDATE Attendance SET OTStart = @OTStart
          WHERE AccountID = @AccountID AND ShiftID = @ShiftID
        `);
      updated = true;
    }

    // 4. Cập nhật OTEnd nếu nằm trong thời gian check-out
    if (!shift.OTEnd && scanTime.isAfter(checkOutStart)) {
      await pool
        .request()
        .input("AccountID", sql.Int, AccountID)
        .input("ShiftID", sql.Int, shift.ShiftID)
        .input("OTEnd", sql.DateTime, timestamp).query(`
          UPDATE Attendance SET OTEnd = @OTEnd
          WHERE AccountID = @AccountID AND ShiftID = @ShiftID
        `);
      updated = true;
    }

    // 5. Xác định Status nếu có đủ OTStart và OTEnd
    const getStatusResult = await pool
      .request()
      .input("AccountID", sql.Int, AccountID)
      .input("ShiftID", sql.Int, shift.ShiftID).query(`
        SELECT OTStart, OTEnd FROM Attendance
        WHERE AccountID = @AccountID AND ShiftID = @ShiftID
      `);

    const { OTStart, OTEnd } = getStatusResult.recordset[0];
    let status = null;

    if (OTStart && OTEnd) {
      const startObj = dayjs(OTStart);
      if (startObj.isSameOrBefore(checkInEnd)) {
        status = "present";
      } else {
        status = "late";
      }

      await pool
        .request()
        .input("AccountID", sql.Int, AccountID)
        .input("ShiftID", sql.Int, shift.ShiftID)
        .input("status", sql.VarChar, status).query(`
          UPDATE Attendance SET status = @status
          WHERE AccountID = @AccountID AND ShiftID = @ShiftID
        `);
    }

    // 6. Ghi log vào AttendanceLog
    await pool
      .request()
      .input("UID", sql.VarChar, UID)
      .input("ScanTime", sql.DateTime, timestamp)
      .input("IPAddress", sql.VarChar, IPAddress)
      .input("IsRecognized", sql.Bit, 1)
      .input("Note", sql.NVarChar, Note).query(`
        INSERT INTO AttendanceLog (UID, ScanTime, IPAddress, IsRecognized, Note)
        VALUES (@UID, @ScanTime, @IPAddress, @IsRecognized, @Note)
      `);

    if (updated) {
      console.log(`✅ Updated attendance for UID ${UID}`);
    } else {
      console.log(`ℹ️ UID ${UID} scanned but nothing updated`);
    }
  } catch (err) {
    console.error("❌ handleAttendance error:", err);
  }
}

async function logUnrecognized(pool, UID, timestamp, IPAddress, reason) {
  await pool
    .request()
    .input("UID", sql.VarChar, UID)
    .input("ScanTime", sql.DateTime, timestamp)
    .input("IPAddress", sql.VarChar, IPAddress)
    .input("IsRecognized", sql.Bit, 0)
    .input("Note", sql.NVarChar, reason).query(`
      INSERT INTO AttendanceLog (UID, ScanTime, IPAddress, IsRecognized, Note)
      VALUES (@UID, @ScanTime, @IPAddress, @IsRecognized, @Note)
    `);
  console.log(`⚠️ Unrecognized UID ${UID}: ${reason}`);
}

module.exports = handleAttendance;
