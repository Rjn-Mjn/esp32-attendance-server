const net = require("net");
const { handleAttendance } = require("./services/attendanceHandler");

server.on("connection", (socket) => {
  let buffer = "";

  socket.on("data", (data) => {
    buffer += data.toString();

    try {
      const json = JSON.parse(buffer); // Nếu parse được thì tiếp tục
      buffer = ""; // Clear buffer nếu thành công

      console.log("✅ JSON Received:", json);
      handleAttendance(json); // xử lý tiếp
    } catch (e) {
      // Nếu lỗi là do chưa đủ JSON → đợi thêm data
      if (e.message.includes("Unexpected end of JSON input")) {
        return;
      }

      // Nếu là lỗi khác → in ra
      console.error("❌ JSON Parse Error:", e);
      buffer = ""; // Clear buffer nếu là lỗi thật sự
    }
  });
});

server.listen(5000, () => {
  console.log("Server is listening on port 5000");
});
