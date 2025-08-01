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

// Log unrecognized scan
async function logUnrecognized(pool, UID, scanTimeDate, IPAddress, reason) {
  // console.log("[DEBUG] logUnrecognized called with:", {
  //   UID,
  //   scanTimeDate,
  //   IPAddress,
  //   reason,
  // });
  await pool
    .request()
    .input("UID", sql.VarChar(20), UID)
    .input("ScanTime", sql.DateTime, scanTimeDate)
    .input("IPAddress", sql.VarChar(45), IPAddress)
    .input("IsRecognized", sql.Bit, 0)
    .input("Note", sql.NVarChar(255), reason).query(`
      INSERT INTO AttendanceLog (UID, ScanTime, IPAddress, IsRecognized, Note)
      VALUES (@UID, @ScanTime, @IPAddress, @IsRecognized, @Note)
    `);
  // console.log(`⚠️ Unrecognized UID ${UID}: ${reason}`);
}

// Main attendance handler
async function handleAttendance({ UID, timestamp, IPAddress, Note = null }) {
  try {
    // 1. Parse and debug scan time
    const scanTime = dayjs(timestamp).tz("Asia/Ho_Chi_Minh");
    // console.log("[DEBUG] scanTime:", scanTime.format("YYYY-MM-DD HH:mm:ss"));
    // console.log("[DEBUG] scanTime:", scanTime.toDate());

    if (!scanTime.isValid()) {
      console.error("❌ Invalid timestamp:", timestamp);
      return;
    }
    const scanDate = scanTime.format("YYYY-MM-DD");
    // console.log("[DEBUG] scanDate:", scanDate);

    const pool = await poolPromise;

    // 2. Check UID exists
    // console.log("[DEBUG] Checking UID:", UID);
    const { recordset: uidRecords } = await pool
      .request()
      .input("uid", sql.NVarChar(20), UID)
      .query("SELECT CardID FROM AttendanceCard WHERE UID = @uid");
    // console.log("[DEBUG] uidRecords:", uidRecords);
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
    // console.log("[DEBUG] cardID:", cardID);

    // 3. Find account
    const { recordset: accountRecords } = await pool
      .request()
      .input("cardID", sql.VarChar(10), cardID)
      .query("SELECT AccountID FROM Account WHERE CardID = @cardID");
    // console.log("[DEBUG] accountRecords:", accountRecords);
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
    // console.log("[DEBUG] AccountID:", AccountID);

    // 4. Fetch today's shift record
    const { recordset: shiftRecords } = await pool
      .request()
      .input("AccountID", sql.VarChar(100), AccountID)
      .input("date", sql.Date, scanDate).query(`
        SELECT A.ShiftID, A.OTStart, A.OTEnd, S.StartTime, S.Duration, ST.Interval
        FROM Attendance A
        JOIN Shift S ON A.ShiftID = S.ShiftID
        JOIN ShiftType ST ON S.STID = ST.ST_ID
        WHERE A.AccountID = @AccountID AND A.date = @date AND A.isDeleted = 0
      `);
    // console.log("[DEBUG] attendance recordset:", shiftRecords);
    if (shiftRecords.length === 0) {
      await logUnrecognized(
        pool,
        UID,
        scanTime.toDate(),
        IPAddress,
        "No shift found"
      );
      return;
    }
    // Filter out shifts that already have both OTStart and OTEnd
    const incompleteShifts = shiftRecords.filter((s) => !s.OTStart || !s.OTEnd);
    if (incompleteShifts.length === 0) {
      // console.log("[DEBUG] All shifts already have OTStart and OTEnd");
      return;
    }

    // Find the closest shift to scanTime
    const scannedShift = incompleteShifts.reduce((closest, current) => {
      const startTimeRaw = dayjs.utc(current.StartTime).format("HH:mm:ss");
      const shiftStart = dayjs(
        `${scanDate} ${startTimeRaw}`,
        "YYYY-MM-DD HH:mm:ss"
      ).tz("Asia/Ho_Chi_Minh");
      const diff = Math.abs(scanTime.diff(shiftStart));
      if (!closest || diff < closest.diff) {
        return { ...current, diff };
      }
      return closest;
    }, null);

    if (!scannedShift) {
      // console.log("[DEBUG] No shift matched for scan time");
      return;
    }

    const shift = scannedShift;
    // console.log("[DEBUG] shift data:", shift);

    // 5. Compute durations
    const durationMinutes =
      shift.Duration.getUTCHours() * 60 + shift.Duration.getUTCMinutes();
    const intervalMinutes =
      shift.Interval.getUTCHours() * 60 + shift.Interval.getUTCMinutes();
    // console.log(
    //   "[DEBUG] durationMinutes, intervalMinutes:",
    //   durationMinutes,
    //   intervalMinutes
    // );

    // 6. Build shiftStart and shiftEnd
    const startTimeRaw = dayjs.utc(shift.StartTime).format("HH:mm:ss");
    // console.log("[DEBUG] startTimeRaw:", startTimeRaw);
    const shiftStart = dayjs(
      `${scanDate} ${startTimeRaw}`,
      "YYYY-MM-DD HH:mm:ss"
    ).tz("Asia/Ho_Chi_Minh");
    // console.log(
    //   "[DEBUG] shiftStart:",
    //   shiftStart.format("YYYY-MM-DD HH:mm:ss")
    // );
    const shiftEnd = shiftStart.add(durationMinutes, "minute");
    // console.log("[DEBUG] shiftEnd:", shiftEnd.format("YYYY-MM-DD HH:mm:ss"));

    // 7. Define check windows
    const checkInStart = shiftStart.subtract(intervalMinutes, "minute");
    const checkInEnd = shiftStart.add(intervalMinutes, "minute");
    const checkOutStart = shiftEnd.subtract(intervalMinutes, "minute");
    const checkOutDeadline = shiftEnd.add(intervalMinutes, "minute");
    // console.log(
    //   "[DEBUG] checkInStart, checkInEnd, checkOutStart, checkOutDeadline:",
    //   checkInStart.format("HH:mm:ss"),
    //   checkInEnd.format("HH:mm:ss"),
    //   checkOutStart.format("HH:mm:ss"),
    //   checkOutDeadline.format("HH:mm:ss")
    // );

    let updated = false;

    // 8. Check-in
    // console.log(
    //   "[DEBUG] scanTime.isBetween(checkInStart, checkInEnd):",
    //   scanTime.isBetween(checkInStart, checkInEnd, null, "[]")
    // );
    // console.log(
    //   "[DEBUG] scanTime.isBetween(checkInEnd, checkoutStart):",
    //   scanTime.isBetween(checkInEnd, checkOutStart, null, "[]")
    // );
    if (
      !shift.OTStart &&
      scanTime.isBetween(checkInStart, checkInEnd, null, "[]")
    ) {
      const timeScanned = scanTime.format("YYYY-MM-DD HH:mm:ss");

      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), shift.ShiftID)
        .input("OTStart", sql.VarChar, timeScanned)
        .query(
          `UPDATE Attendance SET OTStart = @OTStart WHERE AccountID = @AccountID AND ShiftID = @ShiftID`
        );
      updated = true;
    } else if (
      !shift.OTStart &&
      scanTime.isBetween(checkInEnd, checkOutStart, null, "[]")
    ) {
      const timeScanned = scanTime.format("YYYY-MM-DD HH:mm:ss");
      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), shift.ShiftID)
        .input("OTStart", sql.VarChar, timeScanned)
        .query(
          `UPDATE Attendance SET OTStart = @OTStart WHERE AccountID = @AccountID AND ShiftID = @ShiftID`
        );
      updated = true;
    }

    // 9. Check-out
    // console.log(
    //   "[DEBUG] scanTime.isAfter(checkOutStart):",
    //   scanTime.isAfter(checkOutStart)
    // );
    // console.log(
    //   "[DEBUG] scanTime.isBefore(checkOutDeadline):",
    //   scanTime.isBefore(checkOutDeadline)
    // );
    if (
      !shift.OTEnd &&
      scanTime.isAfter(checkOutStart) &&
      scanTime.isBefore(checkOutDeadline)
    ) {
      // Build a JS Date with local components to preserve local time
      const localEnd = new Date(
        scanTime.year(),
        scanTime.month(),
        scanTime.date(),
        scanTime.hour(),
        scanTime.minute(),
        scanTime.second()
      );
      // console.log("[DEBUG] localEnd for DB:", localEnd);
      const timeScanned = scanTime.format("YYYY-MM-DD HH:mm:ss");
      // console.log("[DEBUG] time scanned:", timeScanned);

      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), shift.ShiftID)
        .input("OTEnd", sql.VarChar, timeScanned)
        .query(
          `UPDATE Attendance SET OTEnd = @OTEnd WHERE AccountID = @AccountID AND ShiftID = @SHIFTID`
        );
      updated = true;
    }

    // 10. Determine status
    const statusSet = await pool
      .request()
      .input("AccountID", sql.VarChar(100), AccountID)
      .input("ShiftID", sql.VarChar(100), shift.ShiftID)
      .query(
        `SELECT OTStart, OTEnd FROM Attendance WHERE AccountID = @AccountID AND ShiftID = @ShiftID`
      );
    const { OTStart, OTEnd } = statusSet.recordset[0];
    if (OTStart && OTEnd) {
      // Treat OTStart string as local without timezone shift
      const rawStart = dayjs(OTStart).utc().format("YYYY-MM-DD HH:mm:ss");
      const startObj = dayjs(rawStart, "YYYY-MM-DD HH:mm:ss");
      // console.log("[DEBUG] OTStart :", rawStart);
      // console.log("[DEBUG] OTStart (DB local interpreted):", startObj);

      const status = startObj.isSameOrBefore(checkInEnd) ? "present" : "late";
      // console.log("[DEBUG] determined status:", status);
      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), shift.ShiftID)
        .input("status", sql.VarChar(50), status)
        .query(
          `UPDATE Attendance SET status = @status WHERE AccountID = @AccountID AND ShiftID = @ShiftID`
        );
    }

    // 11. Log to AttendanceLog
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

    // console.log(
    //   updated
    //     ? `✅ Updated attendance for UID ${UID}`
    //     : `ℹ️ UID ${UID} scanned but nothing updated`
    // );
  } catch (err) {
    console.error("❌ handleAttendance error:", err);
  }
}

module.exports = handleAttendance;
