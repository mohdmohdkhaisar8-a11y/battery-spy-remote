const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const PORT = process.env.PORT || 3000;

// In-memory rooms only: no battery readings are saved to disk or a database.
const rooms = new Map();
const CODE_TTL_MS = 10 * 60 * 1000;

function makeCode() {
  let code;
  do { code = String(crypto.randomInt(100000, 1000000)); }
  while (rooms.has(code));
  return code;
}

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true }));

io.on("connection", (socket) => {
  socket.on("create-room", (ack) => {
    const code = makeCode();
    const room = { dashboardId: socket.id, senderId: null, expiresAt: Date.now() + CODE_TTL_MS };
    rooms.set(code, room);
    socket.join(code);
    socket.data.role = "dashboard";
    socket.data.code = code;
    if (typeof ack === "function") ack({ ok: true, code, expiresInMinutes: 10 });
  });

  socket.on("join-as-sender", ({ code }, ack) => {
    code = String(code || "").trim();
    const room = rooms.get(code);
    if (!/^\d{6}$/.test(code) || !room || room.expiresAt < Date.now()) {
      rooms.delete(code);
      if (typeof ack === "function") ack({ ok: false, error: "Code invalid or expired. Ask your friend for a new code." });
      return;
    }
    if (room.senderId && room.senderId !== socket.id) {
      if (typeof ack === "function") ack({ ok: false, error: "A phone is already connected to this code." });
      return;
    }
    room.senderId = socket.id;
    socket.join(code);
    socket.data.role = "sender";
    socket.data.code = code;
    io.to(room.dashboardId).emit("friend-connected");
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("battery-update", (reading) => {
    const code = socket.data.code;
    const room = code && rooms.get(code);
    if (socket.data.role !== "sender" || !room || room.senderId !== socket.id) return;
    const level = Number(reading && reading.level);
    if (!Number.isFinite(level) || level < 0 || level > 100) return;
    io.to(room.dashboardId).emit("battery-reading", {
      level: Math.round(level),
      charging: Boolean(reading.charging),
      updatedAt: Date.now()
    });
  });

  socket.on("stop-sharing", () => {
    const code = socket.data.code;
    const room = code && rooms.get(code);
    if (socket.data.role === "sender" && room && room.senderId === socket.id) {
      room.senderId = null;
      io.to(room.dashboardId).emit("friend-stopped");
    }
    socket.data.role = null;
    socket.data.code = null;
  });

  socket.on("disconnect", () => {
    const code = socket.data.code;
    const room = code && rooms.get(code);
    if (!room) return;
    if (room.senderId === socket.id) {
      room.senderId = null;
      io.to(room.dashboardId).emit("friend-stopped");
    }
    if (room.dashboardId === socket.id) {
      io.to(code).emit("room-closed");
      rooms.delete(code);
    }
  });
});

setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.expiresAt < Date.now()) {
      io.to(code).emit("room-closed");
      rooms.delete(code);
    }
  }
}, 30_000).unref();

server.listen(PORT, () => console.log(`Battery Spy running on port ${PORT}`));
