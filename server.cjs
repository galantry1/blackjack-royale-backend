// server.cjs
const express = require("express");
const http = require("http");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Server: IOServer } = require("socket.io");
const fs = require("fs");
const path = require("path");

/* ---------- Basic setup ---------- */
const app = express();
app.use(cors({ origin: "*"}));
app.use(bodyParser.json());

/* ---------- HTTP server (ВАЖНО: io сидит на ЭТОМ сервере) ---------- */
const server = http.createServer(app);

/* ---------- Socket.IO ---------- */
const io = new IOServer(server, {
  path: "/socket.io",                      // тот же путь, что и на клиенте
  cors: { origin: "*", methods: ["GET","POST"] },
  transports: ["websocket", "polling"],    // разрешим оба — Render иногда не апгрейдит сразу
  serveClient: false,
  allowEIO3: true,                         // совместимость
});

/* ---------- Простая файловая "БД" ---------- */
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const balancesPath = path.join(DATA_DIR, "balances.json");
const historyPath  = path.join(DATA_DIR, "history.json");
const refsPath     = path.join(DATA_DIR, "refs.json");

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let balances = readJSON(balancesPath, {});
let history  = readJSON(historyPath, []);
let refs     = readJSON(refsPath, {});

/* ---------- REST ---------- */
app.get("/health", (_req, res) => res.send("ok"));

app.post("/init", (req, res) => {
  const { userId, start = 500 } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: "no userId" });
  if (!balances[userId]) balances[userId] = { balance: start, wins: 0, profit: 0 };
  writeJSON(balancesPath, balances);
  res.json({ ok: true, balance: balances[userId].balance });
});

app.post("/balance", (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: "no userId" });
  const b = balances[userId]?.balance ?? 0;
  res.json({ ok: true, balance: b });
});

app.post("/bet", (req, res) => {
  const { userId, amount, roundId } = req.body || {};
  if (!userId || !amount || !roundId) return res.status(400).json({ ok: false });
  balances[userId] ??= { balance: 500, wins: 0, profit: 0 };

  // идемпотентность по history
  const already = history.find(h => h.roundId === roundId && h.type === "bet");
  if (already) return res.json({ ok: true, success: true, balance: balances[userId].balance });

  if (balances[userId].balance < amount) return res.json({ ok: true, success: false, message: "no funds" });

  balances[userId].balance -= amount;
  history.unshift({ userId, roundId, type: "bet", amount, ts: Date.now() });
  balances[userId].profit -= amount;
  writeJSON(balancesPath, balances);
  writeJSON(historyPath, history.slice(0, 1000));

  res.json({ ok: true, success: true, balance: balances[userId].balance });
});

app.post("/win", (req, res) => {
  const { userId, amount, roundId } = req.body || {};
  if (!userId || amount == null || !roundId) return res.status(400).json({ ok: false });

  const already = history.find(h => h.roundId === roundId && h.type === "win");
  if (already) return res.json({ ok: true, success: true, balance: balances[userId].balance });

  balances[userId] ??= { balance: 500, wins: 0, profit: 0 };
  balances[userId].balance += amount;
  if (amount > 0) balances[userId].wins += 1;
  balances[userId].profit += amount;

  history.unshift({ userId, roundId, type: "win", amount, ts: Date.now() });
  writeJSON(balancesPath, balances);
  writeJSON(historyPath, history.slice(0, 1000));

  res.json({ ok: true, success: true, balance: balances[userId].balance });
});

app.get("/leaderboard", (req, res) => {
  const metric = (req.query.metric || "wins").toString();
  const limit = Number(req.query.limit || 20);
  const entries = Object.entries(balances).map(([userId, v]) => ({
    userId,
    wins: v.wins || 0,
    profit: v.profit || 0,
  }));
  const sorted = entries.sort((a, b) =>
    metric === "profit" ? b.profit - a.profit : b.wins - a.wins
  ).slice(0, limit);
  res.json({ entries: sorted });
});

app.post("/topup", (req, res) => {
  const { userId, amount } = req.body || {};
  if (!userId || !amount) return res.status(400).json({ ok: false });
  balances[userId] ??= { balance: 500, wins: 0, profit: 0 };
  balances[userId].balance += amount;
  writeJSON(balancesPath, balances);
  res.json({ ok: true, balance: balances[userId].balance });
});

/* ---------- Matchmaking (ставка -> очередь) ---------- */
const queues = new Map(); // stake -> [socketIds]
const rooms  = new Map(); // roomId -> { stake, players:[socketId], deadline }

function joinQueue(sock, stake) {
  if (!queues.has(stake)) queues.set(stake, []);
  const q = queues.get(stake);
  if (!q.includes(sock.id)) q.push(sock.id);

  if (q.length >= 2) {
    const a = q.shift();
    const b = q.shift();
    const roomId = Math.random().toString(36).slice(2, 8);
    rooms.set(roomId, { stake, players: [a, b], deadline: Date.now() + 30_000 });
    io.to(a).emit("match-found", { roomId, stake, players: rooms.get(roomId).players });
    io.to(b).emit("match-found", { roomId, stake, players: rooms.get(roomId).players });
  }
}

function leaveAllQueues(sockId) {
  for (const q of queues.values()) {
    const i = q.indexOf(sockId);
    if (i !== -1) q.splice(i, 1);
  }
}

io.on("connection", (socket) => {
  // кто ты
  socket.on("hello", ({ userId }) => {
    socket.data.userId = userId;
  });

  // встать в очередь по ставке
  socket.on("queue", ({ stake }) => {
    joinQueue(socket, Number(stake) || 10);
  });

  // подтверждение готовности к игре
  socket.on("ready", ({ roomId }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    socket.join(roomId);
    io.to(roomId).emit("player-ready", { userId: socket.data.userId, roomId });

    // если оба в комнате — старт
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.size >= 2) {
      io.to(roomId).emit("start", { roomId, deadline: Date.now() + 30_000 });
    }
  });

  // ходы: { roomId, action: 'hit'|'stand' }
  socket.on("move", ({ roomId, action, payload }) => {
    io.to(roomId).emit("move", { userId: socket.data.userId, action, payload, ts: Date.now() });
  });

  socket.on("disconnect", () => {
    leaveAllQueues(socket.id);
  });
});

/* ---------- PORT ---------- */
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => {
  console.log("Backend+WS listening on", PORT);
});
