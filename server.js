// backend/server.js
import express from "express";
import fs from "fs";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3001;
const __dirname = path.resolve();

const dataDir = path.join(__dirname, "backend");
const balancesFile = path.join(dataDir, "balances.json");
const historyFile = path.join(dataDir, "history.json");

app.use(cors());
app.use(bodyParser.json());

function safeReadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf-8");
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function safeWriteJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf-8");
}

// ensure files
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(balancesFile)) safeWriteJSON(balancesFile, {});
if (!fs.existsSync(historyFile)) safeWriteJSON(historyFile, []);

// helpers
const loadBalances = () => safeReadJSON(balancesFile, {});
const saveBalances = (b) => safeWriteJSON(balancesFile, b);
const loadHistory = () => safeReadJSON(historyFile, []);
const saveHistory = (h) => safeWriteJSON(historyFile, h);

// API
app.get("/health", (_, res) => res.json({ ok: true }));

// Инициализация пользователя
app.post("/init", (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ success: false, message: "userId required" });

  const balances = loadBalances();
  if (balances[userId] == null) {
    balances[userId] = 1000; // стартовый баланс
    saveBalances(balances);
  }
  res.json({ success: true, balance: balances[userId] });
});

// Получить баланс
app.get("/balance/:userId", (req, res) => {
  const { userId } = req.params;
  const balances = loadBalances();
  const balance = balances[userId] ?? 0;
  res.json({ success: true, balance });
});

// История пользователя
app.get("/history/:userId", (req, res) => {
  const { userId } = req.params;
  const history = loadHistory().filter((h) => h.userId === userId).sort((a,b)=>b.ts-a.ts).slice(0,200);
  res.json({ success: true, history });
});

// Ставка (списание) — идемпотентно по roundId
app.post("/bet", (req, res) => {
  const { userId, amount, roundId } = req.body || {};
  if (!userId || !Number.isFinite(amount) || amount <= 0 || !roundId) {
    return res.status(400).json({ success: false, message: "userId, amount>0 и roundId обязательны" });
  }

  const balances = loadBalances();
  const history = loadHistory();

  if (history.find((h) => h.roundId === roundId && h.type === "bet" && h.userId === userId)) {
    return res.json({ success: true, balance: balances[userId] ?? 0 });
  }

  const current = balances[userId] ?? 0;
  if (current < amount) return res.json({ success: false, message: "Недостаточно средств", balance: current });

  balances[userId] = current - amount;
  history.push({ roundId, userId, type: "bet", amount, ts: Date.now() });

  saveBalances(balances);
  saveHistory(history);

  res.json({ success: true, balance: balances[userId] });
});

// Выигрыш (начисление) — идемпотентно по roundId
app.post("/win", (req, res) => {
  const { userId, amount, roundId } = req.body || {};
  if (!userId || !Number.isFinite(amount) || amount <= 0 || !roundId) {
    return res.status(400).json({ success: false, message: "userId, amount>0 и roundId обязательны" });
  }

  const balances = loadBalances();
  const history = loadHistory();

  if (history.find((h) => h.roundId === roundId && h.type === "win" && h.userId === userId)) {
    return res.json({ success: true, balance: balances[userId] ?? 0 });
  }

  balances[userId] = (balances[userId] ?? 0) + amount;
  history.push({ roundId, userId, type: "win", amount, ts: Date.now() });

  saveBalances(balances);
  saveHistory(history);

  res.json({ success: true, balance: balances[userId] });
});

app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
