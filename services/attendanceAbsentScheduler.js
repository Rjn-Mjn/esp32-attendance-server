// services/attendanceAbsentScheduler.js
const dayjs = require("dayjs");
const durationPlugin = require("dayjs/plugin/duration");
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
const timezone = require("dayjs/plugin/timezone");
const utc = require("dayjs/plugin/utc");

// Extend dayjs
dayjs.extend(durationPlugin);
dayjs.extend(isSameOrBefore);
dayjs.extend(utc);
dayjs.extend(timezone);

const { poolPromise, sql } = require("../db/sql");

// This function will be called periodically (e.g. every 5 minutes)
// to mark shifts as "absent" if they are overdue with no OTStart and OTEnd
async function markAbsentShifts() {
  try {
    const pool = await poolPromise;
    const now = dayjs().tz("Asia/Ho_Chi_Minh");
    console.log(
      "[ABSENT_CHECK] Current time:",
      now.format("YYYY-MM-DD HH:mm:ss")
    );

    const { recordset: overdueShifts } = await pool.request().query(`
      SELECT A.AccountID, A.ShiftID, A.OTStart, A.OTEnd, A.status,
             A.date, S.StartTime, S.Duration, ST.Interval
      FROM Attendance A
      JOIN Shift S ON A.ShiftID = S.ShiftID
      JOIN ShiftType ST ON S.STID = ST.ST_ID
      WHERE A.status = 'future' AND A.isDeleted = 0
    `);

    // console.log("[DEBUG] future shifts: ", overdueShifts);

    for (const shift of overdueShifts) {
      const shiftDate = dayjs(shift.date).format("YYYY-MM-DD");
      const startTime = dayjs.utc(shift.StartTime).format("HH:mm:ss");
      const shiftStart = dayjs(
        `${shiftDate} ${startTime}`,
        "YYYY-MM-DD HH:mm:ss"
      ).tz("Asia/Ho_Chi_Minh");

      const durationMinutes =
        shift.Duration.getUTCHours() * 60 + shift.Duration.getUTCMinutes();
      const intervalMinutes =
        shift.Interval.getUTCHours() * 60 + shift.Interval.getUTCMinutes();

      const shiftEndWithInterval = shiftStart.add(
        durationMinutes + intervalMinutes,
        "minute"
      );

      console.log(
        "[ABSENT_CHECK] Current time:",
        shiftEndWithInterval.format("YYYY-MM-DD HH:mm:ss")
      );

      let check =
        (!shift.OTStart || !shift.OTEnd) && now.isAfter(shiftEndWithInterval);
      console.log(check);

      console.log("[DEBUG] shiftDate: ", shiftDate);
      console.log("[DEBUG] startTime: ", startTime);
      console.log("[DEBUG] shiftStart: ", shiftStart);
      console.log("[DEBUG] durationMinutes: ", durationMinutes);
      console.log("[DEBUG] intervalMinutes: ", intervalMinutes);
      console.log("[DEBUG] shiftEndWithInterval: ", shiftEndWithInterval);

      if (
        (!shift.OTStart || !shift.OTEnd) &&
        now.isAfter(shiftEndWithInterval)
      ) {
        console.log(
          `[ABSENT] Marking AccountID ${shift.AccountID}, ShiftID ${shift.ShiftID}, DATE ${shift.date} as absent`
        );
        await pool
          .request()
          .input("AccountID", sql.VarChar(100), shift.AccountID)
          .input("ShiftID", sql.VarChar(100), shift.ShiftID)
          .input("date", sql.date, shift.date)
          .input("status", sql.VarChar(50), "absent")
          .query(
            `UPDATE Attendance SET status = @status WHERE AccountID = @AccountID AND ShiftID = @ShiftID AND date = @date`
          );
      }
    }
  } catch (err) {
    console.error("[ABSENT_ERROR] Failed to mark absent shifts:", err);
  }
}

module.exports = markAbsentShifts;
