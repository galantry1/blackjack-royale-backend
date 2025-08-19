// server.cjs
const express = require("express");
const http = require("http");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Server: IOServer } = require("socket.io");
const fs = require("fs");
const path = require("path");

/* ---------- App / HTTP ---------- */
const app = express();
app.use(cors({ origin: "*"}));
app.use(bodyParser.json());

// полезно для проверок Render
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.send("ok"));

const server = http.createServer(app);

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;


/* ---------- Socket.IO ---------- */
const io = new IOServer(server, {
  path: "/socket.io",
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["polling", "websocket"], // СНАЧАЛА polling → потом апгрейд в WS
  pingInterval: 25000,
  pingTimeout: 60000,
  allowEIO3: true,
});

/* ---------- Файловая "БД" ---------- */
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const balancesPath = path.join(DATA_DIR, "balances.json");
const historyPath  = path.join(DATA_DIR, "history.json");
const refsPath     = path.join(DATA_DIR, "refs.json");

const readJSON = (f, fb) => { try { return JSON.parse(fs.readFileSync(f,"utf8")); } catch { return fb; } };
const writeJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

let balances = readJSON(balancesPath, {}); // userId -> { balance,wins,profit }
let history  = readJSON(historyPath, []);  // [{ userId, roundId, type, amount, ts }]
let refs     = readJSON(refsPath, {});     // { userId: refCode, ... }

// утилиты для Blackjack
const SUITS = ["♠","♥","♦","♣"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const randId = () => (global.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
const cardValue = (r) => r==="A"?11:(["K","Q","J"].includes(r)?10:parseInt(r,10));
function handValue(cards) {
  let t=0, a=0;
  for (const c of cards) { t+=cardValue(c.rank); if (c.rank==="A") a++; }
  while (t>21 && a>0) { t-=10; a--; }
  return t;
}
function createDeck() {
  const d=[]; for (const s of SUITS) for (const r of RANKS) d.push({rank:r,suit:s});
  for (let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}
  return d;
}

// выплаты (как у тебя)
const PAYOUT = {
  win: (stake) => Math.floor(stake * 1.9),
  push: (stake) => stake,
};

// баланс/история – общие функции
function ensureUser(u) {
  balances[u] ??= { balance: 500, wins: 0, profit: 0 };
}
function commit() {
  writeJSON(balancesPath, balances);
  writeJSON(historyPath, history.slice(0, 1000));
}

// REST
app.post("/init", (req,res) => {
  const { userId, start=500 } = req.body || {};
  if (!userId) return res.status(400).json({ ok:false, error:"no userId" });
  balances[userId] ??= { balance:start, wins:0, profit:0 };
  commit();
  res.json({ ok:true, balance: balances[userId].balance });
});
app.post("/balance", (req,res) => {
  const { userId } = req.body || {};
  ensureUser(userId);
  res.json({ ok:true, balance: balances[userId].balance });
});
app.post("/bet", (req,res) => {
  const { userId, amount, roundId } = req.body || {};
  if (!userId || !amount || !roundId) return res.status(400).json({ ok:false });
  ensureUser(userId);

  const already = history.find(h => h.roundId===roundId && h.type==="bet");
  if (already) return res.json({ ok:true, success:true, balance: balances[userId].balance });

  if (balances[userId].balance < amount)
    return res.json({ ok:true, success:false, message:"Недостаточно средств" });

  balances[userId].balance -= amount;
  balances[userId].profit  -= amount;
  history.unshift({ userId, roundId, type:"bet", amount, ts: Date.now() });
  commit();
  res.json({ ok:true, success:true, balance: balances[userId].balance });
});
app.post("/win", (req,res) => {
  const { userId, amount, roundId } = req.body || {};
  if (!userId || amount==null || !roundId) return res.status(400).json({ ok:false });

  ensureUser(userId);
  const already = history.find(h => h.roundId===roundId && h.type==="win");
  if (already) return res.json({ ok:true, success:true, balance: balances[userId].balance });

  balances[userId].balance += amount;
  balances[userId].profit  += amount;
  if (amount>0) balances[userId].wins += 1;

  history.unshift({ userId, roundId, type:"win", amount, ts: Date.now() });
  commit();
  res.json({ ok:true, success:true, balance: balances[userId].balance });
});
app.post("/topup", (req,res) => {
  const { userId, amount } = req.body || {};
  ensureUser(userId);
  balances[userId].balance += Number(amount)||0;
  commit();
  res.json({ ok:true, balance: balances[userId].balance });
});
app.get("/leaderboard", (req,res) => {
  const metric = String(req.query.metric||"wins");
  const limit = Number(req.query.limit||20);
  const entries = Object.entries(balances).map(([userId,v])=>({
    userId, wins:v.wins||0, profit:v.profit||0
  }));
  const sorted = entries.sort((a,b)=> metric==="profit" ? b.profit-a.profit : b.wins-a.wins).slice(0,limit);
  res.json({ entries: sorted });
});

/* ---------- Matchmaking / PvP Rooms ---------- */
const queues = new Map(); // stake -> [socket.id,...]
const rooms  = new Map(); // roomId -> state

function joinQueue(sock, stake) {
  if (!queues.has(stake)) queues.set(stake, []);
  const q = queues.get(stake);
  if (!q.includes(sock.id)) q.push(sock.id);

  if (q.length >= 2) {
    const a = q.shift();
    const b = q.shift();
    const roomId = Math.random().toString(36).slice(2,8);

    const deck = createDeck();
    const pA = [deck.pop(), deck.pop()];
    const pB = [deck.pop(), deck.pop()];

    const deadline = Date.now() + 30_000; // 30s на ходы

    const state = {
      roomId,
      stake,
      deck,
      deadline,
      players: [a,b],
      users: {
        [a]: { userId: io.sockets.sockets.get(a)?.data?.userId || `guest_${a}`, hand: pA, stood:false },
        [b]: { userId: io.sockets.sockets.get(b)?.data?.userId || `guest_${b}`, hand: pB, stood:false },
      },
      roundId: randId(),
    };
    rooms.set(roomId, state);

    io.to(a).emit("match-found", { roomId, stake, youId:a, oppId:b });
    io.to(b).emit("match-found", { roomId, stake, youId:b, oppId:a });
  }
}

function broadcastState(roomId) {
  const r = rooms.get(roomId);
  if (!r) return;
  for (const sid of r.players) {
    const you = r.users[sid];
    const oppSid = r.players.find(x=>x!==sid);
    const opp = r.users[oppSid];
    io.to(sid).emit("state", {
      roomId,
      stake: r.stake,
      deadline: r.deadline,
      you: { hand: you.hand, stood: you.stood, score: handValue(you.hand) },
      opp: { hand: opp.hand, stood: opp.stood, score: handValue(opp.hand) },
    });
  }
}

function trySettle(roomId, reason="") {
  const r = rooms.get(roomId);
  if (!r) return;

  const ps = r.players.map(sid => ({
    sid,
    userId: r.users[sid].userId,
    score: handValue(r.users[sid].hand),
    stood: r.users[sid].stood
  }));
  const allDone = (Date.now()>r.deadline) || ps.every(p => p.stood);

  if (!allDone) return;

  const [A,B] = ps;
  let resA = "push", resB = "push";
  // перебор блокирует дальнейшие ходы
  const aBust = A.score>21, bBust = B.score>21;
  if (aBust && bBust) { resA="push"; resB="push"; }
  else if (aBust && !bBust) { resA="lose"; resB="win"; }
  else if (!aBust && bBust) { resA="win"; resB="lose"; }
  else if (A.score > B.score) { resA="win"; resB="lose"; }
  else if (A.score < B.score) { resA="lose"; resB="win"; }
  else { resA="push"; resB="push"; }

  // начисления прямо тут (чтобы не дергать HTTP)
  const applyWinLocal = (userId, amount, roundId) => {
    ensureUser(userId);
    balances[userId].balance += amount;
    balances[userId].profit  += amount;
    if (amount>0) balances[userId].wins += 1;
    history.unshift({ userId, roundId, type:"win", amount, ts: Date.now() });
  };

  const s = r.stake;
  if (resA==="win") applyWinLocal(A.userId, PAYOUT.win(s), r.roundId);
  if (resB==="win") applyWinLocal(B.userId, PAYOUT.win(s), r.roundId);
  if (resA==="push") applyWinLocal(A.userId, PAYOUT.push(s), r.roundId);
  if (resB==="push") applyWinLocal(B.userId, PAYOUT.push(s), r.roundId);
  commit();

  io.to(A.sid).emit("result", { roomId, you: A.score, opp: B.score, result: resA, reason });
  io.to(B.sid).emit("result", { roomId, you: B.score, opp: A.score, result: resB, reason });

  rooms.delete(roomId);
}

function leaveAllQueues(sid){
  for (const q of queues.values()) {
    const i=q.indexOf(sid); if (i!==-1) q.splice(i,1);
  }
}

io.on("connection", (socket) => {
  socket.on("hello", ({ userId }) => { socket.data.userId = userId; });

  socket.on("queue", ({ stake }) => {
    joinQueue(socket, Number(stake)||10);
  });

  socket.on("ready", ({ roomId }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    socket.join(roomId);
    // старт: просто разошлем начальное состояние
    broadcastState(roomId);
  });

  socket.on("move", ({ roomId, action }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    const me = r.users[socket.id];
    if (!me) return;

    if (Date.now() > r.deadline) return trySettle(roomId, "timeout");

    if (action === "hit" && !me.stood) {
      const c = r.deck.pop();
      if (c) me.hand.push(c);
      if (handValue(me.hand) > 21) me.stood = true;
    }
    if (action === "stand") {
      me.stood = true;
    }

    broadcastState(roomId);
    trySettle(roomId);
  });

  socket.on("disconnect", () => {
    leaveAllQueues(socket.id);
    // если ливнул из активной комнаты — авто-сдача
    for (const [roomId, r] of rooms) {
      if (r.players.includes(socket.id)) {
        r.users[socket.id].stood = true;
        r.deadline = Date.now(); // мгновенно завершим
        trySettle(roomId, "disconnect");
      }
    }
  });
});

/* ---------- Start ---------- */
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => {
  console.log("Backend+WS listening on", PORT);
});
