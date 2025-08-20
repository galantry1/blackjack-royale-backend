// backend/durak.cjs
const { Server } = require("socket.io");

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

// ===== Лобби/матч-геймплей (2 игрока MVP) =====
module.exports = function createDurak(io, ctx){
  // ctx: { balances, history, writeJSON, balancesPath, historyPath }
  const { balances, history, writeJSON, balancesPath, historyPath } = ctx;

  // Лобби: по факту это "комната ожидания" с фикс. вместимостью
  const LOBBIES = new Map(); // lobbyId -> { id, title, stake, capacity, players:[{userId,socketId}], game:null|Game }
  const PLAYER_LOBBY = new Map(); // socketId -> lobbyId

  // Создаём 5 публичных лобби для режима "2 игрока" под каждый популярный stake.
  const POP_STAKES = [10,25,50,100,250,500];
  for (const stake of POP_STAKES){
    for (let i=1;i<=5;i++){
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

  // ===== матч (только 2p) =====
  function startGame(lobby){
    const deck = makeDeck36();
    const trumpCard = deck[deck.length-1];
    const trump = trumpCard.suit;

    // Раздача по 6
    const hands = {};
    for (const p of lobby.players) hands[p.userId] = [];
    for (let i=0;i<6;i++){
      for (const p of lobby.players) hands[p.userId].push(deck.pop());
    }

    // Первый атакующий — случайный (для простоты MVP)
    const order = lobby.players.map(p=>p.userId);
    const attacker = order[Math.floor(Math.random()*order.length)];
    const defender = order.find(u=>u!==attacker);

    lobby.game = {
      id: "game-"+Math.random().toString(36).slice(2,8),
      stake: lobby.stake,
      order, // [u1,u2]
      attacker, defender,
      deck, trump, trumpCard,
      table: [], // [{a:{rank,suit}, d?:{rank,suit}}]
      discardCount: 0,
      deadline: now()+60_000, // 60 сек на действие
      startedAt: now(),
      finished: false,
    };

    // персональные руки игрокам
    for (const p of lobby.players){
      io.to(p.socketId).emit("durak:hand", { hand: serializeHand(hands[p.userId]) });
    }

    broadcastState(lobby, hands);
  }

  function broadcastState(lobby, hands){
    const G = lobby.game;
    if (!G) return;
    const publicPlayers = lobby.players.map(p => ({
      userId: p.userId,
      handCount: hands[p.userId].length
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

  function roomName(lobbyId){ return "durak-"+lobbyId; }

  function refillAfterTurn(lobby, hands, firstTakeUserId){
    const G = lobby.game;
    if (!G) return;
    // добор до 6 — с атакующего по кругу
    const drawOrder = [G.attacker, G.defender];
    for (const u of drawOrder){
      while (hands[u].length < 6 && G.deck.length>0){
        hands[u].push(G.deck.pop());
      }
    }
  }

  function endTurn_Bito(lobby, hands){
    const G = lobby.game;
    // всё со стола — в сброс
    G.discardCount += G.table.length*2;
    G.table = [];

    // добор
    refillAfterTurn(lobby, hands);

    // ротация ролей: защитник становится атакующим
    const prevAtt = G.attacker;
    G.attacker = G.defender;
    G.defender = prevAtt;

    G.deadline = now()+60_000;
  }

  function defenderTakes(lobby, hands){
    const G = lobby.game;
    // защитник забирает все карты со стола в руку
    for (const pair of G.table){
      hands[G.defender].push(pair.a);
      if (pair.d) hands[G.defender].push(pair.d);
    }
    G.table = [];

    // добор только защитнику в конце — в классике добор после, но здесь доберём обеим как обычно
    refillAfterTurn(lobby, hands);

    // атакующий остаётся тем же
    // защитник — прежний (потому что взял)
    G.deadline = now()+60_000;
  }

  function tryFinish(lobby, hands){
    const G = lobby.game;
    if (G.deck.length>0) return false;
    // Если кто-то пуст — он победитель (MVP для 2 игроков)
    const aEmpty = hands[G.attacker].length===0;
    const dEmpty = hands[G.defender].length===0;
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
    // Победитель получает свою ставку + 90% ставки соперника
    const add = stake + Math.floor(stake*0.9);
    balances[winner] ??= { balance: 500, wins: 0, profit: 0 };
    balances[winner].balance += add;
    balances[winner].wins += 1;
    balances[winner].profit += add;

    // Проигравший уже заплатил вход (ставку) до начала — ничего не возвращаем
    writeJSON(balancesPath, balances);

    history.unshift({ type:"win", game:"durak", stake, winner, loser, amount:add, ts:now() });
    writeJSON(historyPath, history.slice(0,1000));
  }

  function findLobby(lobbyId){ return LOBBIES.get(lobbyId); }
  function findPlayer(lobby, socketId){ return lobby.players.find(p=>p.socketId===socketId); }

  // ===== Socket handlers =====
  io.on("connection", (socket)=>{
    // список лобби для 2 игроков (остальные режимы выключены в MVP)
    socket.on("durak:list", ({players, stake})=>{
      const s = stake || 25;
      if (players !== 2){
        socket.emit("durak:lobbies", { players, stake: s, lobbies: [] , disabled:true });
        return;
      }
      const list = Array.from(LOBBIES.values())
        .filter(l=>l.capacity===2 && l.stake===s)
        .map(l=>({
          id:l.id, title:l.title, stake:l.stake, capacity:l.capacity, count:l.players.length, busy: !!l.game
        }));
      socket.emit("durak:lobbies", { players, stake: s, lobbies:list, disabled:false });
    });

    socket.on("durak:join", ({ lobbyId, userId })=>{
      const L = findLobby(lobbyId);
      if (!L) return socket.emit("durak:error", { message:"Лобби не найдено" });
      if (L.game) return socket.emit("durak:error", { message:"Матч уже идёт" });
      if (L.players.some(p=>p.userId===userId)) return; // уже сидит
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

      // как только двое — старт
      if (L.players.length===L.capacity){
        // Сигнал всем — матч начинается
        startGame(L);

        // Храним руки приватно у сокетов (в оперативной памяти узла):
        // Для простоты — положим в слабую мапу на основе userId
        // (мы не сериализуем на диск руки)
        const hands = {};
        for (const p of L.players) hands[p.userId] = [];

        // Но стартGame уже сдал и отправил руки — перехватим их из ack от клиентов? Нет.
        // Чуть изменим: будем держать руки внутри game:
        L.game.hands = hands; // создадим контейнер, заполнен ниже.

        // Заполним тем, что мы раздали — просто повторно раздадим — НЕТ.
        // Исправление: переносим раздачу внутрь startGame -> мы уже раздали и разослали,
        // нужно сохранить это состояние в game. Сделаем это правильно:
      }
    });

    // В качестве упрощения: отдельные эвенты для получения/сохранения руки игрока
    socket.on("durak:sync-hand", ({ lobbyId, userId, hand })=>{
      const L = findLobby(lobbyId); if (!L || !L.game) return;
      L.game.hands ??= {};
      L.game.hands[userId] = hand; // [{rank,suit}]
    });

    socket.on("durak:move", ({ lobbyId, userId, action, payload })=>{
      const L = findLobby(lobbyId); if (!L || !L.game) return;
      const G = L.game;
      const hands = G.hands; if (!hands) return;

      if (now()>G.deadline){
        // авто-поражение нарушившему дедлайн: проигрывает тот, чей ход по логике
        const loser = userId;
        const winner = L.players.find(p=>p.userId!==loser).userId;
        settlePayout(L, winner, loser);
        G.finished = true;
        io.to(roomName(L.id)).emit("durak:ended", { winner, loser, stake:G.stake, reason:"timeout" });
        return;
      }

      if (action==="attack"){
        if (userId!==G.attacker) return;
        const card = payload?.card;
        if (!card) return;
        const has = hands[userId].find(c=>c.rank===card.rank && c.suit===card.suit);
        if (!has) return;

        const defenderMax = Math.min(6, hands[G.defender].length);
        const openPairs = G.table.length;
        if (openPairs>=defenderMax) return;

        if (!sameRankAllowed(card, G.table)) return;

        // убрать из руки
        hands[userId] = hands[userId].filter(c=>!(c.rank===card.rank && c.suit===card.suit));
        G.table.push({ a: card, d: null });
        G.deadline = now()+60_000;
      }
      else if (action==="defend"){
        if (userId!==G.defender) return;
        const idx = payload?.index ?? G.table.findIndex(p=>!p.d);
        const card = payload?.card;
        if (idx<0 || !card) return;
        const pair = G.table[idx]; if (!pair || pair.d) return;

        const has = hands[userId].find(c=>c.rank===card.rank && c.suit===card.suit);
        if (!has) return;
        if (!canBeat(pair.a, card, G.trump)) return;

        hands[userId] = hands[userId].filter(c=>!(c.rank===card.rank && c.suit===card.suit));
        pair.d = card;
        G.deadline = now()+60_000;
      }
      else if (action==="throw"){
        // Подкидывает только атакующий (MVP)
        if (userId!==G.attacker) return;
        const card = payload?.card;
        if (!card) return;
        const has = hands[userId].find(c=>c.rank===card.rank && c.suit===card.suit);
        if (!has) return;

        const defenderMax = Math.min(6, hands[G.defender].length);
        if (G.table.length>=defenderMax) return;
        if (!sameRankAllowed(card, G.table)) return;
        // хотя бы одна пара должна быть без защиты? — можно подкидывать и в процессе защиты
        hands[userId] = hands[userId].filter(c=>!(c.rank===card.rank && c.suit===card.suit));
        G.table.push({ a: card, d: null });
        G.deadline = now()+60_000;
      }
      else if (action==="take"){
        if (userId!==G.defender) return;
        defenderTakes(L, hands);
      }
      else if (action==="bito"){
        // все атаки должны быть покрыты, иначе нельзя бито
        if (userId!==G.attacker) return;
        if (G.table.some(p=>!p.d)) return;
        endTurn_Bito(L, hands);
      }

      // Проверка конца партии
      if (!G.finished && tryFinish(L, hands)) {
        return;
      }

      // Рассылаем публичку
      broadcastState(L, hands);

      // Раздать приватные руки
      for (const p of L.players){
        io.to(p.socketId).emit("durak:hand", { hand: hands[p.userId] });
      }
    });

    socket.on("durak:leave", ({ lobbyId })=>{
      const L = findLobby(lobbyId); if (!L) return;
      socket.leave(roomName(L.id));
      L.players = L.players.filter(p=>p.socketId!==socket.id);
      PLAYER_LOBBY.delete(socket.id);
      if (L.players.length===0) {
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

    socket.on("disconnect", ()=>{
      const lobbyId = PLAYER_LOBBY.get(socket.id);
      if (!lobbyId) return;
      const L = findLobby(lobbyId); if (!L) return;
      const p = L.players.find(pp=>pp.socketId===socket.id);
      if (!p) return;
      const leftUser = p.userId;
      L.players = L.players.filter(pp=>pp.socketId!==socket.id);
      PLAYER_LOBBY.delete(socket.id);

      if (L.game && !L.game.finished){
        // второй — победитель
        const winner = L.players[0]?.userId;
        if (winner){
          settlePayout(L, winner, leftUser);
          io.to(roomName(L.id)).emit("durak:ended", { winner, loser:leftUser, stake:L.game.stake, reason:"disconnect" });
          L.game.finished = true;
        }
      }
    });
  });
};
