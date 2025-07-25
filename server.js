const net = require("net");
const handleAttendance = require("./services/attendanceHandler");
require("./utils/cronJob"); // Gọi để khởi động cron schedule

const server = net.createServer((socket) => {
  let buffer = "";

  socket.on("data", async (data) => {
    buffer += data.toString();

    let boundary = buffer.indexOf("\n");
    while (boundary !== -1) {
      const message = buffer.substring(0, boundary).trim();
      buffer = buffer.substring(boundary + 1);

      try {
        const raw = JSON.parse(message); // raw: { uid, timestamp }
        console.log("message received: " + message);

        // Bổ sung thêm IPAddress và UID
        const payload = {
          uid: raw.uid,
          timestamp: raw.timestamp,
          UID: raw.uid, // dùng làm UID trong AttendanceLog
          IPAddress: socket.remoteAddress?.replace(/^.*:/, ""), // Lấy IP client
          Note: null, // Nếu cần có thể thay đổi theo ý bạn
        };

        await handleAttendance(payload);
        socket.write("Received\n");
      } catch (err) {
        console.error("Parse/Handle Error:", err);
        socket.write("Error processing data\n");
      }

      boundary = buffer.indexOf("\n");
    }
  });

  socket.on("error", (err) => {
    console.error("Socket Error:", err);
  });
});

server.listen(5000, () => {
  console.log("✅ Server is listening on port 5000");
});
