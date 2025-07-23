// services/attendanceHandler.js
const dayjs = require("dayjs");
const duration = require("dayjs/plugin/duration");
dayjs.extend(duration);
const isBetween = require("dayjs/plugin/isBetween");
dayjs.extend(isBetween);
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
dayjs.extend(isSameOrBefore);
const { poolPromise, sql } = require("../db/sql");
const utc = require("dayjs/plugin/utc");
dayjs.extend(utc);
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(timezone);

// 1 phút = 60 * 1000 ms
const MS_IN_MINUTE = 60000;

async function handleAttendance({ UID, timestamp, IPAddress, Note = null }) {
  try {
    const scanTime = dayjs(timestamp).tz("Asia/Ho_Chi_Minh");
    const scanDate = scanTime.format("YYYY-MM-DD");
    const scanTimeStr = scanTime.format("HH:mm:ss");

    const pool = await poolPromise;

    const { recordset: uidRecords } = await pool
      .request()
      .input("uid", sql.NVarChar(20), UID)
      .query(`SELECT CardID FROM AttendanceCard WHERE UID = @uid`);

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

    const { recordset: accountRecords } = await pool
      .request()
      .input("cardID", sql.VarChar(10), cardID)
      .query(`SELECT AccountID FROM Account WHERE CardID = @cardID`);

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

    console.log("Date scanned: " + scanTimeStr);
    console.log("Date scanned: " + scanDate);
    console.log("AccountID: " + AccountID);

    const attendanceResult = await pool
      .request()
      .input("AccountID", sql.VarChar(100), AccountID)
      .input("date", sql.Date, scanDate).query(`
        SELECT A.ShiftID, A.OTStart, A.OTEnd, S.StartTime, S.Duration, ST.Interval
        FROM Attendance A
        JOIN Shift S ON A.ShiftID = S.ShiftID
        JOIN ShiftType ST ON S.STID = ST.ST_ID
        WHERE A.AccountID = @AccountID AND A.date = @date
      `);

    if (attendanceResult.recordset.length === 0) {
      await logUnrecognized(
        pool,
        UID,
        scanTime.toDate(),
        IPAddress,
        "No shift found"
      );
      return;
    }

    const shift = attendanceResult.recordset[0];
    console.log(shift);
    console.log("Date scanned: " + scanDate);
    console.log("AccountID: " + AccountID);
    console.log("Ca: " + shift.ShiftID);
    console.log(shift.Duration);
    console.log(typeof shift.Duration);

    const durationMs =
      shift.Duration.getUTCHours() * 60 * 60 * 1000 +
      shift.Duration.getUTCMinutes() * 60 * 1000 +
      shift.Duration.getUTCSeconds() * 1000;

    const intervalMs =
      shift.Interval.getUTCHours() * 60 * 60 * 1000 +
      shift.Interval.getUTCMinutes() * 60 * 1000 +
      shift.Interval.getUTCSeconds() * 1000;

    const duration = dayjs.duration(durationMs);
    const interval = dayjs.duration(intervalMs);

    const startTimeStr = shift.StartTime; // ví dụ: "07:00:00"

    // Gộp lại thành 2025-07-21T07:00:00 mà không bị shift timezone
    const shiftStart = dayjs(`${scanDate}T${startTimeStr}`);

    const shiftEnd = shiftStart.add(duration); // already in ms
    const checkInStart = shiftStart.subtract(interval);
    const checkInEnd = shiftStart.add(interval);
    const checkOutStart = shiftEnd.subtract(interval);
    const checkOutDeadline = shiftEnd.add(interval);

    console.log("Raw StartTime from DB:", shift.StartTime);
    console.log(
      "VN Time:",
      dayjs(shift.StartTime).tz("Asia/Ho_Chi_Minh").format("HH:mm:ss")
    );
    console.log("UTC Time:", dayjs(shift.StartTime).utc().format("HH:mm:ss"));
    console.log(shiftStart.format()); // 2025-07-21T04:30:00+07:00
    console.log(shiftStart.toISOString()); // 2025-07-20T21:30:00.000Z

    console.log("Shift end:", shiftEnd);
    console.log("Interval: ", interval);
    console.log(typeof interval);
    console.log("Check-in window:", checkInStart, "→", checkInEnd);
    console.log("Check-out window:", checkOutStart, "→", checkOutDeadline);

    let updated = false;
    console.log("Thời điểm OTStart: " + shift.OTStart);
    console.log("Thời gian quét: " + scanTime);
    console.log("Thời gian quét: " + scanTimeStr);
    console.log(scanTime.isBetween(checkInStart, checkInEnd, null, "[]"));
    if (
      !shift.OTStart &&
      scanTime.isBetween(checkInStart, checkInEnd, null, "[]")
    ) {
      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), shift.ShiftID)
        .input("OTStart", sql.DateTime, scanTime.toDate()).query(`
          UPDATE Attendance SET OTStart = @OTStart
          WHERE AccountID = @AccountID AND ShiftID = @ShiftID
        `);
      updated = true;
    }

    console.log(scanTime);
    console.log(scanTime.isAfter(checkOutStart));
    if (!shift.OTEnd && scanTime.isAfter(checkOutStart)) {
      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), shift.ShiftID)
        .input("OTEnd", sql.DateTime, scanTime.toDate()).query(`
          UPDATE Attendance SET OTEnd = @OTEnd
          WHERE AccountID = @AccountID AND ShiftID = @ShiftID
        `);
      updated = true;
    }

    const getStatusResult = await pool
      .request()
      .input("AccountID", sql.VarChar(100), AccountID)
      .input("ShiftID", sql.VarChar(100), shift.ShiftID).query(`
        SELECT OTStart, OTEnd FROM Attendance
        WHERE AccountID = @AccountID AND ShiftID = @ShiftID
      `);

    const { OTStart, OTEnd } = getStatusResult.recordset[0];
    let status = null;

    if (OTStart && OTEnd) {
      const startObj = dayjs(OTStart).tz("Asia/Ho_Chi_Minh");
      if (startObj.isSameOrBefore(checkInEnd)) {
        status = "present";
      } else {
        status = "late";
      }

      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), shift.ShiftID)
        .input("status", sql.VarChar(50), status).query(`
          UPDATE Attendance SET status = @status
          WHERE AccountID = @AccountID AND ShiftID = @ShiftID
        `);
    }

    await pool
      .request()
      .input("UID", sql.VarChar(20), UID)
      .input("ScanTime", sql.DateTime, scanTime.toDate())
      .input("IPAddress", sql.VarChar(45), IPAddress)
      .input("IsRecognized", sql.Bit, 1)
      .input("Note", sql.NVarChar(255), Note).query(`
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
    .input("UID", sql.VarChar(20), UID)
    .input("ScanTime", sql.DateTime, timestamp)
    .input("IPAddress", sql.VarChar(45), IPAddress)
    .input("IsRecognized", sql.Bit, 0)
    .input("Note", sql.NVarChar(225), reason).query(`
      INSERT INTO AttendanceLog (UID, ScanTime, IPAddress, IsRecognized, Note)
      VALUES (@UID, @ScanTime, @IPAddress, @IsRecognized, @Note)
    `);
  console.log(`⚠️ Unrecognized UID ${UID}: ${reason}`);
}

module.exports = handleAttendance;
