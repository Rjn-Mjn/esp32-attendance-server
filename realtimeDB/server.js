const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
  },
});

let latestUID = null;

app.use(cors());
app.use(express.json());

app.post("/upload", (req, res) => {
  const { uid } = req.body;
  if (uid) {
    latestUID = uid;
    console.log("Received UID:", uid);
    io.emit("new_uid", uid); // gửi UID mới đến client
    res.sendStatus(200);
  } else {
    res.status(400).send("No UID provided");
  }
});

io.on("connection", (socket) => {
  console.log("Java Swing connected:", socket.id);
  if (latestUID) {
    socket.emit("new_uid", latestUID); // Gửi UID hiện tại nếu có
  }
});

const PORT = 3002;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
