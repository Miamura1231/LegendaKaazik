// Слой постоянного хранения данных (этап 0).
// Заменяет временные Map/массивы в памяти: пользователи, сессии,
// платежи, история игр и журнал админ-действий теперь живут в SQLite
// и переживают перезапуск сервера.
//
// better-sqlite3 выбран из-за синхронного API: обработчики остаются
// простыми, без async/await, а подготовленные выражения и транзакции
// дают атомарность изменений баланса.
//
// Файл базы создаётся автоматически: mock-server/data.sqlite
// (+ data.sqlite-wal / data.sqlite-shm в режиме WAL).
// Добавь их в .gitignore — в репозитории им делать нечего.

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "data.sqlite");

const db = new Database(DB_PATH);

// WAL-режим: чтение не блокирует запись и наоборот — важно, когда
// REST-запросы и WebSocket-комнаты работают одновременно
db.pragma("journal_mode = WAL");

// Контроль внешних ключей (каскадное удаление сессий и т.п.)
db.pragma("foreign_keys = ON");

// ===== Схема =====

db.exec(`
  -- Игроки. До этапа 1 пароль хранится в открытом виде в password_hash
  -- (имя колонки задано заранее под будущий bcrypt-хеш).
  -- CHECK гарантирует: баланс никогда не уйдёт в минус.
  CREATE TABLE IF NOT EXISTS users (
    nickname         TEXT PRIMARY KEY,
    nickname_lower   TEXT NOT NULL UNIQUE,
    password_hash    TEXT NOT NULL,
    balance          INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    role             TEXT NOT NULL DEFAULT 'player',
    created_at       TEXT NOT NULL,
    last_payment_at  TEXT,
    wins             INTEGER NOT NULL DEFAULT 0,
    losses           INTEGER NOT NULL DEFAULT 0,
    games_played     INTEGER NOT NULL DEFAULT 0,
    slots_spins      INTEGER NOT NULL DEFAULT 0,
    slots_bet_total  INTEGER NOT NULL DEFAULT 0,
    slots_win_total  INTEGER NOT NULL DEFAULT 0
  );

  -- Сессии по токену. Истечение срока проверяется при каждом чтении
  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    nickname    TEXT NOT NULL REFERENCES users(nickname) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_nickname ON sessions(nickname);

  -- Принятые платежи. Уникальный event_id — основа
  -- идемпотентности (подключается на этапе 2)
  CREATE TABLE IF NOT EXISTS payments (
    event_id     TEXT PRIMARY KEY,
    nickname     TEXT NOT NULL,
    amount       INTEGER NOT NULL,
    currency     TEXT,
    raw_message  TEXT,
    created_at   TEXT NOT NULL
  );

  -- История игр. players_json — массив ников в JSON.
  -- game_type разделяет uno / durak / slots (этап 4)
  CREATE TABLE IF NOT EXISTS history (
    id            TEXT PRIMARY KEY,
    game_type     TEXT NOT NULL DEFAULT 'uno',
    winner        TEXT NOT NULL,
    players_json  TEXT NOT NULL,
    date          TEXT NOT NULL,
    duration_sec  INTEGER NOT NULL DEFAULT 0
  );

  -- Журнал действий админов (этап 5)
  CREATE TABLE IF NOT EXISTS admin_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    admin   TEXT NOT NULL,
    action  TEXT NOT NULL,
    details TEXT,
    date    TEXT NOT NULL
  );
`);

// ===== Константы =====

// Время жизни сессии: 30 дней.
// Этап 1 добавит периодическую очистку просроченных
// и сброс всех сессий игрока
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Сколько последних игр хранится в истории (как раньше в памяти)
const HISTORY_LIMIT = 10;

// ===== Подготовленные выражения =====

const stmts = {
  insertUser: db.prepare(`
    INSERT INTO users (nickname, nickname_lower, password_hash, balance, created_at)
    VALUES (@nickname, @nicknameLower, @passwordHash, @balance, @createdAt)
  `),

  selectUserByNickname: db.prepare(
    "SELECT * FROM users WHERE nickname_lower = ?"
  ),

  applyPayment: db.prepare(`
    UPDATE users
    SET balance = balance + @amount,
        last_payment_at = @paidAt
    WHERE nickname_lower = @nicknameLower
  `),

  addGameStats: db.prepare(`
    UPDATE users
    SET games_played = games_played + 1,
        wins   = wins   + @win,
        losses = losses + @loss
    WHERE nickname_lower = @nicknameLower
  `),

  // Атомарная прокрутка слотов: списание, выигрыш и накопительная
  // статистика — один UPDATE. Условие balance >= @bet не даёт
  // балансу уйти в минус даже при одновременных запросах
  applySpin: db.prepare(`
    UPDATE users
    SET balance         = balance - @bet + @winAmount,
        slots_spins     = slots_spins + 1,
        slots_bet_total = slots_bet_total + @bet,
        slots_win_total = slots_win_total + @winAmount
    WHERE nickname_lower = @nicknameLower AND balance >= @bet
  `),

  insertSession: db.prepare(`
    INSERT INTO sessions (token, nickname, created_at, expires_at)
    VALUES (@token, @nickname, @createdAt, @expiresAt)
  `),

  selectSession: db.prepare("SELECT * FROM sessions WHERE token = ?"),

  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),

  deleteUserSessions: db.prepare("DELETE FROM sessions WHERE nickname = ?"),

  insertHistory: db.prepare(`
    INSERT INTO history (id, game_type, winner, players_json, date, duration_sec)
    VALUES (@id, @gameType, @winner, @playersJson, @date, @durationSec)
  `),

  selectHistory: db.prepare(
    "SELECT * FROM history ORDER BY date DESC, rowid DESC"
  ),

  // Оставляем только HISTORY_LIMIT самых свежих записей
  trimHistory: db.prepare(`
    DELETE FROM history
    WHERE id NOT IN (
      SELECT id FROM history ORDER BY date DESC, rowid DESC LIMIT ${HISTORY_LIMIT}
    )
  `),

  selectPaymentByEvent: db.prepare(
    "SELECT event_id FROM payments WHERE event_id = ?"
  ),

  insertPayment: db.prepare(`
    INSERT INTO payments (event_id, nickname, amount, currency, raw_message, created_at)
    VALUES (@eventId, @nickname, @amount, @currency, @rawMessage, @createdAt)
  `),

  insertAdminLog: db.prepare(`
    INSERT INTO admin_log (admin, action, details, date)
    VALUES (@admin, @action, @details, @date)
  `),
};

// Вставка записи истории + подрезка лимита — одна транзакция
const addHistoryTx = db.transaction(entry => {
  stmts.insertHistory.run(entry);
  stmts.trimHistory.run();
});

// ===== Пользователи =====

// Поиск без учёта регистра (ник приходит из разных источников)
function getUser(nickname) {
  if (typeof nickname !== "string" || nickname === "") return undefined;
  return stmts.selectUserByNickname.get(nickname.toLowerCase());
}

function createUser({ nickname, passwordHash, balance = 0 }) {
  stmts.insertUser.run({
    nickname,
    nicknameLower: nickname.toLowerCase(),
    passwordHash,
    balance,
    createdAt: new Date().toISOString(),
  });

  return getUser(nickname);
}

// Начисление платежа одной операцией
function applyPayment(nickname, amount) {
  const result = stmts.applyPayment.run({
    amount,
    paidAt: new Date().toISOString(),
    nicknameLower: nickname.toLowerCase(),
  });

  return result.changes > 0;
}

// Результат обычной игры: +1 к gamesPlayed и к wins либо losses
function addGameResult(nickname, won) {
  stmts.addGameStats.run({
    win: won ? 1 : 0,
    loss: won ? 0 : 1,
    nicknameLower: nickname.toLowerCase(),
  });
}

// Прокрутка слотов. Возвращает false, если не хватило баланса
// (проигравший гонку запрос корректно отклоняется)
function applySpin(nickname, bet, winAmount) {
  const result = stmts.applySpin.run({
    bet,
    winAmount,
    nicknameLower: nickname.toLowerCase(),
  });

  return result.changes > 0;
}

// ===== Сессии =====

// Токен генерирует вызывающий код (server.js), хранение — здесь
function createSession(nickname, token) {
  const now = Date.now();

  stmts.insertSession.run({
    token,
    nickname,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  });
}

// Возвращает сессию или null, если её нет или срок истёк.
// Просроченная удаляется сразу при обнаружении
function getSession(token) {
  if (!token) return null;

  const session = stmts.selectSession.get(token);
  if (!session) return null;

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    stmts.deleteSession.run(token);
    return null;
  }

  return session;
}

function deleteSession(token) {
  if (!token) return;
  stmts.deleteSession.run(token);
}

// Сброс всех сессий игрока («выйти со всех устройств»).
// Эндпоинт будет подключён на этапе 1
function deleteUserSessions(nickname) {
  stmts.deleteUserSessions.run(nickname);
}

// ===== История =====

function addHistoryEntry({ id, gameType, winner, players, date, durationSec }) {
  addHistoryTx.run({
    id,
    gameType: gameType || "uno",
    winner,
    playersJson: JSON.stringify(players),
    date,
    durationSec,
  });
}

// Записи в формате, который ждёт клиент: players — массив, не JSON-строка
function getHistory() {
  return stmts.selectHistory.all().map(row => ({
    id: row.id,
    gameType: row.game_type,
    winner: row.winner,
    players: JSON.parse(row.players_json),
    date: row.date,
    durationSec: row.duration_sec,
  }));
}

// ===== Платежи (идемпотентность, подключается на этапе 2) =====

function isEventProcessed(eventId) {
  if (!eventId) return false;
  return !!stmts.selectPaymentByEvent.get(eventId);
}

function markEventProcessed({ eventId, nickname, amount, currency, rawMessage }) {
  stmts.insertPayment.run({
    eventId,
    nickname,
    amount,
    currency: currency ?? null,
    rawMessage: rawMessage ?? null,
    createdAt: new Date().toISOString(),
  });
}

// ===== Журнал админ-действий (этап 5) =====

function logAdminAction(admin, action, details) {
  stmts.insertAdminLog.run({
    admin,
    action,
    details: details ?? null,
    date: new Date().toISOString(),
  });
}

module.exports = {
  db,
  getUser,
  createUser,
  applyPayment,
  addGameResult,
  applySpin,
  createSession,
  getSession,
  deleteSession,
  deleteUserSessions,
  addHistoryEntry,
  getHistory,
  isEventProcessed,
  markEventProcessed,
  logAdminAction,
};
