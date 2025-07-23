// services/attendanceHandler.js
const dayjs = require("dayjs");
const durationPlugin = require("dayjs/plugin/duration");
const isBetween = require("dayjs/plugin/isBetween");
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
const customParseFormat = require("dayjs/plugin/customParseFormat");
const timezone = require("dayjs/plugin/timezone");
const utc = require("dayjs/plugin/utc");

// Extend Day.js with required plugins
dayjs.extend(durationPlugin);
dayjs.extend(isBetween);
dayjs.extend(isSameOrBefore);
dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

const { poolPromise, sql } = require("../db/sql");

// Handle an unrecognized scan by logging to AttendanceLog
async function logUnrecognized(pool, UID, scanTimeDate, IPAddress, reason) {
  await pool
    .request()
    .input("UID", sql.VarChar(20), UID)
    .input("ScanTime", sql.DateTime, scanTimeDate)
    .input("IPAddress", sql.VarChar(45), IPAddress)
    .input("IsRecognized", sql.Bit, 0)
    .input("Note", sql.NVarChar(255), reason)
    .query(
      `INSERT INTO AttendanceLog (UID, ScanTime, IPAddress, IsRecognized, Note)
       VALUES (@UID, @ScanTime, @IPAddress, @IsRecognized, @Note)`
    );
  console.log(`⚠️ Unrecognized UID ${UID}: ${reason}`);
}

// Main handler
async function handleAttendance({ UID, timestamp, IPAddress, Note = null }) {
  try {
    // Parse scan time as Vietnam local
    const scanTime = dayjs(timestamp).tz("Asia/Ho_Chi_Minh");
    if (!scanTime.isValid()) {
      console.error("❌ Invalid timestamp:", timestamp);
      return;
    }
    const scanDate = scanTime.format("YYYY-MM-DD");

    const pool = await poolPromise;

    // 1. Check UID exists
    const { recordset: uidRecords } = await pool
      .request()
      .input("uid", sql.NVarChar(20), UID)
      .query("SELECT CardID FROM AttendanceCard WHERE UID = @uid");
    if (uidRecords.length === 0) {
      await logUnrecognized(
        pool,
        UID,
        scanTime.toDate(),
        IPAddress,
        "UID not found"
      );
      return;
    }
    const cardID = uidRecords[0].CardID;

    // 2. Find account
    const { recordset: accountRecords } = await pool
      .request()
      .input("cardID", sql.VarChar(10), cardID)
      .query("SELECT AccountID FROM Account WHERE CardID = @cardID");
    if (accountRecords.length === 0) {
      await logUnrecognized(
        pool,
        UID,
        scanTime.toDate(),
        IPAddress,
        "Account not found"
      );
      return;
    }
    const AccountID = accountRecords[0].AccountID;

    // 3. Fetch today's attendance record
    const { recordset } = await pool
      .request()
      .input("AccountID", sql.VarChar(100), AccountID)
      .input("date", sql.Date, scanDate).query(`
        SELECT A.ShiftID, A.OTStart, A.OTEnd, S.StartTime, S.Duration, ST.Interval
        FROM Attendance A
        JOIN Shift S ON A.ShiftID = S.ShiftID
        JOIN ShiftType ST ON S.STID = ST.ST_ID
        WHERE A.AccountID = @AccountID AND A.date = @date AND A.isDeleted = 0
      `);
    if (recordset.length === 0) {
      await logUnrecognized(
        pool,
        UID,
        scanTime.toDate(),
        IPAddress,
        "No shift found"
      );
      return;
    }
    const shift = recordset[0];

    // 4. Compute durations in minutes
    const durationMinutes =
      shift.Duration.getUTCHours() * 60 + shift.Duration.getUTCMinutes();
    const intervalMinutes =
      shift.Interval.getUTCHours() * 60 + shift.Interval.getUTCMinutes();

    // 5. Build shift start from date + raw time
    const startTimeRaw = dayjs.utc(shift.StartTime).format("HH:mm:ss");
    const shiftStart = dayjs(
      `${scanDate} ${startTimeRaw}`,
      "YYYY-MM-DD HH:mm:ss"
    ).tz("Asia/Ho_Chi_Minh");
    const shiftEnd = shiftStart.add(durationMinutes, "minute");

    // 6. Define check windows
    const checkInStart = shiftStart.subtract(intervalMinutes, "minute");
    const checkInEnd = shiftStart.add(intervalMinutes, "minute");
    const checkOutStart = shiftEnd.subtract(intervalMinutes, "minute");
    const checkOutDeadline = shiftEnd.add(intervalMinutes, "minute");

    let updated = false;

    // 7. Check-in
    if (
      !shift.OTStart &&
      scanTime.isBetween(checkInStart, checkInEnd, null, "[]")
    ) {
      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), shift.ShiftID)
        .input("OTStart", sql.DateTime, scanTime.toDate())
        .query(
          `UPDATE Attendance SET OTStart = @OTStart WHERE AccountID = @AccountID AND ShiftID = @ShiftID`
        );
      updated = true;
    }

    // 8. Check-out
    if (
      !shift.OTEnd &&
      scanTime.isAfter(checkOutStart) &&
      scanTime.isBefore(checkOutDeadline)
    ) {
      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), shift.ShiftID)
        .input("OTEnd", sql.DateTime, scanTime.toDate())
        .query(
          `UPDATE Attendance SET OTEnd = @OTEnd WHERE AccountID = @AccountID AND ShiftID = @ShiftID`
        );
      updated = true;
    }

    // 9. Determine status if both OTStart and OTEnd set
    const statusSet = await pool
      .request()
      .input("AccountID", sql.VarChar(100), AccountID)
      .input("ShiftID", sql.VarChar(100), shift.ShiftID)
      .query(
        `SELECT OTStart, OTEnd FROM Attendance WHERE AccountID = @AccountID AND ShiftID = @ShiftID`
      );
    const { OTStart, OTEnd } = statusSet.recordset[0];
    if (OTStart && OTEnd) {
      const startObj = dayjs(OTStart).tz("Asia/Ho_Chi_Minh");
      const status = startObj.isSameOrBefore(checkInEnd) ? "present" : "late";
      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), shift.ShiftID)
        .input("status", sql.VarChar(50), status)
        .query(
          `UPDATE Attendance SET status = @status WHERE AccountID = @AccountID AND ShiftID = @ShiftID`
        );
    }

    // 10. Log to AttendanceLog
    await pool
      .request()
      .input("UID", sql.VarChar(20), UID)
      .input("ScanTime", sql.DateTime, scanTime.toDate())
      .input("IPAddress", sql.VarChar(45), IPAddress)
      .input("IsRecognized", sql.Bit, 1)
      .input("Note", sql.NVarChar(255), Note)
      .query(
        `INSERT INTO AttendanceLog (UID, ScanTime, IPAddress, IsRecognized, Note) VALUES (@UID, @ScanTime, @IPAddress, @IsRecognized, @Note)`
      );

    console.log(
      updated
        ? `✅ Updated attendance for UID ${UID}`
        : `ℹ️ UID ${UID} scanned but nothing updated`
    );
  } catch (err) {
    console.error("❌ handleAttendance error:", err);
  }
}

module.exports = handleAttendance;
