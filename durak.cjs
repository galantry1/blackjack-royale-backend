// backend/durak.cjs

/**
 * Дурак (подкидной, 36 карт) — серверная логика (2 игрока, PvP)
 * - Автосид лобби по ставке (чтобы список не был пустым на проде/после рестартов)
 * - Можно join по lobbyId ИЛИ без него (возьмём первое свободное лобби нужной ставки)
 * - Сервер хранит руки игроков (G.hands) — ход/валидации не зависят от клиента
 * - Добор до 6, "Беру"/"Бито", ротация атакующего/защитника, дедлайны
 * - Выплаты: победитель получает свою ставку + 90% ставки оппонента
 *
 * Ожидается, что в server.cjs будет:
 *   const ctx = { balances, history, writeJSON, balancesPath, historyPath };
 *   require("./durak.cjs")(io, ctx);
 */

 // ===== utils: 36-карт колода подкидного =====
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["6","7","8","9","10","J","Q","K","A"];
const RANK_ORDER = Object.fromEntries(RANKS.map((r,i)=>[r,i]));

function makeDeck36(){
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({rank:r, suit:s});
  for (let i=d.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}
function canBeat(att, def, trump){
  if (!def) return false;
  if (def.suit === att.suit) return RANK_ORDER[def.rank] > RANK_ORDER[att.rank];
  return def.suit === trump;
}
function sameRankAllowed(card, table){
  if (table.length === 0) return true;
  const ranksOnTable = new Set();
  for (const p of table) {
    ranksOnTable.add(p.a.rank);
    if (p.d) ranksOnTable.add(p.d.rank);
  }
  return ranksOnTable.has(card.rank);
}
function serializeHand(h){ return h.map(c=>({rank:c.rank, suit:c.suit})); }
function now(){ return Date.now(); }
function roomName(lobbyId){ return "durak-"+lobbyId; }

// ===== основной модуль =====
module.exports = function createDurak(io, ctx){
  // ctx: { balances, history, writeJSON, balancesPath, historyPath }
  const { balances, history, writeJSON, balancesPath, historyPath } = ctx;

  // ------- Лобби-состояние -------
  // lobby: { id, title, stake, capacity, players:[{userId,socketId}], game:null|Game }
  const LOBBIES = new Map();   // lobbyId -> lobby
  const PLAYER_LOBBY = new Map(); // socketId -> lobbyId

  // По умолчанию сидируем популярные ставки (но создадим и любую новую по запросу)
  const POP_STAKES = [10,25,50,100,250,500];
  for (const stake of POP_STAKES) seedStake(stake);

  function seedStake(stake, count=5){
    const exist = Array.from(LOBBIES.values()).some(l=>l.capacity===2 && l.stake===stake);
    if (exist) return;
    for (let i=1;i<=count;i++){
      const id = `D2-${stake}-${i}`;
      LOBBIES.set(id, {
        id,
        title: `Лобби #${i} · ${stake}`,
        stake,
        capacity: 2,
        players: [],
        game: null
      });
    }
  }

  function ensureStake(stake){
    // Если по этой ставке нет лобби (напр., новая ставка), создадим пачку
    const has = Array.from(LOBBIES.values()).some(l=>l.capacity===2 && l.stake===stake);
    if (!has) seedStake(stake, 6);
  }

  function findLobby(lobbyId){ return LOBBIES.get(lobbyId); }
  function firstFreeLobbyByStake(stake){
    ensureStake(stake);
    // сначала ищем незапущенные и не полные
    const list = Array.from(LOBBIES.values())
      .filter(l=>l.capacity===2 && l.stake===stake)
      .sort((a,b)=> (a.players.length - b.players.length));
    for (const l of list){
      if (!l.game && l.players.length < l.capacity) return l;
    }
    // все заняты — вернём первое с наименьшей загрузкой (на край)
    return list[0] || null;
  }

  // ------- Матч 2 игрока -------
  function startGame(lobby){
    // Колода, козырь
    const deck = makeDeck36();
    const trumpCard = deck[deck.length-1];
    const trump = trumpCard.suit;

    // Руки
    const hands = {};
    for (const p of lobby.players) hands[p.userId] = [];
    for (let i=0;i<6;i++){
      for (const p of lobby.players) hands[p.userId].push(deck.pop());
    }

    // Атакующий — минимальная козырная логика: кто держит "меньший" козырь — тот ходит.
    // Если ни у кого козырей — случайный.
    const ids = lobby.players.map(p=>p.userId);
    const trumps = ids.map(u => hands[u].filter(c=>c.suit===trump).sort((a,b)=>RANK_ORDER[a.rank]-RANK_ORDER[b.rank]));
    let attacker = null;
    if (trumps[0].length && trumps[1].length){
      attacker = (RANK_ORDER[trumps[0][0].rank] <= RANK_ORDER[trumps[1][0].rank]) ? ids[0] : ids[1];
    } else if (trumps[0].length) attacker = ids[0];
    else if (trumps[1].length) attacker = ids[1];
    else attacker = ids[Math.random()<0.5?0:1];
    const defender = ids.find(u=>u!==attacker);

    lobby.game = {
      id: "game-"+Math.random().toString(36).slice(2,8),
      stake: lobby.stake,
      attacker, defender,
      deck, trump, trumpCard,
      table: [],              // [{ a:{rank,suit}, d?:{rank,suit}|null }]
      discardCount: 0,
      deadline: now()+60_000, // 60 сек на действие
      startedAt: now(),
      finished: false,
      hands,                  // <- ХРАНИМ РУКИ НА СЕРВЕРЕ
    };

    // приватные руки игрокам
    for (const p of lobby.players){
      io.to(p.socketId).emit("durak:hand", { hand: serializeHand(hands[p.userId]) });
    }

    broadcastState(lobby);
  }

  function refillAfterTurn(lobby){
    const G = lobby.game; if (!G) return;
    const order = [G.attacker, G.defender]; // добор с атакующего (классика 2p)
    for (const u of order){
      while (G.hands[u].length < 6 && G.deck.length > 0){
        G.hands[u].push(G.deck.pop());
      }
    }
  }

  function endTurn_Bito(lobby){
    const G = lobby.game; if (!G) return;
    // всё со стола — в сброс
    G.discardCount += G.table.length * 2;
    G.table = [];

    // добор
    refillAfterTurn(lobby);

    // ротация ролей
    const prevAtt = G.attacker;
    G.attacker = G.defender;
    G.defender = prevAtt;

    G.deadline = now()+60_000;
  }

  function defenderTakes(lobby){
    const G = lobby.game; if (!G) return;
    // защитник забирает все карты со стола
    for (const pair of G.table){
      G.hands[G.defender].push(pair.a);
      if (pair.d) G.hands[G.defender].push(pair.d);
    }
    G.table = [];

    // добор (классика: после взятия атакующий остаётся тем же)
    refillAfterTurn(lobby);

    G.deadline = now()+60_000;
  }

  function tryFinish(lobby){
    const G = lobby.game; if (!G) return false;
    // конец, когда колода пуста и кто-то вышел
    if (G.deck.length>0) return false;
    const aEmpty = G.hands[G.attacker].length===0;
    const dEmpty = G.hands[G.defender].length===0;
    if (!aEmpty && !dEmpty) return false;

    const winner = aEmpty ? G.attacker : G.defender;
    const loser  = aEmpty ? G.defender : G.attacker;
    settlePayout(lobby, winner, loser);
    G.finished = true;

    io.to(roomName(lobby.id)).emit("durak:ended", { winner, loser, stake: G.stake });
    return true;
  }

  function settlePayout(lobby, winner, loser){
    const stake = lobby.stake;
    const add = stake + Math.floor(stake*0.9);
    balances[winner] ??= { balance: 500, wins: 0, profit: 0 };
    balances[winner].balance += add;
    balances[winner].wins += 1;
    balances[winner].profit += add;
    writeJSON(balancesPath, balances);

    history.unshift({ type:"win", game:"durak", stake, winner, loser, amount:add, ts:now() });
    writeJSON(historyPath, history.slice(0,1000));
  }

  function broadcastState(lobby){
    const G = lobby.game; if (!G) return;
    const publicPlayers = lobby.players.map(p => ({
      userId: p.userId,
      handCount: G.hands[p.userId]?.length ?? 0,
    }));
    io.to(roomName(lobby.id)).emit("durak:state", {
      lobbyId: lobby.id,
      stake: G.stake,
      trump: G.trump,
      trumpCard: G.trumpCard,
      deckCount: G.deck.length,
      discardCount: G.discardCount,
      attacker: G.attacker,
      defender: G.defender,
      table: G.table,
      players: publicPlayers,
      deadline: G.deadline
    });
  }

  // ===== Socket handlers =====
  io.on("connection", (socket)=>{
    // список лобби: всегда что-то есть для 2p по выбранной ставке
    socket.on("durak:list", ({players, stake} = {})=>{
      const s = Number(stake || 25) || 25;
      if (players !== 2){
        socket.emit("durak:lobbies", { players, stake: s, lobbies: [] , disabled:true });
        return;
      }
      ensureStake(s);
      const list = Array.from(LOBBIES.values())
        .filter(l=>l.capacity===2 && l.stake===s)
        .map(l=>({
          id:l.id, title:l.title, stake:l.stake, capacity:l.capacity, count:l.players.length, busy: !!l.game
        }));
      socket.emit("durak:lobbies", { players, stake: s, lobbies:list, disabled:false });
    });

    // вход в лобби: можно без lobbyId — подберём свободное по последнему stake (или 25)
    socket.on("durak:join", ({ lobbyId, userId, stake } = {})=>{
      const s = Number(stake || 25) || 25;
      let L = lobbyId ? findLobby(lobbyId) : null;
      if (!L) {
        L = firstFreeLobbyByStake(s);
        if (!L) {
          seedStake(s, 3);
          L = firstFreeLobbyByStake(s);
        }
      }
      if (!L) return socket.emit("durak:error", { message:"Нет свободных лобби, попробуйте позже" });
      if (L.game) return socket.emit("durak:error", { message:"Матч уже идёт" });
      if (L.players.some(p=>p.userId===userId)) return; // уже внутри
      if (L.players.length>=L.capacity) return socket.emit("durak:error", { message:"Лобби заполнено" });

      // присоединяем
      socket.join(roomName(L.id));
      L.players.push({ userId, socketId: socket.id });
      PLAYER_LOBBY.set(socket.id, L.id);

      io.to(roomName(L.id)).emit("durak:joined", {
        lobbyId: L.id,
        players: L.players.map(p=>p.userId),
        count: L.players.length,
        capacity: L.capacity,
        stake: L.stake
      });

      // когда двое — старт
      if (L.players.length===L.capacity){
        startGame(L);
      }
    });

    // игровой ход
    socket.on("durak:move", ({ lobbyId, userId, action, payload } = {})=>{
      const L = findLobby(lobbyId); if (!L || !L.game) return;
      const G = L.game;

      // дедлайн
      if (now() > G.deadline && !G.finished){
        // на простом MVP: тот, кто опоздал (приславший ход) — проиграл
        const loser = userId;
        const winner = L.players.find(p=>p.userId!==loser)?.userId;
        if (winner){
          settlePayout(L, winner, loser);
          G.finished = true;
          io.to(roomName(L.id)).emit("durak:ended", { winner, loser, stake:G.stake, reason:"timeout" });
        }
        return;
      }

      const H = G.hands;
      const hasCard = (uid, card) => H[uid]?.some(c=>c.rank===card.rank && c.suit===card.suit);
      const removeCard = (uid, card) => { H[uid] = H[uid].filter(c=>!(c.rank===card.rank && c.suit===card.suit)); };

      if (action==="attack"){
        if (userId!==G.attacker) return;
        const card = payload?.card; if (!card) return;
        if (!hasCard(userId, card)) return;

        const defenderMax = Math.min(6, H[G.defender].length);
        if (G.table.length >= defenderMax) return;
        if (!sameRankAllowed(card, G.table)) return;

        removeCard(userId, card);
        G.table.push({ a: card, d: null });
        G.deadline = now()+60_000;
      }
      else if (action==="defend"){
        if (userId!==G.defender) return;
        const idx = payload?.index ?? G.table.findIndex(p=>!p.d);
        const card = payload?.card; if (idx<0 || !card) return;
        const pair = G.table[idx]; if (!pair || pair.d) return;
        if (!hasCard(userId, card)) return;
        if (!canBeat(pair.a, card, G.trump)) return;

        removeCard(userId, card);
        pair.d = card;
        G.deadline = now()+60_000;
      }
      else if (action==="throw"){
        if (userId!==G.attacker) return;
        const card = payload?.card; if (!card) return;
        if (!hasCard(userId, card)) return;
        const defenderMax = Math.min(6, H[G.defender].length);
        if (G.table.length >= defenderMax) return;
        if (!sameRankAllowed(card, G.table)) return;

        removeCard(userId, card);
        G.table.push({ a: card, d: null });
        G.deadline = now()+60_000;
      }
      else if (action==="take"){
        if (userId!==G.defender) return;
        // должно быть что брать: хотя бы одна неотбитая
        if (!G.table.some(p=>!p.d)) return;
        defenderTakes(L);
      }
      else if (action==="bito"){
        if (userId!==G.attacker) return;
        // все должны быть отбиты
        if (G.table.some(p=>!p.d)) return;
        endTurn_Bito(L);
      } else {
        return;
      }

      if (!G.finished && tryFinish(L)) return;

      // Рассылаем публичное состояние и приватные руки
      broadcastState(L);
      for (const p of L.players){
        io.to(p.socketId).emit("durak:hand", { hand: serializeHand(G.hands[p.userId]) });
      }
    });

    // выход из лобби по кнопке
    socket.on("durak:leave", ({ lobbyId } = {})=>{
      const L = lobbyId ? findLobby(lobbyId) : findLobby(PLAYER_LOBBY.get(socket.id));
      if (!L) return;
      socket.leave(roomName(L.id));
      const was = L.players.find(p=>p.socketId===socket.id);
      const leftUser = was?.userId;

      L.players = L.players.filter(p=>p.socketId!==socket.id);
      PLAYER_LOBBY.delete(socket.id);

      if (leftUser && L.game && !L.game.finished){
        // второй — победитель
        const winner = L.players[0]?.userId;
        if (winner){
          settlePayout(L, winner, leftUser);
          L.game.finished = true;
          io.to(roomName(L.id)).emit("durak:ended", { winner, loser:leftUser, stake:L.game.stake, reason:"disconnect" });
        }
      }
      if (L.players.length===0) {
        // сбрасываем игру, чтобы лобби стало свободным
        L.game = null;
      }

      io.to(roomName(L.id)).emit("durak:joined", {
        lobbyId: L.id,
        players: L.players.map(p=>p.userId),
        count: L.players.length,
        capacity: L.capacity,
        stake: L.stake
      });
    });

    // учёт выхода по разрыву соединения
    socket.on("disconnect", ()=>{
      const lobbyId = PLAYER_LOBBY.get(socket.id);
      if (!lobbyId) return;
      const L = findLobby(lobbyId); if (!L) return;
      const p = L.players.find(pp=>pp.socketId===socket.id);
      const leftUser = p?.userId;

      L.players = L.players.filter(pp=>pp.socketId!==socket.id);
      PLAYER_LOBBY.delete(socket.id);

      if (leftUser && L.game && !L.game.finished){
        const winner = L.players[0]?.userId;
        if (winner){
          settlePayout(L, winner, leftUser);
          L.game.finished = true;
          io.to(roomName(L.id)).emit("durak:ended", { winner, loser:leftUser, stake:L.game.stake, reason:"disconnect" });
        }
      }
      if (L.players.length===0) {
        L.game = null;
      }
    });
  });
};
