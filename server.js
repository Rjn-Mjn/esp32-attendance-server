const net = require("net");
const { handleAttendance } = require("./services/attendanceHandler");

const server = net.createServer((socket) => {
  let buffer = ""; // Để lưu message đến khi đủ

  socket.on("data", async (data) => {
    buffer += data.toString();

    // Nếu ESP32 gửi kết thúc bằng newline thì xử lý
    let boundary = buffer.indexOf("\n");
    while (boundary !== -1) {
      const message = buffer.substring(0, boundary).trim(); // lấy từng dòng JSON
      buffer = buffer.substring(boundary + 1); // cắt phần đã xử lý

      try {
        const payload = JSON.parse(message); // phải là { uid, timestamp }
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
  console.log("Server is listening on port 5000");
});
