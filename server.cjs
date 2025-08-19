// backend/server.cjs — CommonJS + Socket.IO PvP: очередь по ставкам, параллельные ходы, таймер 30с, выплаты
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
// принять сырые строки в /init
app.use((req, _res, next) => {
  if (typeof req.body === "string") {
    const s = req.body.trim();
    try { req.body = JSON.parse(s); } catch { req.body = { userId: s }; }
  }
  next();
});

/* ====== storage ====== */
const DATA_DIR = path.join(__dirname, "data");
const BAL_PATH = path.join(DATA_DIR, "balances.json");
const HIS_PATH = path.join(DATA_DIR, "history.json");
const USERS_PATH = path.join(DATA_DIR, "users.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
for (const p of [BAL_PATH, HIS_PATH, USERS_PATH]) if (!fs.existsSync(p)) fs.writeFileSync(p, p === HIS_PATH ? "[]" : "{}", "utf8");

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8") || (p === HIS_PATH ? "[]" : "{}")); } catch { return p === HIS_PATH ? [] : {}; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");

const getBalances = () => readJson(BAL_PATH);
const getHistory  = () => readJson(HIS_PATH);
const getUsers    = () => readJson(USERS_PATH);
const saveBalances = (v) => writeJson(BAL_PATH, v);
const saveHistory  = (v) => writeJson(HIS_PATH, v);
const saveUsers    = (v) => writeJson(USERS_PATH, v);

function ensureUser(userId) {
  const b = getBalances();
  if (!(userId in b)) { b[userId] = 1000; saveBalances(b); }
}
function addHistoryOnce(entry) {
  const h = getHistory();
  if (entry.roundId && h.some(x => x.roundId === entry.roundId && x.type === entry.type && x.userId === entry.userId)) return false;
  h.push({ ...entry, ts: Date.now() });
  saveHistory(h);
  return true;
}

/* ====== REST ====== */
app.get("/health", (_, res) => res.send("ok"));

app.post("/init", (req, res) => {
  const { userId, username=null, first_name=null, last_name=null, displayName=null } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  const users = getUsers();
  const name = displayName || [first_name, last_name].filter(Boolean).join(" ") || username || userId;
  users[userId] = { username: username ?? users[userId]?.username ?? null, displayName: name ?? users[userId]?.displayName ?? null };
  saveUsers(users);
  ensureUser(userId);
  res.json({ ok: true });
});

app.post("/balance", (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  ensureUser(userId);
  res.json({ balance: getBalances()[userId] });
});

app.post("/bet", (req, res) => {
  const { userId, amount, roundId } = req.body || {};
  if (!userId || typeof amount !== "number" || !roundId) return res.status(400).json({ error: "bad params" });
  ensureUser(userId);
  const b = getBalances();
  if (b[userId] < amount) return res.status(400).json({ error: "insufficient" });
  const ok = addHistoryOnce({ userId, type: "bet", amount: Math.floor(amount), roundId });
  if (!ok) return res.json({ success: true, balance: b[userId] });
  b[userId] -= Math.floor(amount);
  saveBalances(b);
  res.json({ success: true, balance: b[userId] });
});

app.post("/win", (req, res) => {
  const { userId, amount, roundId } = req.body || {};
  if (!userId || typeof amount !== "number" || !roundId) return res.status(400).json({ error: "bad params" });
  ensureUser(userId);
  const b = getBalances();
  const ok = addHistoryOnce({ userId, type: "win", amount: Math.floor(amount), roundId });
  if (!ok) return res.json({ success: true, balance: b[userId] });
  b[userId] += Math.floor(amount);
  saveBalances(b);
  res.json({ success: true, balance: b[userId] });
});

app.get("/leaderboard", (req, res) => {
  const metric = (req.query.metric || "wins").toString();
  const limit = Math.min(100, parseInt(req.query.limit || "20", 10));
  const users = getUsers();
  const history = getHistory();
  const wins = {}, profit = {};
  for (const h of history) {
    const u = h.userId; wins[u] ??= 0; profit[u] ??= 0;
    if (h.type === "win" && h.amount > 0) wins[u] += 1;
    if (h.type === "win")  profit[u] += h.amount;
    if (h.type === "bet")  profit[u] -= h.amount;
  }
  const entries = Object.keys({ ...wins, ...profit, ...users }).map((u) => ({
    userId: u,
    name: users[u]?.displayName || users[u]?.username || u,
    wins: wins[u] || 0,
    profit: profit[u] || 0,
  }));
  entries.sort((a,b)=> metric==="profit" ? b.profit-a.profit || b.wins-a.wins : b.wins-a.wins || b.profit-a.profit);
  res.json({ entries: entries.slice(0, limit) });
});

/* ====== PvP логика ====== */

const PAYOUT = { win: (stake) => Math.floor(stake * 1.9), push: (stake) => stake };
const MOVE_MS = 30_000; // 30с на действие

const queuesByStake = new Map(); // stake -> [{userId, socketId}]
const rooms = new Map(); // roomId -> room

const makeRoomId = () => Math.random().toString(36).slice(2, 8);

function createDeck() {
  const suits = ["S","H","D","C"], ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const d = [];
  for (const s of suits) for (const r of ranks) d.push(`${r}${s}`);
  for (let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}
const val = (r) => (r.startsWith("A")?11: ["K","Q","J","10"].some(x=>r.startsWith(x))?10:parseInt(r,10));
function handValue(h) {
  let t=0,a=0; for (const c of h){ const r=c.replace(/[SHDC]$/,""); t+=val(r); if(r==="A") a++; }
  while (t>21 && a>0){ t-=10; a--; } return t;
}

function startRoom(room) {
  room.deck = createDeck();
  room.hands = Object.fromEntries(room.players.map(u=>[u,[]]));
  room.stood = Object.fromEntries(room.players.map(u=>[u,false]));
  room.busted = Object.fromEntries(room.players.map(u=>[u,false]));
  room.timedOut = Object.fromEntries(room.players.map(u=>[u,false]));
  room.deadline = Object.fromEntries(room.players.map(u=>[u, Date.now()+MOVE_MS]));
  room.roundId = `pvp_${room.id}_${Date.now()}`;

  // списываем ставки идемпотентно
  const b = getBalances();
  for (const u of room.players) {
    ensureUser(u);
    const ok = addHistoryOnce({ userId: u, type: "bet", amount: room.stake, roundId: room.roundId });
    if (ok && (b[u] ?? 0) >= room.stake) b[u] -= room.stake;
  }
  saveBalances(b);

  // раздача 2x2
  for (let i=0;i<2;i++) for (const u of room.players) room.hands[u].push(room.deck.pop());

  io.to(room.id).emit("match_found", { roomId: room.id, players: room.players, stake: room.stake });
  broadcast(room.id);
  room.tick = setInterval(() => tickRoom(room.id), 1000);
}

function broadcast(roomId) {
  const r = rooms.get(roomId); if (!r) return;
  const sums = Object.fromEntries(r.players.map(u=>[u, handValue(r.hands[u])]));
  io.to(roomId).emit("pvp_state", {
    roomId,
    roundId: r.roundId,
    hands: r.hands,
    sums,
    stood: r.stood,
    deadline: r.deadline, // timestamp на каждого
    stake: r.stake,
  });
}

function endRoom(room, forcedLoser=null) {
  if (room.ended) return;
  room.ended = true;
  clearInterval(room.tick);

  const u1 = room.players[0], u2 = room.players[1];
  const s1 = handValue(room.hands[u1]), s2 = handValue(room.hands[u2]);
  let res1="push", res2="push";

  if (forcedLoser) {
    if (forcedLoser === u1) { res1="lose"; res2="win"; }
    else { res1="win"; res2="lose"; }
  } else {
    const b1 = s1>21, b2 = s2>21;
    if (b1 && b2) { res1="push"; res2="push"; }
    else if (b1) { res1="lose"; res2="win"; }
    else if (b2) { res1="win"; res2="lose"; }
    else if (s1 > s2) { res1="win"; res2="lose"; }
    else if (s1 < s2) { res1="lose"; res2="win"; }
    else { res1="push"; res2="push"; }
  }

  const b = getBalances();
  const pay = (u, kind) => {
    if (kind==="win")  { const amt=PAYOUT.win(room.stake); if (addHistoryOnce({userId:u,type:"win",amount:amt,roundId:room.roundId})) { b[u]=(b[u]??0)+amt; } }
    if (kind==="push") { const amt=PAYOUT.push(room.stake); if (addHistoryOnce({userId:u,type:"win",amount:amt,roundId:room.roundId})) { b[u]=(b[u]??0)+amt; } }
  };
  pay(u1,res1); pay(u2,res2);
  saveBalances(b);

  io.to(room.id).emit("pvp_end", { roomId: room.id, roundId: room.roundId, result: { [u1]:res1, [u2]:res2 }, sums: { [u1]:s1, [u2]:s2 } });
}

function maybeFinish(roomId) {
  const r = rooms.get(roomId); if (!r || r.ended) return;
  // если кто-то таймаутнулся — моментально окончание
  for (const u of r.players) if (r.timedOut[u]) return endRoom(r, u);
  const allStoodOrBust = r.players.every(u => r.stood[u] || handValue(r.hands[u])>21);
  if (allStoodOrBust) endRoom(r);
}

function tickRoom(roomId) {
  const r = rooms.get(roomId); if (!r || r.ended) return;
  const now = Date.now();
  let changed = false;
  for (const u of r.players) {
    if (!r.stood[u] && now > r.deadline[u]) {
      r.stood[u] = true;
      r.timedOut[u] = true; // автопоражение
      changed = true;
    }
  }
  if (changed) { broadcast(roomId); endRoom(r, r.timedOut[r.players[0]] ? r.players[0] : (r.timedOut[r.players[1]] ? r.players[1] : null)); return; }
}

/* ==== socket ==== */
io.on("connection", (socket) => {
  socket.on("hello", ({ userId }) => { socket.data.userId = String(userId || ""); });

  // подбор по ставке — join_queue({stake})
  socket.on("join_queue", ({ stake }) => {
    const userId = socket.data.userId;
    if (!userId || !Number.isFinite(stake) || stake<=0) return;
    let q = queuesByStake.get(stake);
    if (!q) { q = []; queuesByStake.set(stake, q); }
    const idx = q.findIndex(x => x.userId !== userId);
    if (idx >= 0) {
      const other = q.splice(idx,1)[0];
      const roomId = makeRoomId();
      const room = { id: roomId, players: [other.userId, userId], stake: Math.floor(stake) };
      rooms.set(roomId, room);
      io.sockets.sockets.get(other.socketId)?.join(roomId);
      socket.join(roomId);
      startRoom(room); // сразу старт, т.к. ставка уже известна у обоих
    } else {
      // если уже есть в очереди — заменим запись
      const selfIdx = q.findIndex(x=>x.userId===userId);
      if (selfIdx>=0) q.splice(selfIdx,1);
      q.push({ userId, socketId: socket.id });
      socket.emit("queued", { stake: Math.floor(stake) });
    }
  });

  socket.on("cancel_queue", ({ stake }) => {
    const q = queuesByStake.get(stake);
    if (!q) return socket.emit("queue_canceled");
    const i = q.findIndex((x) => x.socketId === socket.id);
    if (i >= 0) q.splice(i, 1);
    socket.emit("queue_canceled");
  });

  // действия в раунде
  socket.on("pvp_action", ({ roomId, action }) => {
    const r = rooms.get(roomId); if (!r || r.ended) return;
    const uid = socket.data.userId; if (!r.players.includes(uid)) return;

    // апдейт таймера игрока на каждое действие
    r.deadline[uid] = Date.now() + MOVE_MS;

    // запрет hit после перебора/стояния
    const sum = handValue(r.hands[uid]);
    if (action === "hit") {
      if (r.stood[uid] || sum>21) return;
      r.hands[uid].push(r.deck.pop());
      const s2 = handValue(r.hands[uid]);
      if (s2>21) r.stood[uid] = true; // авто-стоп при переборе
      broadcast(roomId);
      maybeFinish(roomId);
    } else if (action === "stand") {
      if (r.stood[uid]) return;
      r.stood[uid] = true;
      broadcast(roomId);
      maybeFinish(roomId);
    }
  });

  socket.on("disconnect", () => {
    // убрать из всех очередей
    for (const [stake, q] of queuesByStake) {
      const i = q.findIndex((x) => x.socketId === socket.id);
      if (i >= 0) q.splice(i, 1);
      if (q.length===0) queuesByStake.delete(stake);
    }
  });
});

server.listen(PORT, () => {
  console.log("Backend+WS listening on", PORT);
});
