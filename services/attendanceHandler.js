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

// Set default timezone to Vietnam
const vnTz = "Asia/Ho_Chi_Minh";
dayjs.tz.setDefault(vnTz);

const { poolPromise, sql } = require("../db/sql");

// Log unrecognized scan
async function logUnrecognized(pool, UID, scanTimeDate, IPAddress, reason) {
  console.log("[DEBUG] logUnrecognized called with:", {
    UID,
    scanTimeDate,
    IPAddress,
    reason,
  });
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
  console.log(`⚠️ Unrecognized UID ${UID}: ${reason}`);
}

// Main attendance handler
async function handleAttendance({ UID, timestamp, IPAddress, Note = null }) {
  try {
    const scanTime = dayjs(timestamp).tz(vnTz); // Convert incoming timestamp to Vietnam timezone
    console.log("[DEBUG] scanTime:", scanTime.format("YYYY-MM-DD HH:mm:ss"));
    if (!scanTime.isValid()) {
      console.error("❌ Invalid timestamp:", timestamp);
      return;
    }

    const scanDate = scanTime.format("YYYY-MM-DD");
    const pool = await poolPromise;

    // Fetch CardID from UID
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

    // Fetch AccountID using CardID
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

    // Get all shifts for that day
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

    console.log("[DEBUG] attendance recordset:", recordset);

    // Filter shifts where either OTStart or OTEnd hasn't been set
    const validShifts = recordset.filter((s) => !s.OTStart || !s.OTEnd);
    if (validShifts.length === 0) {
      await logUnrecognized(
        pool,
        UID,
        scanTime.toDate(),
        IPAddress,
        "All shifts completed"
      );
      return;
    }

    let chosenShift = null;
    let minDistance = Infinity;

    // Pick the shift that is nearest to scanTime
    for (const shift of validShifts) {
      const shiftStart = dayjs(
        `${scanDate} ${dayjs(shift.StartTime).tz(vnTz).format("HH:mm:ss")}`
      ).tz(vnTz);
      const diff = Math.abs(scanTime.diff(shiftStart));
      console.log("[DEBUG] Checking shift:", {
        ShiftID: shift.ShiftID,
        StartTime: shiftStart.format("YYYY-MM-DD HH:mm:ss"),
        Diff: diff,
      });
      if (diff < minDistance) {
        minDistance = diff;
        chosenShift = shift;
      }
    }

    if (!chosenShift) return;
    console.log("[DEBUG] chosenShift:", chosenShift);

    // Calculate shift start/end and check-in/check-out windows
    const shiftStart = dayjs(
      `${scanDate} ${dayjs(chosenShift.StartTime).tz(vnTz).format("HH:mm:ss")}`
    ).tz(vnTz);
    const durationMinutes =
      chosenShift.Duration.getUTCHours() * 60 +
      chosenShift.Duration.getUTCMinutes();
    const intervalMinutes =
      chosenShift.Interval.getUTCHours() * 60 +
      chosenShift.Interval.getUTCMinutes();
    const shiftEnd = shiftStart.add(durationMinutes, "minute");
    const checkInStart = shiftStart.subtract(intervalMinutes, "minute");
    const checkInEnd = shiftStart.add(intervalMinutes, "minute");
    const checkOutStart = shiftEnd.subtract(intervalMinutes, "minute");
    const checkOutDeadline = shiftEnd.add(intervalMinutes, "minute");

    console.log(
      "[DEBUG] shiftStart:",
      shiftStart.format("YYYY-MM-DD HH:mm:ss")
    );
    console.log(
      "[DEBUG] checkInStart:",
      checkInStart.format("YYYY-MM-DD HH:mm:ss")
    );
    console.log(
      "[DEBUG] checkInEnd:",
      checkInEnd.format("YYYY-MM-DD HH:mm:ss")
    );
    console.log(
      "[DEBUG] checkOutStart:",
      checkOutStart.format("YYYY-MM-DD HH:mm:ss")
    );
    console.log(
      "[DEBUG] checkOutDeadline:",
      checkOutDeadline.format("YYYY-MM-DD HH:mm:ss")
    );

    let updated = false;

    // Update OTStart if within check-in range
    if (
      !chosenShift.OTStart &&
      scanTime.isBetween(checkInStart, checkInEnd, null, "[]")
    ) {
      console.log("[DEBUG] Check-in condition met, updating OTStart.");
      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), chosenShift.ShiftID)
        .input("OTStart", sql.DateTime, scanTime.toDate())
        .query(
          `UPDATE Attendance SET OTStart = @OTStart WHERE AccountID = @AccountID AND ShiftID = @ShiftID`
        );
      updated = true;
    }

    // Update OTEnd if within check-out range
    if (
      !chosenShift.OTEnd &&
      scanTime.isBetween(checkOutStart, checkOutDeadline, null, "[]")
    ) {
      console.log("[DEBUG] Check-out condition met, updating OTEnd.");
      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), chosenShift.ShiftID)
        .input("OTEnd", sql.DateTime, scanTime.toDate())
        .query(
          `UPDATE Attendance SET OTEnd = @OTEnd WHERE AccountID = @AccountID AND ShiftID = @ShiftID`
        );
      updated = true;
    }

    // Determine if both OTStart and OTEnd exist to set attendance status
    const statusSet = await pool
      .request()
      .input("AccountID", sql.VarChar(100), AccountID)
      .input("ShiftID", sql.VarChar(100), chosenShift.ShiftID)
      .query(
        `SELECT OTStart, OTEnd FROM Attendance WHERE AccountID = @AccountID AND ShiftID = @ShiftID`
      );
    const { OTStart, OTEnd } = statusSet.recordset[0];

    console.log("[DEBUG] OTStart, OTEnd:", OTStart, OTEnd);

    if (OTStart && OTEnd) {
      const rawStart = dayjs(OTStart).tz(vnTz);
      const status = rawStart.isSameOrBefore(checkInEnd) ? "present" : "late";
      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), chosenShift.ShiftID)
        .input("status", sql.VarChar(50), status)
        .query(
          `UPDATE Attendance SET status = @status WHERE AccountID = @AccountID AND ShiftID = @ShiftID`
        );
    }

    // Log the scan to AttendanceLog
    await pool
      .request()
      .input("UID", sql.VarChar(20), UID)
      .input("ScanTime", sql.DateTime, scanTime.toDate())
      .input("IPAddress", sql.VarChar(45), IPAddress)
      .input("IsRecognized", sql.Bit, 1)
      .input("Note", sql.NVarChar(255), Note)
      .query(`INSERT INTO AttendanceLog (UID, ScanTime, IPAddress, IsRecognized, Note)
              VALUES (@UID, @ScanTime, @IPAddress, @IsRecognized, @Note)`);

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
