const net = require("net");
const { handleAttendance } = require("./services/attendanceHandler");

const server = net.createServer((socket) => {
  socket.on("data", async (data) => {
    const message = data.toString().trim();
    try {
      const payload = JSON.parse(message);
      await handleAttendance(payload); // { uid, timestamp }
      socket.write("Received");
    } catch (err) {
      console.error("Error:", err);
      socket.write("Error processing data");
    }
  });
});

server.listen(5000, () => {
  console.log("Server is listening on port 5000");
});
