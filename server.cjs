// server.cjs
const express = require("express");
const http = require("http");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Server: IOServer } = require("socket.io");
const fs = require("fs");
const path = require("path");

/* ---------- Express / HTTP ---------- */
const app = express();
app.use(cors({ origin: "*" }));
app.use(bodyParser.json());
const server = http.createServer(app);

/* ---------- Socket.IO ---------- */
const io = new IOServer(server, {
  path: "/socket.io",
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

/* ---------- Файловая "БД" ---------- */
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const balancesPath = path.join(DATA_DIR, "balances.json");
const historyPath = path.join(DATA_DIR, "history.json");
const refsPath = path.join(DATA_DIR, "refs.json");

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let balances = readJSON(balancesPath, {});   // userId -> { balance, wins, profit, name? }
let history  = readJSON(historyPath,  []);   // журнал идемпотентности/операций
let refs     = readJSON(refsPath,     {});   // { userId: refCode, usedBy: [] }

/* ---------- REST ---------- */
app.get("/health", (_req, res) => res.send("ok"));

app.post("/init", (req, res) => {
  const { userId, start = 500, username, first_name, last_name, displayName } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: "no userId" });

  balances[userId] ??= { balance: start, wins: 0, profit: 0 };
  // обновим имя/ник, если пришло
  const name = displayName || username || [first_name, last_name].filter(Boolean).join(" ");
  if (name) balances[userId].name = name;

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

  const already = history.find(h => h.roundId === roundId && h.type === "bet");
  if (already) return res.json({ ok: true, success: true, balance: balances[userId].balance });

  if (balances[userId].balance < amount) {
    return res.json({ ok: true, success: false, message: "no funds" });
  }

  balances[userId].balance -= amount;
  balances[userId].profit  -= amount;
  history.unshift({ userId, roundId, type: "bet", amount, ts: Date.now() });

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
  const limit  = Number(req.query.limit || 20);

  const entries = Object.entries(balances).map(([userId, v]) => ({
    userId,
    wins: v.wins || 0,
    profit: v.profit || 0,
    name: v.name || null,
  }));

  const sorted = entries
    .sort((a, b) => (metric === "profit" ? b.profit - a.profit : b.wins - a.wins))
    .slice(0, limit);

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

/* ---- простые рефы, чтобы фронт не падал ---- */
app.post("/reflink", (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false });
  refs[userId] ??= { code: userId.slice(-6), usedBy: [] };
  writeJSON(refsPath, refs);
  const code = refs[userId].code;
  res.json({
    web: `https://example.com/?ref=${code}`,
    telegram: `https://t.me/your_bot?start=${code}`,
  });
});
app.post("/apply-ref", (req, res) => {
  const { userId, code } = req.body || {};
  if (!userId || !code) return res.status(400).json({ ok: false });
  const ownerId = Object.keys(refs).find(uid => refs[uid].code === code);
  if (ownerId && ownerId !== userId) {
    refs[ownerId].usedBy ||= [];
    if (!refs[ownerId].usedBy.includes(userId)) refs[ownerId].usedBy.push(userId);
    writeJSON(refsPath, refs);
  }
  res.json({ success: true });
});

/* ---------- PVP Игра 1-на-1 (серверная механика) ---------- */
const queues = new Map(); // stake -> [{ socketId, userId, name, roundId }]
const rooms  = new Map(); // roomId -> { stake, players:[{socketId,userId,name,roundId,hand,stood,moved}], deck, deadline, timer }

function createDeck() {
  const suits  = ["♠","♥","♦","♣"];
  const ranks  = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({ suit: s, rank: r });
  return deck;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
function cardPoints(rank) {
  if (rank === "A") return 11;
  if (["K","Q","J"].includes(rank)) return 10;
  return parseInt(rank, 10);
}
function handPoints(hand) {
  let total = 0, aces = 0;
  for (const c of hand) {
    total += cardPoints(c.rank);
    if (c.rank === "A") aces++;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function publicState(room) {
  return {
    stake: room.stake,
    deadline: room.deadline,
    players: room.players.map(p => ({
      userId: p.userId,
      name: p.name || null,
      hand: p.hand,
      stood: p.stood,
      points: handPoints(p.hand),
    })),
  };
}

function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const deck = createDeck();
  shuffle(deck);

  // сдача по 2 карты
  for (const p of room.players) {
    p.hand = [deck.pop(), deck.pop()];
    p.stood = false;
    p.moved = false; // для авто-проигрыша, если ни разу не походил
  }

  room.deck = deck;
  room.deadline = Date.now() + 30_000;

  // тикаем раз в 1 сек, на дедлайне — автодействия
  room.timer && clearInterval(room.timer);
  room.timer = setInterval(() => tickRoom(roomId), 1000);

  io.to(roomId).emit("start", { roomId, state: publicState(room) });
  io.to(roomId).emit("state", { roomId, state: publicState(room) });
}

function tickRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (Date.now() < room.deadline) return;

  // дедлайн — автопереход к завершению
  for (const p of room.players) {
    if (!p.stood && !p.moved) {
      // не сделал ни одного действия — автопроигрыш
      p.forfeit = true;
      p.stood = true;
    } else if (!p.stood) {
      // делал действия, но не нажал "стоп" — авто-стоп
      p.stood = true;
    }
  }
  finishGame(roomId);
}

function handleMove(roomId, sock, action) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (Date.now() > room.deadline) return; // уже истёк дедлайн

  const p = room.players.find(pp => pp.socketId === sock.id);
  if (!p || p.stood) return;

  p.moved = true;

  if (action === "hit") {
    const card = room.deck.pop();
    if (!card) {
      p.stood = true;
    } else {
      p.hand.push(card);
      if (handPoints(p.hand) > 21) {
        p.stood = true; // перебор = автопасс
      }
    }
  } else if (action === "stand") {
    p.stood = true;
  }

  io.to(roomId).emit("state", { roomId, state: publicState(room) });

  // оба стоят — закончить
  if (room.players.every(pp => pp.stood)) {
    finishGame(roomId);
  }
}

function finishGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.timer && clearInterval(room.timer);

  const [p1, p2] = room.players;
  const pts1 = handPoints(p1.hand);
  const pts2 = handPoints(p2.hand);

  // логика результата
  let r1 = "push", r2 = "push";

  const bust1 = pts1 > 21;
  const bust2 = pts2 > 21;

  if (p1.forfeit && !p2.forfeit) { r1 = "lose"; r2 = "win"; }
  else if (!p1.forfeit && p2.forfeit) { r1 = "win"; r2 = "lose"; }
  else if (bust1 && !bust2) { r1 = "lose"; r2 = "win"; }
  else if (!bust1 && bust2) { r1 = "win"; r2 = "lose"; }
  else if (!bust1 && !bust2) {
    if (pts1 > pts2) { r1 = "win"; r2 = "lose"; }
    else if (pts1 < pts2) { r1 = "lose"; r2 = "win"; }
    else { r1 = "push"; r2 = "push"; }
  } else {
    // оба перебрали
    r1 = "push"; r2 = "push";
  }

  io.to(roomId).emit("game-over", {
    roomId,
    stake: room.stake,
    results: [
      { userId: p1.userId, result: r1, points: pts1, forfeit: !!p1.forfeit },
      { userId: p2.userId, result: r2, points: pts2, forfeit: !!p2.forfeit },
    ],
    state: publicState(room),
  });

  rooms.delete(roomId);
}

function leaveAllQueues(sockId) {
  for (const q of queues.values()) {
    const i = q.findIndex(x => x.socketId === sockId);
    if (i !== -1) q.splice(i, 1);
  }
}
function removeRoomBySocket(sockId) {
  for (const [rid, room] of rooms.entries()) {
    const hit = room.players.some(p => p.socketId === sockId);
    if (hit) {
      // диск-коннект — победа оппонента
      const other = room.players.find(p => p.socketId !== sockId);
      room.players.forEach(p => {
        if (p.socketId === sockId) { p.forfeit = true; p.stood = true; }
        else { p.stood = true; }
      });
      finishGame(rid);
    }
  }
}

function joinQueue(sock, payload) {
  const stake = Number(payload.stake) || 10;
  const roundId = payload.roundId || null;
  const name = payload.name || null;
  const userId = sock.data.userId;

  if (!queues.has(stake)) queues.set(stake, []);
  const q = queues.get(stake);
  if (!q.some(x => x.socketId === sock.id)) {
    q.push({ socketId: sock.id, userId, name, roundId });
  }

  if (q.length >= 2) {
    const a = q.shift();
    const b = q.shift();
    const roomId = Math.random().toString(36).slice(2, 8);

    rooms.set(roomId, {
      stake,
      deck: [],
      deadline: 0,
      timer: null,
      players: [
        { ...a, hand: [], stood: false, moved: false, forfeit: false },
        { ...b, hand: [], stood: false, moved: false, forfeit: false },
      ],
    });

    io.to(a.socketId).emit("match-found", { roomId, stake, players: [a.userId, b.userId] });
    io.to(b.socketId).emit("match-found", { roomId, stake, players: [a.userId, b.userId] });
    // старт после READY от обоих (ниже)
  }
}

/* ---------- Socket.IO handlers ---------- */
io.on("connection", (socket) => {
  socket.on("hello", ({ userId, name }) => {
    socket.data.userId = userId;
    socket.data.name = name || null;
  });

  socket.on("queue", (payload) => {
    joinQueue(socket, { ...payload, name: socket.data.name });
  });

  socket.on("ready", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    socket.join(roomId);

    // оба в комнате? запускаем
    const roomSet = io.sockets.adapter.rooms.get(roomId);
    if (roomSet && roomSet.size >= 2) startGame(roomId);
  });

  socket.on("move", ({ roomId, action }) => {
    handleMove(roomId, socket, action);
  });

  socket.on("disconnect", () => {
    leaveAllQueues(socket.id);
    removeRoomBySocket(socket.id);
  });
});

/* ---------- START ---------- */
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => {
  console.log("Backend+WS listening on", PORT);
});
