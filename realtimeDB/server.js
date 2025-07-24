const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json());

let latestUID = null;

// Khi ESP32 gửi UID về:
app.post("/upload", (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).send("Missing UID");

  latestUID = uid;
  console.log("[ESP32] New UID:", uid);

  // Phát sự kiện qua WebSocket:
  io.emit("newUID", uid);

  res.status(200).send("UID received");
});

// Khi Java Swing muốn lấy UID hiện tại:
app.get("/latest-uid", (req, res) => {
  res.json({ uid: latestUID });
});

// WebSocket: cho phép client kết nối lắng nghe realtime
io.on("connection", (socket) => {
  console.log("Client connected via WebSocket");
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
