// Слой постоянного хранения данных (этапы 0–5).
// Заменяет временные Map/массивы в памяти: пользователи, сессии,
// платежи, история игр и журнал админ-действий теперь живут в SQLite
// и переживают перезапуск сервера.
//
// better-sqlite3 выбран из-за синхронного API: обработчики остаются
// простыми, без async/await, а подготовленные выражения и транзакции
// дают атомарность изменений баланса.
//
// Гарантии баланса (этап 3):
//   * все изменения — атомарные операции или транзакции;
//   * CHECK (balance >= 0) в схеме физически запрещает минус;
//   * единственные пути изменения баланса: processPayment (платежи),
//     applySpin (слоты) и adjustBalance (ручные операции админа,
//     подключены на этапе 5). Ни один другой код балансы не трогает.
//
// История (этап 4): каждая запись помечена источником (колонка source):
//   "network" — сетевая партия, результат записал сам сервер;
//   "local"   — результат локальной партии от клиента, сервером
//               не проверялся. Слоты в историю не пишутся вовсе —
//               у них отдельная накопительная статистика в users.
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
  -- Игроки. Пароли хранятся ТОЛЬКО как bcrypt-хеши (этап 1).
  -- Записи, созданные на этапе 0 с открытым паролем, мигрируют
  -- лениво: при первом успешном входе хеш перезаписывается
  -- (см. auth.js и /api/auth/login в server.js).
  -- CHECK гарантирует: баланс никогда не уйдёт в минус.
  -- Колонки slots_* — отдельная слот-статистика (этапы 0 и 4):
  -- слоты намеренно НЕ увеличивают wins/losses/games_played.
  -- Колонка role используется админкой (этап 5): 'player' | 'admin'
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

  -- Принятые платежи. Уникальный event_id — основа идемпотентности:
  -- повторная доставка перевода не может попасть в таблицу вторым
  -- рядом (PRIMARY KEY отклонит её на уровне БД)
  CREATE TABLE IF NOT EXISTS payments (
    event_id     TEXT PRIMARY KEY,
    nickname     TEXT NOT NULL,
    amount       INTEGER NOT NULL,
    currency     TEXT,
    raw_message  TEXT,
    created_at   TEXT NOT NULL
  );

  -- История игр. players_json — массив ников в JSON.
  -- game_type разделяет uno / durak (этап 4); слоты сюда не пишутся.
  -- Колонка source добавляется миграцией ниже (этап 4)
  CREATE TABLE IF NOT EXISTS history (
    id            TEXT PRIMARY KEY,
    game_type     TEXT NOT NULL DEFAULT 'uno',
    winner        TEXT NOT NULL,
    players_json  TEXT NOT NULL,
    date          TEXT NOT NULL,
    duration_sec  INTEGER NOT NULL DEFAULT 0
  );

  -- Журнал действий админов (этап 5): кто, что и когда сделал.
  -- Заполняется всеми изменяющими эндпоинтами /api/admin/*
  CREATE TABLE IF NOT EXISTS admin_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    admin   TEXT NOT NULL,
    action  TEXT NOT NULL,
    details TEXT,
    date    TEXT NOT NULL
  );
`);

// ===== Лёгкие миграции схемы =====
//
// CREATE TABLE IF NOT EXISTS не изменяет уже существующие таблицы,
// поэтому новые колонки добавляются отдельными ALTER TABLE.
// Функция идемпотентна: при повторных стартах колонка не дублируется.

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();

  if (!columns.some(col => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

// Этап 4: источник записи истории.
//   "network" — партия сыграна на сервере, результат записан самим
//               сервером (recordResults), ему можно доверять;
//   "local"   — результат локальной партии клиента (fallback-режим
//               УНО без связи с сервером), прислан клиентом и сервером
//               НЕ проверялся. Помечается, чтобы такие записи можно
//               было отличить в интерфейсе и админке.
// Старые записи получают значение по умолчанию "network":
// до этапа 4 все записи в БД создавались только сервером
ensureColumn("history", "source", "source TEXT NOT NULL DEFAULT 'network'");

// ===== Константы =====

// Время жизни сессии: 30 дней.
// Просроченные сессии отклоняются при каждом чтении (getSession),
// а фоновая чистка таблицы запускается из server.js
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

  selectAllUsers: db.prepare("SELECT * FROM users ORDER BY created_at ASC"),

  // Замена хеша пароля — ленивая миграция открытых паролей (этап 1)
  updateUserPassword: db.prepare(`
    UPDATE users
    SET password_hash = @passwordHash
    WHERE nickname_lower = @nicknameLower
  `),

  // Установка роли пользователя (этап 5): 'player' | 'admin'.
  // Вызывается повышением из списка ADMIN_NICKNAMES
  updateUserRole: db.prepare(`
    UPDATE users
    SET role = @role
    WHERE nickname_lower = @nicknameLower
  `),

  // Начисление платежа. Вызывается ТОЛЬКО внутри транзакции
  // processPaymentTx (см. раздел "Платежи") — отдельно использовать
  // нельзя, иначе снова появится окно между деньгами и журналом
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
  // (гонки быстрых кликов исключены, этап 3).
  // ВАЖНО (этап 4): wins/losses/games_played здесь НЕ трогаются —
  // слот-статистика живёт отдельно от карточной
  applySpin: db.prepare(`
    UPDATE users
    SET balance         = balance - @bet + @winAmount,
        slots_spins     = slots_spins + 1,
        slots_bet_total = slots_bet_total + @bet,
        slots_win_total = slots_win_total + @winAmount
    WHERE nickname_lower = @nicknameLower AND balance >= @bet
  `),

  // Произвольное изменение баланса одной операцией (этапы 3 и 5):
  // ручные начисления/списания админа. Списание сверх текущего
  // баланса не применяется (changes === 0)
  adjustBalance: db.prepare(`
    UPDATE users
    SET balance = balance + @delta
    WHERE nickname_lower = @nicknameLower AND balance + @delta >= 0
  `),

  // Сброс ВСЕЙ статистики игрока (этап 5): карточной и слот-статистики.
  // Баланс намеренно НЕ трогается — это разные вещи
  resetUserStats: db.prepare(`
    UPDATE users
    SET wins            = 0,
        losses          = 0,
        games_played    = 0,
        slots_spins     = 0,
        slots_bet_total = 0,
        slots_win_total = 0
    WHERE nickname_lower = @nicknameLower
  `),

  // Контроль целостности: число пользователей с отрицательным
  // балансом. Схема запрещает такие значения через CHECK,
  // запрос — страховка от повреждения базы внешними инструментами
  countNegativeBalances: db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE balance < 0"
  ),

  insertSession: db.prepare(`
    INSERT INTO sessions (token, nickname, created_at, expires_at)
    VALUES (@token, @nickname, @createdAt, @expiresAt)
  `),

  selectSession: db.prepare("SELECT * FROM sessions WHERE token = ?"),

  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),

  deleteUserSessions: db.prepare("DELETE FROM sessions WHERE nickname = ?"),

  // Массовая чистка просроченных сессий (фон, этап 1)
  deleteExpiredSessions: db.prepare(
    "DELETE FROM sessions WHERE expires_at <= ?"
  ),

  insertHistory: db.prepare(`
    INSERT INTO history (id, game_type, winner, players_json, date, duration_sec, source)
    VALUES (@id, @gameType, @winner, @playersJson, @date, @durationSec, @source)
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

  // Чтение журнала админ-действий, самые свежие первыми (этап 5)
  selectAdminLog: db.prepare(
    "SELECT * FROM admin_log ORDER BY id DESC LIMIT @limit"
  ),
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

// Все пользователи подряд — для списка игроков в админке (этап 5)
function getAllUsers() {
  return stmts.selectAllUsers.all();
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

// Перезаписать хеш пароля игрока.
// Используется для ленивой миграции открытых паролей этапа 0:
// первый успешный вход со старой записью превращает её в bcrypt-хеш
function setUserPassword(nickname, passwordHash) {
  stmts.updateUserPassword.run({
    passwordHash,
    nicknameLower: nickname.toLowerCase(),
  });
}

// Установить роль пользователя (этап 5).
// Используется повышением ников из ADMIN_NICKNAMES до 'admin'
function setUserRole(nickname, role) {
  const result = stmts.updateUserRole.run({
    role,
    nicknameLower: nickname.toLowerCase(),
  });

  return result.changes > 0;
}

// Результат обычной игры: +1 к gamesPlayed и к wins либо losses.
// Вызывается ТОЛЬКО для карточных партий (УНО/Дурак) —
// слоты идут через applySpin со своей статистикой (этап 4)
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

// Атомарное изменение баланса на произвольную дельту (этапы 3 и 5).
// Условие balance + @delta >= 0 не даёт уйти в минус даже при
// параллельных операциях; CHECK-ограничение схемы страхует вдобавок.
// Используется ручным начислением/списанием админа (/api/admin/balance)
function adjustBalance(nickname, delta) {
  const result = stmts.adjustBalance.run({
    delta,
    nicknameLower: nickname.toLowerCase(),
  });

  return result.changes > 0;
}

// Сбросить всю статистику игрока (этап 5): карточную и слот-статистику.
// Баланс не затрагивается. Возвращает false, если игрока нет
function resetUserStats(nickname) {
  const result = stmts.resetUserStats.run({
    nicknameLower: nickname.toLowerCase(),
  });

  return result.changes > 0;
}

// Число пользователей с отрицательным балансом.
// Нормальное значение — всегда 0; вызывается при старте сервера
function countNegativeBalances() {
  return stmts.countNegativeBalances.get().n;
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
// Используется эндпоинтом POST /api/auth/logout-all (этап 1)
function deleteUserSessions(nickname) {
  stmts.deleteUserSessions.run(nickname);
}

// Удалить ВСЕ просроченные сессии одним запросом.
// Вызывается при старте сервера и затем по таймеру (server.js);
// корректность конкретной сессии в любом случае проверяется
// по expires_at при каждом чтении в getSession
function deleteExpiredSessions() {
  stmts.deleteExpiredSessions.run(new Date().toISOString());
}

// ===== История (этап 4) =====

// Добавить запись в историю.
// source: "network" (по умолчанию) — партия на сервере;
//         "local" — результат, присланный клиентом без проверки.
// Все внутренние вызовы (recordResults) создают сетевые записи,
// поэтому параметр опционален
function addHistoryEntry({ id, gameType, winner, players, date, durationSec, source }) {
  addHistoryTx.run({
    id,
    gameType: gameType || "uno",
    winner,
    playersJson: JSON.stringify(players),
    date,
    durationSec,
    source: source || "network",
  });
}

// Записи в формате, который ждёт клиент: players — массив, не JSON-строка.
// Поле source добавлено в этапе 4; старые клиенты просто игнорируют его
function getHistory() {
  return stmts.selectHistory.all().map(row => ({
    id: row.id,
    gameType: row.game_type,
    winner: row.winner,
    players: JSON.parse(row.players_json),
    date: row.date,
    durationSec: row.duration_sec,
    source: row.source,
  }));
}

// ===== Платежи (этапы 2–3) =====

function isEventProcessed(eventId) {
  if (!eventId) return false;
  return !!stmts.selectPaymentByEvent.get(eventId);
}

// Начисление платежа + запись в журнал — ОДНА транзакция (этап 3).
//
// Раньше это были два отдельных вызова: если бы процесс упал между
// начислением и отметкой eventId, повторная доставка перевода после
// рестарта зачислила бы деньги второй раз. Общая транзакция закрывает
// это окно: применяются либо обе операции, либо ни одна.
//
// Второй барьер — сама БД: повторная вставка того же event_id
// невозможна, PRIMARY KEY таблицы payments бросит ошибку ограничения
// (обрабатывается через isUniqueConstraintError)
const processPaymentTx = db.transaction(record => {
  stmts.applyPayment.run({
    amount: record.amount,
    paidAt: record.createdAt,
    nicknameLower: record.nickname.toLowerCase(),
  });

  stmts.insertPayment.run(record);
});

function processPayment({ nickname, amount, eventId, currency, rawMessage }) {
  processPaymentTx.run({
    eventId,
    nickname,
    amount,
    currency: currency ?? null,
    rawMessage: rawMessage ?? null,
    createdAt: new Date().toISOString(),
  });
}

// Определить по ошибке better-sqlite3, что она вызвана нарушением
// ограничения уникальности (например, повторный event_id)
function isUniqueConstraintError(err) {
  return (
    err instanceof Error &&
    typeof err.code === "string" &&
    err.code.startsWith("SQLITE_CONSTRAINT")
  );
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

// Последние действия админов, самые свежие первыми.
// Лимит ограничивает выборку; вызов без аргумента вернёт пустой список —
// вызывающий код (server.js) всегда передаёт конкретный лимит
function getAdminLog(limit) {
  return stmts.selectAdminLog.all({ limit });
}

module.exports = {
  db,
  getUser,
  createUser,
  setUserPassword,
  getAllUsers,
  setUserRole,
  addGameResult,
  applySpin,
  adjustBalance,
  resetUserStats,
  countNegativeBalances,
  createSession,
  getSession,
  deleteSession,
  deleteUserSessions,
  deleteExpiredSessions,
  addHistoryEntry,
  getHistory,
  isEventProcessed,
  processPayment,
  isUniqueConstraintError,
  logAdminAction,
  getAdminLog,
};
