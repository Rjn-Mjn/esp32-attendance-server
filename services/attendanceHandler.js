// services/attendanceHandler.js
const dayjs = require("dayjs");
const duration = require("dayjs/plugin/duration");
const isBetween = require("dayjs/plugin/isBetween");
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
const { poolPromise, sql } = require("../db/sql");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(isBetween);
dayjs.extend(isSameOrBefore);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(duration);

// 1 phút là 60 * 1000 ms
const MS_IN_MINUTE = 60000;

async function handleAttendance({ UID, timestamp, IPAddress, Note = null }) {
  const scanTime = dayjs.tz(timestamp, "Asia/Ho_Chi_Minh");
  const scanDate = scanTime.format("YYYY-MM-DD");
  const scanTimeStr = scanTime.format("HH:mm:ss");

  try {
    const pool = await poolPromise;

    // 1. Kiểm tra UID có tồn tại không
    const { recordset: uidRecords } = await pool
      .request()
      .input("uid", sql.NVarChar(20), UID)
      .query(`SELECT CardID FROM AttendanceCard WHERE UID = @uid`);

    if (uidRecords.length === 0) {
      console.log(`UID ${UID} không tồn tại trong hệ thống.`);
      await logUnrecognized(pool, UID, scanTime, IPAddress, "UID not found");
      return;
    }

    const cardID = uidRecords[0].CardID;

    // 1.2 Tìm Account tương ứng
    const { recordset: accountRecords } = await pool
      .request()
      .input("cardID", sql.VarChar(10), cardID)
      .query(`SELECT AccountID FROM Account WHERE CardID = @cardID`);

    if (accountRecords.length === 0) {
      console.log(`Không tìm thấy Account cho CardID ${cardID}`);
      await logUnrecognized(
        pool,
        UID,
        scanTime,
        IPAddress,
        "Account not found"
      );

      return;
    }

    const AccountID = accountRecords[0].AccountID;

    console.log("Date scanned: " + scanTimeStr);
    console.log("Date scanned: " + scanDate);
    console.log("AccountID: " + AccountID);

    // 2. Lấy ca hôm nay
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
      await logUnrecognized(pool, UID, scanTime, IPAddress, "No shift found");
      return;
    }

    const shift = attendanceResult.recordset[0];
    console.log(shift);
    console.log("Date scanned: " + scanDate);
    console.log("AccountID: " + AccountID);
    console.log("Ca: " + shift.ShiftID);

    const Duration = dayjs(shift.duration).tz("Asia/Ho_Chi_Minh");
    const shiftStart = dayjs(shift.StartTime).tz("Asia/Ho_Chi_Minh");
    const shiftEnd = shiftStart.add(Duration, "minute");
    console.log(shiftEnd);

    const intervalMs = dayjs.duration(shift.Interval).asMinutes();
    const checkInStart = shiftStart.subtract(intervalMs, "minute");
    const checkInEnd = shiftStart.add(intervalMs, "minute");
    const checkOutStart = shiftEnd.subtract(intervalMs, "millisecond");
    const checkOutDeadline = shiftEnd.add(intervalMs, "millisecond");

    let updated = false;

    // 3. Cập nhật OTStart nếu nằm trong thời gian check-in
    console.log("Thời điểm OTStart: " + shift.OTStart);
    console.log("Thời gian quét" + scanTime);
    console.log("Thời gian quét" + scanTimeStr);
    console.log(scanTime.isBetween(checkInStart, checkInEnd, null, "[]"));
    // console.log(scanTimeStr.isBetween(checkInStart, checkInEnd, null, "[]"));

    if (
      !shift.OTStart &&
      scanTime.isBetween(checkInStart, checkInEnd, null, "[]")
    ) {
      console.log("Chưa có OTStart và thời gian quét thỏa điều kiện");

      await pool
        .request()
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), shift.ShiftID)
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
        .input("AccountID", sql.VarChar(100), AccountID)
        .input("ShiftID", sql.VarChar(100), shift.ShiftID)
        .input("OTEnd", sql.DateTime, timestamp).query(`
          UPDATE Attendance SET OTEnd = @OTEnd
          WHERE AccountID = @AccountID AND ShiftID = @ShiftID
        `);
      updated = true;
    }

    // 5. Xác định Status nếu có đủ OTStart và OTEnd
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
      const startObj = dayjs(OTStart);
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

    // 6. Ghi log vào AttendanceLog
    await pool
      .request()
      .input("UID", sql.VarChar(20), UID)
      .input("ScanTime", sql.DateTime, scanTime)
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

// // attendanceHandler.js
// const { poolPromise, sql } = require("../db/sql");

// async function handleAttendance({
//   uid,
//   timestamp,
//   IPAddress = null,
//   Note = null,
// }) {
//   const pool = await poolPromise;

//   let isRecognized = 0; // Default: không hợp lệ

//   // 1. Kiểm tra UID có tồn tại không
//   const { recordset: uidRecords } = await pool
//     .request()
//     .input("uid", sql.NVarChar(20), uid)
//     .query(`SELECT CardID FROM AttendanceCard WHERE UID = @uid`);

//   if (uidRecords.length === 0) {
//     console.log(`UID ${uid} không tồn tại trong hệ thống.`);
//     await logToAttendanceLog(uid, IPAddress, Note, isRecognized); // Log thất bại
//     return;
//   }

//   const cardID = uidRecords[0].CardID;

//   // 2. Tìm Account tương ứng
//   const { recordset: accountRecords } = await pool
//     .request()
//     .input("cardID", sql.VarChar(10), cardID)
//     .query(`SELECT AccountID FROM Account WHERE CardID = @cardID`);

//   if (accountRecords.length === 0) {
//     console.log(`Không tìm thấy Account cho CardID ${cardID}`);
//     await logToAttendanceLog(uid, IPAddress, Note, isRecognized);
//     return;
//   }

//   const accountID = accountRecords[0].AccountID;
//   isRecognized = 1; // Đã xác định được Account

//   // 3. Tìm Attendance tương ứng trong ngày hôm đó
//   const now = new Date(timestamp || Date.now());
//   const dateOnly = now.toISOString().split("T")[0];

//   const { recordset: shiftRecords } = await pool
//     .request()
//     .input("accountID", sql.VarChar(100), accountID)
//     .input("date", sql.Date, dateOnly).query(`
//       SELECT ShiftID, OTStart, OTEnd
//       FROM Attendance
//       WHERE AccountID = @accountID AND [date] = @date AND isDeleted = 0
//     `);

//   if (shiftRecords.length === 0) {
//     console.log(
//       `Không có ca nào cho Account ${accountID} vào ngày ${dateOnly}`
//     );
//     await logToAttendanceLog(uid, IPAddress, Note, isRecognized);
//     return;
//   }

//   // 4. Tìm ca phù hợp nhất dựa theo thời gian
//   let selectedShift = null;
//   const nowMs = now.getTime();

//   for (const shift of shiftRecords) {
//     const start = shift.OTStart?.getTime();
//     const end = shift.OTEnd?.getTime();

//     if (start && !end && nowMs >= start) {
//       selectedShift = { ...shift, action: "checkout" };
//       break;
//     }

//     if (!start && !end) {
//       selectedShift = { ...shift, action: "checkin" };
//       break;
//     }
//   }

//   if (!selectedShift) {
//     console.log(`❌ Không tìm được ca phù hợp để chấm công cho ${accountID}`);
//     await logToAttendanceLog(uid, IPAddress, Note, isRecognized);
//     return;
//   }

//   const { ShiftID, action } = selectedShift;

//   // 5. Cập nhật Attendance: OTStart hoặc OTEnd
//   const updateQuery = `
//     UPDATE Attendance
//     SET ${action === "checkin" ? "OTStart" : "OTEnd"} = @time
//     WHERE AccountID = @accountID AND ShiftID = @shiftID AND [date] = @date
//   `;

//   await pool
//     .request()
//     .input("time", sql.DateTime, now)
//     .input("accountID", sql.VarChar(100), accountID)
//     .input("shiftID", sql.VarChar(100), ShiftID)
//     .input("date", sql.Date, dateOnly)
//     .query(updateQuery);

//   console.log(
//     `✅ Đã ${
//       action === "checkin" ? "vào ca" : "ra ca"
//     } cho ${accountID} - Shift ${ShiftID}`
//   );
//   await logToAttendanceLog(uid, IPAddress, Note, isRecognized);
// }

// // Hàm ghi AttendanceLog
// async function logToAttendanceLog(uid, ip, note, isRecognized) {
//   const pool = await poolPromise;

//   await pool
//     .request()
//     .input("UID", sql.VarChar(20), uid)
//     .input("IPAddress", sql.VarChar(45), ip)
//     .input("Note", sql.NVarChar(255), note)
//     .input("isRecognized", sql.Bit, isRecognized).query(`
//       INSERT INTO AttendanceLog (UID, IPAddress, Note, isRecognized)
//       VALUES (@UID, @IPAddress, @Note, @isRecognized)
//     `);
// }

// module.exports = handleAttendance;
