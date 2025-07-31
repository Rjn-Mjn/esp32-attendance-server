const cron = require("node-cron");
const markAbsentShifts = require("../services/attendanceAbsentScheduler");

// Chạy mỗi 10 phút
cron.schedule("*/10 * * * *", async () => {
  console.log("⏰ Cron Job: Running markAbsentShifts...");
  try {
    await markAbsentShifts();
    console.log("✅ markAbsentShifts completed successfully");
  } catch (err) {
    console.error("❌ Error in markAbsentShifts:", err);
  }
});
