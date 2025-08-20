/* ---------------- Core deps ---------------- */
const express = require("express");
const http = require("http");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Server: IOServer } = require("socket.io");
const fs = require("fs");
const path = require("path");

/* ---------------- App & HTTP ---------------- */
const app = express();
app.use(cors({ origin: "*" }));
app.use(bodyParser.json());

const server = http.createServer(app);

/* ---------------- Socket.IO ---------------- */
const io = new IOServer(server, {
  path: "/socket.io",
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  serveClient: false,
  allowEIO3: true,
});

/* ---------------- Tiny file “DB” ---------------- */
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

let balances = readJSON(balancesPath, {});   // { [userId]: { balance, wins, profit } }
let history  = readJSON(historyPath, []);    // [{...}]
let refs     = readJSON(refsPath, {          // { codes: {code: inviterId}, applied: {userId: code} }
  codes: {}, applied: {}
});

/* ---------------- Helpers ---------------- */
const SUITS52 = ["♠", "♥", "♦", "♣"];
const RANKS52 = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
function createDeck52() {
  const d = [];
  for (const s of SUITS52) for (const r of RANKS52) d.push({ rank: r, suit: s });
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function cardValue(rank) { if (rank === "A") return 11; if (["K", "Q", "J"].includes(rank)) return 10; return parseInt(rank, 10); }
function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { total += cardValue(c.rank); if (c.rank === "A") aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

/* ===================== REST ===================== */
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
  res.json({ ok: true, balance: balances[userId]?.balance ?? 0 });
});

app.post("/bet", (req, res) => {
  const { userId, amount, roundId } = req.body || {};
  if (!userId || !amount || !roundId) return res.status(400).json({ ok: false });
  balances[userId] ??= { balance: 500, wins: 0, profit: 0 };

  // идемпотентность
  const already = history.find(h => h.roundId === roundId && h.type === "bet" && h.userId === userId);
  if (already) return res.json({ ok: true, success: true, balance: balances[userId].balance });

  if (balances[userId].balance < amount) return res.json({ ok: true, success: false, message: "no funds" });

  balances[userId].balance -= amount;
  balances[userId].profit -= amount;
  history.unshift({ userId, roundId, type: "bet", amount, ts: Date.now() });
  writeJSON(balancesPath, balances);
  writeJSON(historyPath, history.slice(0, 1000));

  res.json({ ok: true, success: true, balance: balances[userId].balance });
});

app.post("/win", (req, res) => {
  const { userId, amount, roundId } = req.body || {};
  if (!userId || amount == null || !roundId) return res.status(400).json({ ok: false });

  const already = history.find(h => h.roundId === roundId && h.type === "win" && h.userId === userId);
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
  balances[userId].profit += amount;
  history.unshift({ userId, type: "topup", amount, ts: Date.now() });
  writeJSON(balancesPath, balances);
  writeJSON(historyPath, history.slice(0, 1000));
  res.json({ ok: true, balance: balances[userId].balance });
});

/* ---- рефералка ---- */
function makeRefCode(userId) {
  const base = userId.replace(/[^a-z0-9]/gi, "").slice(-6);
  let code = base || Math.random().toString(36).slice(2, 8);
  let i = 0;
  while (refs.codes[code] && refs.codes[code] !== userId) {
    code = (base || "ref") + (i++);
  }
  return code;
}

app.post("/reflink", (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: "no userId" });
  // выдаём (или создаём) код
  let code = Object.entries(refs.codes).find(([, uid]) => uid === userId)?.[0];
  if (!code) {
    code = makeRefCode(userId);
    refs.codes[code] = userId;
    writeJSON(refsPath, refs);
  }
  const web = `${process.env.FRONTEND_ORIGIN || ""}/?ref=${code}`.replace(/\/+\/\?/, "/?");
  const telegram = `https://t.me/${process.env.TG_BOT_USERNAME || "your_bot"}?start=ref-${code}`;
  res.json({ ok: true, web, telegram });
});

app.post("/apply-ref", (req, res) => {
  const { userId, code } = req.body || {};
  if (!userId || !code) return res.status(400).json({ ok: false });
  if (refs.applied[userId]) return res.json({ ok: true, success: true, message: "already_applied" });
  const inviter = refs.codes[code];
  if (!inviter || inviter === userId) return res.json({ ok: true, success: false, message: "invalid" });
  refs.applied[userId] = code;
  writeJSON(refsPath, refs);
  res.json({ ok: true, success: true });
});

/* ===================== Blackjack PvP (server-driven) ===================== */
/** Очереди по ставкам */
const bjQueues = new Map(); // stake -> [socketId]
/** Игры по roomId */
const bjRooms = new Map();  // roomId -> GameState

function bjJoinQueue(sock, stake) {
  if (!bjQueues.has(stake)) bjQueues.set(stake, []);
  const q = bjQueues.get(stake);
  if (!q.includes(sock.id)) q.push(sock.id);

  if (q.length >= 2) {
    const a = q.shift();
    const b = q.shift();
    const roomId = Math.random().toString(36).slice(2, 8);
    bjRooms.set(roomId, {
      id: roomId,
      stake,
      players: {
        [a]: { socketId: a, userId: io.sockets.sockets.get(a)?.data?.userId || `u_${a.slice(-4)}`, hand: [], stood: false },
        [b]: { socketId: b, userId: io.sockets.sockets.get(b)?.data?.userId || `u_${b.slice(-4)}`, hand: [], stood: false },
      },
      order: [a, b],
      deck: createDeck52(),
      deadline: Date.now() + 30_000,
      finished: false,
    });
    io.to(a).emit("match-found", { roomId, stake, players: Object.values(bjRooms.get(roomId).players).map(p=>p.userId) });
    io.to(b).emit("match-found", { roomId, stake, players: Object.values(bjRooms.get(roomId).players).map(p=>p.userId) });
  }
}
function bjLeaveAllQueues(sockId) {
  for (const q of bjQueues.values()) {
    const i = q.indexOf(sockId);
    if (i !== -1) q.splice(i, 1);
  }
}
function bjDeal(gs) {
  for (const sid of gs.order) {
    const p = gs.players[sid];
    p.hand.push(gs.deck.pop(), gs.deck.pop());
  }
}
function bjScore(hand){ return handValue(hand); }

function bjBroadcastState(gs) {
  const [a,b] = gs.order;
  const A = gs.players[a], B = gs.players[b];

  // Персональные state — каждому отправляем свой "you" с полной рукой,
  // а "opp" — с полной рукой, НО клиент сам скрывает отображение до конца.
  function pack(p){ return { hand: p.hand, stood: p.stood, score: bjScore(p.hand) }; }

  io.to(a).emit("state", { roomId: gs.id, stake: gs.stake, you: pack(A), opp: pack(B), deadline: gs.deadline });
  io.to(b).emit("state", { roomId: gs.id, stake: gs.stake, you: pack(B), opp: pack(A), deadline: gs.deadline });
}

function bjFinish(gs){
  if (gs.finished) return;

  const [a,b] = gs.order;
  const A = gs.players[a], B = gs.players[b];
  const sa = bjScore(A.hand), sb = bjScore(B.hand);

  let resA = "push", resB = "push";
  if (sa>21 && sb>21) { resA="push"; resB="push"; }
  else if (sa>21) { resA="lose"; resB="win"; }
  else if (sb>21) { resA="win"; resB="lose"; }
  else if (sa>sb) { resA="win"; resB="lose"; }
  else if (sa<sb) { resA="lose"; resB="win"; }
  else { resA="push"; resB="push"; }

  // Выплаты: win -> 1.9x своей ставки; push -> возврат ставки
  const stake = gs.stake;
  const creditWin = stake + Math.floor(stake*0.9);
  const creditPush = stake;

  function settle(userId, outcome){
    balances[userId] ??= { balance: 500, wins: 0, profit: 0 };
    if (outcome==="win"){
      balances[userId].balance += creditWin;
      balances[userId].wins += 1;
      balances[userId].profit += creditWin;
    } else if (outcome==="push"){
      balances[userId].balance += creditPush;
      balances[userId].profit += creditPush;
    }
  }

  const uidA = A.userId, uidB = B.userId;
  settle(uidA, resA); settle(uidB, resB);
  writeJSON(balancesPath, balances);

  // история
  history.unshift({ type:"bj_pvp_result", roomId: gs.id, stake, A:{uid:uidA,score:sa,res:resA}, B:{uid:uidB,score:sb,res:resB}, ts: Date.now() });
  writeJSON(historyPath, history.slice(0,1000));

  // Сообщаем результат
  io.to(a).emit("result", { roomId: gs.id, result: resA, you: sa, opp: sb });
  io.to(b).emit("result", { roomId: gs.id, result: resB, you: sb, opp: sa });

  gs.finished = true;
}

io.on("connection", (socket) => {
  /* ---- handshake ---- */
  socket.on("hello", ({ userId }) => { socket.data.userId = userId; });

  /* ---- Blackjack matchmaking ---- */
  socket.on("queue", ({ stake }) => {
    bjJoinQueue(socket, Number(stake) || 10);
  });

  // ready: как только оба готовы — сдаём и шлём state
  socket.on("ready", ({ roomId }) => {
    const gs = bjRooms.get(roomId);
    if (!gs || gs.finished) return;
    socket.join(roomId);
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.size >= 2 && !gs.started) {
      gs.started = true;
      bjDeal(gs);
      gs.deadline = Date.now() + 30_000;
      bjBroadcastState(gs);
    }
  });

  // Ходы в BJ: { roomId, action: 'hit'|'stand' }
  socket.on("move", ({ roomId, action }) => {
    const gs = bjRooms.get(roomId);
    if (!gs || gs.finished) return;
    if (!gs.started) return;
    const p = gs.players[socket.id];
    if (!p) return;

    if (Date.now() > gs.deadline) {
      // таймаут = авто-stand для того, кто не походил
      p.stood = true;
    } else if (action === "hit" && !p.stood) {
      const card = gs.deck.pop();
      if (card) p.hand.push(card);
      if (bjScore(p.hand) > 21) p.stood = true; // перебор = автоконец для этого игрока
      gs.deadline = Date.now() + 30_000;
    } else if (action === "stand") {
      p.stood = true;
      gs.deadline = Date.now() + 30_000;
    }

    const [a,b] = gs.order;
    const A = gs.players[a], B = gs.players[b];

    // если оба закончили — финал
    if (A.stood && B.stood) {
      bjFinish(gs);
    } else {
      bjBroadcastState(gs);
    }
  });

  socket.on("disconnect", () => {
    bjLeaveAllQueues(socket.id);
    // Если игрок вылетел из активной комнаты — второй победил
    for (const [rid, gs] of bjRooms) {
      if (gs.finished) continue;
      if (gs.players[socket.id]) {
        const otherSid = gs.order.find(x=>x!==socket.id);
        if (otherSid && gs.players[otherSid]) {
          // победа второму
          const winnerId = gs.players[otherSid].userId;
          balances[winnerId] ??= { balance: 500, wins: 0, profit: 0 };
          const credit = gs.stake + Math.floor(gs.stake*0.9);
          balances[winnerId].balance += credit;
          balances[winnerId].wins += 1;
          balances[winnerId].profit += credit;
          writeJSON(balancesPath, balances);
          io.to(otherSid).emit("result", { roomId: gs.id, result: "win", you: bjScore(gs.players[otherSid].hand), opp: bjScore(gs.players[socket.id].hand) });
        }
        gs.finished = true;
      }
    }
  });
});

/* ===================== Durak 2×2 (встроенный) ===================== */
/* 36-картная колода, подкидной, 2 игрока — MVP. Лобби на фикс. ставки. */
(function attachDurak(io, ctx){
  const { balances, history, writeJSON } = ctx;

  const SUITS = ["♠","♥","♦","♣"];
  const RANKS = ["6","7","8","9","10","J","Q","K","A"];
  const RANK_ORDER = Object.fromEntries(RANKS.map((r,i)=>[r,i]));
  const POP_STAKES = [10,25,50,100,250,500];

  function makeDeck36(){
    const d = []; for (const s of SUITS) for (const r of RANKS) d.push({rank:r,suit:s});
    for (let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
    return d;
  }
  function canBeat(att, def, trump){
    if (!def) return false;
    if (def.suit === att.suit) return RANK_ORDER[def.rank] > RANK_ORDER[att.rank];
    return def.suit === trump;
  }
  function sameRankAllowed(card, table){
    if (table.length===0) return true;
    const ranks = new Set(); for (const p of table){ ranks.add(p.a.rank); if (p.d) ranks.add(p.d.rank); }
    return ranks.has(card.rank);
  }
  const now = ()=>Date.now();
  const serialize = h => h.map(c=>({rank:c.rank,suit:c.suit}));

  const LOBBIES = new Map(); // id -> { id, stake, capacity:2, players:[{userId,socketId}], game }
  const PLAYER_LOBBY = new Map(); // socketId -> lobbyId

  // создаём 5 лобби на каждую популярную ставку
  for (const stake of POP_STAKES){
    for (let i=1;i<=5;i++){
      const id = `D2-${stake}-${i}`;
      LOBBIES.set(id, { id, title:`Лобби #${i} · ${stake}`, stake, capacity:2, players:[], game:null });
    }
  }

  function roomName(lobbyId){ return "durak-"+lobbyId; }

  function startGame(L){
    const deck = makeDeck36();
    const trumpCard = deck[deck.length-1];
    const trump = trumpCard.suit;

    const hands = {};
    for (const p of L.players) hands[p.userId] = [];
    for (let i=0;i<6;i++) for (const p of L.players) hands[p.userId].push(deck.pop());

    const order = L.players.map(p=>p.userId);
    const attacker = order[Math.floor(Math.random()*order.length)];
    const defender = order.find(u=>u!==attacker);

    L.game = {
      stake: L.stake, deck, trump, trumpCard,
      table: [], discardCount:0,
      attacker, defender, hands,
      deadline: now()+60_000, finished:false
    };

    for (const p of L.players) {
      io.to(p.socketId).emit("durak:hand", { hand: serialize(hands[p.userId]) });
    }
    broadcast(L);
  }
  function broadcast(L){
    const G = L.game; if (!G) return;
    io.to(roomName(L.id)).emit("durak:state", {
      lobbyId: L.id, stake: G.stake,
      trump: G.trump, trumpCard: G.trumpCard,
      deckCount: G.deck.length, discardCount: G.discardCount,
      attacker: G.attacker, defender: G.defender,
      table: G.table,
      players: L.players.map(p=>({ userId:p.userId, handCount: G.hands[p.userId].length })),
      deadline: G.deadline
    });
  }
  function refill(L){
    const G = L.game;
    const order = [G.attacker, G.defender];
    for (const u of order){
      while (G.hands[u].length<6 && G.deck.length>0) G.hands[u].push(G.deck.pop());
    }
  }
  function endTurn_Bito(L){
    const G = L.game;
    G.discardCount += G.table.length*2; G.table = [];
    refill(L);
    const prevAtt = G.attacker; G.attacker = G.defender; G.defender = prevAtt;
    G.deadline = now()+60_000;
  }
  function defenderTakes(L){
    const G = L.game;
    for (const pair of G.table){ G.hands[G.defender].push(pair.a); if (pair.d) G.hands[G.defender].push(pair.d); }
    G.table = [];
    refill(L);
    // атакующий остаётся тем же
    G.deadline = now()+60_000;
  }
  function tryFinish(L){
    const G = L.game;
    if (!G) return false;
    if (G.deck.length>0) return false;
    const aEmpty = G.hands[G.attacker].length===0;
    const dEmpty = G.hands[G.defender].length===0;
    if (!aEmpty && !dEmpty) return false;

    const winner = aEmpty ? G.attacker : G.defender;
    const loser  = aEmpty ? G.defender : G.attacker;
    settle(L, winner, loser);
    G.finished = true;
    io.to(roomName(L.id)).emit("durak:ended", { winner, loser, stake:G.stake });
    return true;
  }
  function settle(L, winner, loser){
    const add = L.stake + Math.floor(L.stake*0.9);
    balances[winner] ??= { balance:500, wins:0, profit:0 };
    balances[winner].balance += add;
    balances[winner].wins += 1;
    balances[winner].profit += add;
    writeJSON(balancesPath, balances);
    history.unshift({ type:"durak_win", lobbyId:L.id, stake:L.stake, winner, loser, amount:add, ts: now() });
    writeJSON(historyPath, history.slice(0,1000));
  }

  io.on("connection", (socket)=>{
    socket.on("durak:list", ({players, stake})=>{
      const s = stake || 25;
      if (players !== 2){
        socket.emit("durak:lobbies", { players, stake:s, lobbies:[], disabled:true });
        return;
      }
      const list = Array.from(LOBBIES.values())
        .filter(L=>L.capacity===2 && L.stake===s)
        .map(L=>({ id:L.id, title:L.title, stake:L.stake, capacity:L.capacity, count:L.players.length, busy: !!L.game }));
      socket.emit("durak:lobbies", { players, stake:s, lobbies:list, disabled:false });
    });

    socket.on("durak:join", ({ lobbyId, userId })=>{
      const L = LOBBIES.get(lobbyId); if (!L) return socket.emit("durak:error",{message:"Лобби не найдено"});
      if (L.game) return socket.emit("durak:error",{message:"Матч уже идёт"});
      if (L.players.find(p=>p.userId===userId)) return;
      if (L.players.length>=L.capacity) return socket.emit("durak:error",{message:"Лобби заполнено"});

      socket.join(roomName(L.id));
      L.players.push({ userId, socketId: socket.id });
      PLAYER_LOBBY.set(socket.id, L.id);

      io.to(roomName(L.id)).emit("durak:joined", {
        lobbyId:L.id, players:L.players.map(p=>p.userId), count:L.players.length, capacity:L.capacity, stake:L.stake
      });

      if (L.players.length===L.capacity){ startGame(L); }
    });

    socket.on("durak:sync-hand", ({ lobbyId, userId, hand })=>{
      const L = LOBBIES.get(lobbyId); if (!L || !L.game) return;
      L.game.hands[userId] = hand;
    });

    socket.on("durak:move", ({ lobbyId, userId, action, payload })=>{
      const L = LOBBIES.get(lobbyId); if (!L || !L.game) return;
      const G = L.game;
      if (now()>G.deadline){
        const loser = userId;
        const winner = L.players.find(p=>p.userId!==loser)?.userId;
        if (winner){ settle(L, winner, loser); io.to(roomName(L.id)).emit("durak:ended", { winner, loser, stake:G.stake, reason:"timeout" }); }
        G.finished = true; return;
      }
      if (G.finished) return;

      if (action==="attack"){
        if (userId!==G.attacker) return;
        const card = payload?.card; if (!card) return;
        const has = G.hands[userId].find(c=>c.rank===card.rank && c.suit===card.suit); if (!has) return;
        const defenderMax = Math.min(6, G.hands[G.defender].length);
        if (G.table.length>=defenderMax) return;
        if (!sameRankAllowed(card, G.table)) return;
        G.hands[userId] = G.hands[userId].filter(c=>!(c.rank===card.rank && c.suit===card.suit));
        G.table.push({ a: card, d: null });
        G.deadline = now()+60_000;
      }
      else if (action==="defend"){
        if (userId!==G.defender) return;
        const idx = payload?.index ?? G.table.findIndex(p=>!p.d);
        const card = payload?.card; if (idx<0 || !card) return;
        const pair = G.table[idx]; if (!pair || pair.d) return;
        const has = G.hands[userId].find(c=>c.rank===card.rank && c.suit===card.suit); if (!has) return;
        if (!canBeat(pair.a, card, G.trump)) return;
        G.hands[userId] = G.hands[userId].filter(c=>!(c.rank===card.rank && c.suit===card.suit));
        pair.d = card; G.deadline = now()+60_000;
      }
      else if (action==="throw"){
        if (userId!==G.attacker) return;
        const card = payload?.card; if (!card) return;
        const has = G.hands[userId].find(c=>c.rank===card.rank && c.suit===card.suit); if (!has) return;
        const defenderMax = Math.min(6, G.hands[G.defender].length);
        if (G.table.length>=defenderMax) return;
        if (!sameRankAllowed(card, G.table)) return;
        G.hands[userId] = G.hands[userId].filter(c=>!(c.rank===card.rank && c.suit===card.suit));
        G.table.push({ a: card, d: null });
        G.deadline = now()+60_000;
      }
      else if (action==="take"){
        if (userId!==G.defender) return;
        defenderTakes(L);
      }
      else if (action==="bito"){
        if (userId!==G.attacker) return;
        if (G.table.some(p=>!p.d)) return;
        endTurn_Bito(L);
      }

      if (!G.finished && tryFinish(L)) return;
      broadcast(L);
      for (const p of L.players){
        io.to(p.socketId).emit("durak:hand", { hand: serialize(G.hands[p.userId]) });
      }
    });

    socket.on("durak:leave", ({ lobbyId })=>{
      const L = LOBBIES.get(lobbyId); if (!L) return;
      socket.leave(roomName(lobbyId));
      L.players = L.players.filter(p=>p.socketId!==socket.id);
      PLAYER_LOBBY.delete(socket.id);
      if (L.players.length===0) L.game = null;
      io.to(roomName(L.id)).emit("durak:joined", {
        lobbyId:L.id, players:L.players.map(p=>p.userId), count:L.players.length, capacity:L.capacity, stake:L.stake
      });
    });

    socket.on("disconnect", ()=>{
      const lobbyId = PLAYER_LOBBY.get(socket.id);
      if (!lobbyId) return;
      const L = LOBBIES.get(lobbyId); if (!L) return;
      const p = L.players.find(pp=>pp.socketId===socket.id); if (!p) return;
      const leftUser = p.userId;
      L.players = L.players.filter(pp=>pp.socketId!==socket.id);
      PLAYER_LOBBY.delete(socket.id);

      if (L.game && !L.game.finished){
        const winner = L.players[0]?.userId;
        if (winner){
          settle(L, winner, leftUser);
          io.to(roomName(L.id)).emit("durak:ended", { winner, loser:leftUser, stake:L.game.stake, reason:"disconnect" });
          L.game.finished = true;
        }
      }
    });
  });
})(io, { balances, history, writeJSON });

/* ---------------- PORT ---------------- */
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => {
  console.log("Backend+WS listening on", PORT);
});
