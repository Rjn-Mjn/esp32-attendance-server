const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let clients = new Set();
let latestUID = null;

// HTTP endpoint để ESP32 POST UID
app.post("/send-uid", (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).send("Missing uid");
  latestUID = uid;
  // Broadcast tới tất cả client WS
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(uid);
    }
  });
  console.log("[ESP32] UID sent:", uid);
  res.sendStatus(200);
});

// WS: khi có client connect
wss.on("connection", (ws) => {
  console.log("🔌 Swing connected");
  clients.add(ws);
  // gửi ngay UID hiện tại nếu đã có
  if (latestUID) ws.send(latestUID);

  ws.on("close", () => clients.delete(ws));
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
