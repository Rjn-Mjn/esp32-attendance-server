// tcp/tcpServer.js
const net = require("net");
const { handleAttendanceLog } = require("../services/attendanceHandler");

const PORT = 3001; // Port riêng cho ESP32

function startTcpServer() {
  const server = net.createServer((socket) => {
    console.log("📡 ESP32 connected");

    socket.on("data", async (data) => {
      try {
        const message = data.toString().trim();
        const [uid, timestamp] = message.split(",");

        console.log(`✅ Received from ESP32: UID=${uid}, Time=${timestamp}`);

        await handleAttendanceLog(uid, timestamp);

        socket.write("✅ Attendance logged\n");
      } catch (err) {
        console.error("❌ Error handling data:", err.message);
        socket.write("❌ Failed to log attendance\n");
      }
    });

    socket.on("end", () => console.log("👋 ESP32 disconnected"));
    socket.on("error", (err) => console.error("Socket error:", err.message));
  });

  server.listen(PORT, () => {
    console.log(`🚀 TCP Server for ESP32 is running on port ${PORT}`);
  });
}

module.exports = { startTcpServer };
