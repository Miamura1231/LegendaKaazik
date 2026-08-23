const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const {
  createGame,
  playCard,
  drawCard,
  sayUno,
  makeBotMove,
} = require("./gameEngine");
const {
  createDurakGame,
  durakAttack,
  durakDefend,
  durakThrowIn,
  durakTake,
  durakPass,
  durakAutoTimeout,
  getExpectedActorId,
  makeDurakBotMove,
  DURAK_ERROR_RESULTS,
} = require("./durakEngine");

const app = express();
app.use(cors());
app.use(express.json());

// Раздача собранного фронтенда (frontend/dist) этим же сервером.
// Нужно для временного публичного теста через Cloudflare Tunnel,
// который пробрасывает только один порт — 3001.
// Локальная разработка через Vite (npm run dev) это никак не затрагивает.
const DIST_DIR = path.join(__dirname, "..", "frontend", "dist");

app.use(express.static(DIST_DIR));

const PORT = 3001;

// Настройки сетевой партии
const TURN_TIME = 30;           // секунд на ход
const BOT_MOVE_DELAY_MS = 1500; // задержка хода бота
const MAX_PLAYERS = 4;          // мест за столом (люди + боты)

// Настройки лобби
const AUTO_DELETE_AFTER_MS = 30000; // пустующий стол удаляется через 30 сек
const AUTO_DELETE_CHECK_MS = 10000; // проверка пустых столов каждые 10 сек

// Настройки слотов
const SLOT_MIN_BET = 10;
// Символы барабанов. 7 символов: вероятность трёх одинаковых ~0.9%,
// двух одинаковых ~37%; выплаты x10/x2 дают матожидание ~0.82 ставки
const SLOT_SYMBOLS = ["🍒", "🍋", "🔔", "💎", "⭐", "🍀", "7"];

// Сообщения движка УНО, означающие отклонённое действие.
// В этом случае состояние НЕ применяется, а ошибка уходит только отправителю.
const ERROR_RESULTS = new Set([
  "Не твой ход!",
  "Карта не найдена",
  "Эту карту нельзя сыграть",
]);

// Временное хранилище данных.
// Потом это заменит настоящий бэкенд.
const users = new Map();
const sessions = new Map();

// История последних игр (максимум 10, самые свежие в начале)
const history = [];

// Допустимые сложности ботов
const ALLOWED_DIFFICULTIES = ["easy", "medium", "hard"];

// Режимы столов:
// "bots"    — игра начинается сразу при входе, свободные места занимают боты
// "players" — партия создаётся вручную создателем, минимум 2 игрока
const ALLOWED_MODES = ["bots", "players"];

// Игры, доступные за столами (мультигейм)
const ALLOWED_GAMES = ["uno", "durak"];

// Список столов лобби (оболочки столов; живое состояние партий — в games)
//
// autoDeleteAt — время (мс), когда пустой стол будет удалён автоматически:
//   * выставляется при создании стола (он ещё пуст) и когда последний
//     игрок уходит;
//   * сбрасывается в null при входе игрока;
//   * null означает "отсчёт не идёт" — благодаря этому стандартные
//     столы живут, пока их никто не трогает
let tables = [
  {
    id: "uno-table-1",
    game: "uno",
    name: "УНО #1",
    players: 0,
    maxPlayers: 8,
    minPlayers: 2,
    minAmount: 10,
    difficulty: "medium",
    status: "waiting",
    mode: "bots",
    creatorNickname: "",
    password: null,
    autoDeleteAt: null,
  },
  {
    id: "uno-table-2",
    game: "uno",
    name: "УНО #2",
    players: 0,
    maxPlayers: 8,
    minPlayers: 2,
    minAmount: 10,
    difficulty: "medium",
    status: "waiting",
    mode: "bots",
    creatorNickname: "",
    password: null,
    autoDeleteAt: null,
  },
];

// Активные комнаты: Map<tableId, room>
// room = {
//   tableId,
//   game — какая игра за столом ("uno" | "durak"),
//   state — состояние партии; null в режиме "players" до нажатия "Начать игру",
//   humans: Map<ник, ws>,
//   turnInterval, botTimeout, resultRecorded, startedAt
// }
const games = new Map();

function generatePassword() {
  // 5 цифр
  return Math.floor(10000 + Math.random() * 90000).toString();
}

function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

function safeUser(user) {
  return {
    nickname: user.nickname,
    balance: user.balance,
    createdAt: user.createdAt,
    lastPaymentAt: user.lastPaymentAt,
    // Fallback для пользователей, созданных до появления статистики
    stats: user.stats || { wins: 0, losses: 0, gamesPlayed: 0 },
  };
}

// Ник пользователя сессии из заголовка Authorization (или null)
function getSessionNickname(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || !sessions.has(token)) return null;
  return sessions.get(token).nickname;
}

// Актуальный статус стола, вычисляемый из живой комнаты.
// Партия идёт — "playing", во всех остальных случаях — "waiting"
function tableStatus(table) {
  const room = games.get(table.id);
  if (room && room.state && room.state.status === "playing") {
    return "playing";
  }
  return "waiting";
}

// Публичное представление стола для клиентов.
// Пароль НИКОГДА не отдаём клиенту — только факт его наличия
function tableView(table) {
  const room = games.get(table.id);
  return {
    id: table.id,
    game: table.game || "uno",
    name: table.name,
    players: room ? room.humans.size : 0,
    maxPlayers: table.maxPlayers,
    minPlayers: table.minPlayers,
    minAmount: table.minAmount,
    difficulty: table.difficulty,
    status: tableStatus(table),
    mode: table.mode || "bots",
    creatorNickname: table.creatorNickname || "",
    hasPassword: table.password != null,
    // Момент автоудаления пустого стола (null — отсчёт не идёт)
    autoDeleteAt: table.autoDeleteAt ?? null,
  };
}

// ===== Вспомогательные функции WebSocket-комнат =====

function sendTo(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(room, message, excludeWs = null) {
  for (const ws of room.humans.values()) {
    if (ws !== excludeWs) {
      sendTo(ws, message);
    }
  }
}

function stopTimers(room) {
  if (room.turnInterval) {
    clearInterval(room.turnInterval);
    room.turnInterval = null;
  }
  if (room.botTimeout) {
    clearTimeout(room.botTimeout);
    room.botTimeout = null;
  }
}

function destroyRoom(tableId) {
  const room = games.get(tableId);
  if (!room) return;
  stopTimers(room);
  games.delete(tableId);
  console.log(`[ROOM] Комната стола ${tableId} закрыта`);
}

// Создание начального состояния партии по типу игры
function createStateFor(table, humanNames, botCount) {
  if ((table.game || "uno") === "durak") {
    return createDurakGame(humanNames, botCount);
  }
  return createGame(humanNames, botCount, table.difficulty || "medium");
}

// Посадка соединения в комнату с заменой старого сокета того же игрока
// (перезагрузка страницы не должна терять место за столом)
function addHumanToRoom(room, ws, nickname, table) {
  const oldWs = room.humans.get(nickname);
  if (oldWs && oldWs !== ws) {
    oldWs._replaced = true;
    oldWs.close();
  }

  room.humans.set(nickname, ws);
  ws.tableId = room.tableId;

  // За столом кто-то есть — отменяем отсчёт автоудаления
  if (table) {
    table.autoDeleteAt = null;
  }
}

// Ожидаемый бот для текущего хода (или null, если ходит человек)
function getExpectedBotId(room) {
  if (!room.state || room.state.status !== "playing") return null;

  if (room.game === "durak") {
    const actorId = getExpectedActorId(room.state);
    if (!actorId) return null;
    const player = room.state.players.find(p => p.id === actorId);
    return player && player.isBot ? player.id : null;
  }

  const current = room.state.players[room.state.currentPlayerIndex];
  return current.isBot ? current.id : null;
}

// Применение хода бота с защитой от зависаний партии.
// Если движок ОТКЛОНИЛ действие бота (например, подкидывание сверх лимита
// стола), отклонённое состояние нельзя применять и рассылать: таймер хода
// сбросится, бот через 1.5 сек повторит ту же попытку — получится
// бесконечный цикл. Вместо этого принуждаем бота к безопасному действию
function applyBotMove(room, botId) {
  if (room.game === "durak") {
    const before = room.state;
    let next = makeDurakBotMove(before, botId);

    if (DURAK_ERROR_RESULTS.has(next.lastAction)) {
      // В фазе подкидывания безопасный выход — пас;
      // в остальных фазах — авто-действие таймаута (всегда валидное)
      if (before.phase === "throwIn") {
        next = durakPass(before, botId);
      }

      // Страховка: если и пас по какой-то причине отклонён —
      // форсируем завершение фазы через авто-таймаут
      if (DURAK_ERROR_RESULTS.has(next.lastAction)) {
        next = durakAutoTimeout(before);
      }
    }

    return next;
  }

  const next = makeBotMove(room.state, botId);

  // Страховка для УНО: вместо отклонённого хода — добор карты
  if (ERROR_RESULTS.has(next.lastAction)) {
    return drawCard(room.state, botId);
  }

  return next;
}

// Планируем ход бота, если сейчас очередь бота (для любой игры)
function scheduleBotMove(room) {
  if (room.botTimeout) {
    clearTimeout(room.botTimeout);
    room.botTimeout = null;
  }

  const botId = getExpectedBotId(room);
  if (!botId) return;

  room.botTimeout = setTimeout(() => {
    room.botTimeout = null;
    if (!room.state || room.state.status !== "playing") return;

    // Перепроверяем, что бот всё ещё должен ходить (защита от гонок)
    if (getExpectedBotId(room) !== botId) return;

    room.state = applyBotMove(room, botId);
    afterStateChanged(room);
  }, BOT_MOVE_DELAY_MS);
}

// Записываем результат завершённой партии: статистика людей,
// оставшихся в комнате, плюс запись в общую историю.
// Единая схема для всех игр: победитель получает win, остальные — loss.
// Для Дурака winner — первый избавившийся от карт,
// остальные (включая дурака) — проигравшие
function recordResults(room) {
  const winner = room.state.winner || "";
  const players = room.state.players.map(p => p.name);
  const durationSec = Math.max(
    0,
    Math.round((Date.now() - room.startedAt) / 1000)
  );

  for (const nickname of room.humans.keys()) {
    const user = users.get(nickname.toLowerCase());
    if (!user) continue;

    if (!user.stats) {
      user.stats = { wins: 0, losses: 0, gamesPlayed: 0 };
    }

    user.stats.gamesPlayed += 1;

    if (winner.toLowerCase() === nickname.toLowerCase()) {
      user.stats.wins += 1;
    } else {
      user.stats.losses += 1;
    }
  }

  history.unshift({
    id: `game-${Date.now()}`,
    winner,
    players,
    date: new Date().toISOString(),
    durationSec,
  });
  if (history.length > 10) {
    history.pop();
  }

  console.log("[GAME FINISHED]", { tableId: room.tableId, game: room.game, winner, durationSec });
}

// Вызывается после любого изменения состояния партии:
// сбрасывает таймер хода, рассылает состояние, планирует бота,
// фиксирует результат при завершении.
// ВАЖНО: вызывать только когда room.state != null
function afterStateChanged(room) {
  if (room.state.status === "playing") {
    room.state.timeLeft = TURN_TIME;
  }

  broadcast(room, { type: "state", game: room.game, state: room.state });

  if (room.state.status === "finished") {
    stopTimers(room);

    if (!room.resultRecorded) {
      room.resultRecorded = true;
      recordResults(room);
    }
    return;
  }

  scheduleBotMove(room);
}

// Серверный таймер хода: тикает раз в секунду.
// На нуле выполняется авто-действие текущего игрока:
//   УНО    — автоматический добор карты
//   Дурак  — авто-атака / взятие / пас (по фазе, см. durakAutoTimeout)
function startTurnTimer(room) {
  stopTimers(room);
  if (!room.state) return;
  room.state.timeLeft = TURN_TIME;

  room.turnInterval = setInterval(() => {
    if (!room.state || room.state.status !== "playing") return;

    room.state.timeLeft -= 1;

    if (room.state.timeLeft <= 0) {
      if (room.game === "durak") {
        room.state = durakAutoTimeout(room.state);
      } else {
        const current = room.state.players[room.state.currentPlayerIndex];
        room.state = drawCard(room.state, current.id);
      }
      afterStateChanged(room);
    } else {
      // Рассылаем состояние каждую секунду, чтобы у всех
      // клиентов был виден одинаковый обратный отсчёт
      broadcast(room, { type: "state", game: room.game, state: room.state });
    }
  }, 1000);
}

// Присоединение к столу
function handleJoin(ws, nickname, tableId) {
  const table = tables.find(t => t.id === tableId);

  if (!table) {
    sendTo(ws, { type: "error", message: "Стол не найден" });
    return;
  }

  const mode = table.mode || "bots";
  const tableGame = table.game || "uno";
  let room = games.get(tableId);

  // Уже сидим в ИДУЩЕЙ партии? Переподключение (F5) разрешено всегда,
  // проверки "игра идёт" действуют только на новичков
  const seatedInRunningGame = !!(
    room &&
    room.state &&
    room.state.status === "playing" &&
    room.state.players.some(p => p.name === nickname)
  );

  // В режим "players" нельзя войти в уже начатую партию
  if (mode === "players" && !seatedInRunningGame && tableStatus(table) === "playing") {
    sendTo(ws, { type: "error", message: "Игра уже идёт" });
    return;
  }

  // Режим "bots": прошлая партия завершилась — начинаем новую
  // с теми же живыми игроками (для любой игры)
  if (mode === "bots" && room && room.state && room.state.status === "finished") {
    const existingHumans = [...room.humans.keys()];
    const isNewcomer = !existingHumans.includes(nickname);
    const humanNames = isNewcomer ? [...existingHumans, nickname] : existingHumans;
    const botCount = Math.max(0, MAX_PLAYERS - humanNames.length);

    stopTimers(room);
    room.state = createStateFor(table, humanNames, botCount);
    room.startedAt = Date.now();
    room.resultRecorded = false;
    startTurnTimer(room);
  }

  // Режим "players": партия завершилась — возвращаем стол в фазу ожидания,
  // чтобы создатель мог запустить переигровку тем же составом
  if (mode === "players" && room && room.state && room.state.status === "finished") {
    stopTimers(room);
    room.state = null;
    room.startedAt = null;
    room.resultRecorded = false;
  }

  // Комнаты ещё нет — создаём
  if (!room) {
    if (mode === "bots") {
      // Классическое поведение: игра начинается сразу при входе
      room = {
        tableId,
        game: tableGame,
        state: createStateFor(table, [nickname], MAX_PLAYERS - 1),
        humans: new Map(),
        turnInterval: null,
        botTimeout: null,
        resultRecorded: false,
        startedAt: Date.now(),
      };

      games.set(tableId, room);
      startTurnTimer(room);
    } else {
      // Режим "players": комната ожидания БЕЗ партии.
      // Игра будет создана по команде создателя "Начать игру"
      room = {
        tableId,
        game: tableGame,
        state: null,
        humans: new Map(),
        turnInterval: null,
        botTimeout: null,
        resultRecorded: false,
        startedAt: null,
      };

      games.set(tableId, room);
    }
  }

  // ===== Фаза ожидания (players, партия ещё не создана) =====
  if (room.state === null) {
    const isNewcomer = !room.humans.has(nickname);

    if (isNewcomer && room.humans.size >= MAX_PLAYERS) {
      sendTo(ws, { type: "error", message: "Стол заполнен" });
      return;
    }

    addHumanToRoom(room, ws, nickname, table);

    if (isNewcomer) {
      broadcast(
        room,
        { type: "playerJoined", playerId: nickname, playerName: nickname },
        ws
      );
    }

    return;
  }

  // ===== Активная партия: ищем своё место =====
  let seat = room.state.players.find(p => p.name === nickname);

  if (seat) {
    // Место существует: либо наше живое (переподключение),
    // либо отданное боту после выхода — забираем обратно
    seat.isBot = false;
  } else {
    // Свободных своих мест нет — занимаем место бота со его картами
    seat = room.state.players.find(p => p.isBot);

    if (!seat) {
      sendTo(ws, { type: "error", message: "Стол заполнен" });
      return;
    }

    seat.name = nickname;
    seat.isBot = false;
  }

  addHumanToRoom(room, ws, nickname, table);

  afterStateChanged(room);
  broadcast(
    room,
    { type: "playerJoined", playerId: seat.id, playerName: nickname },
    ws
  );
}

// Отключение от стола
function handleLeave(nickname, tableId, ws) {
  const room = games.get(tableId);
  if (!room) return;

  // Отвалилось устаревшее соединение (заменено новым) — игнорируем
  if (room.humans.get(nickname) !== ws) return;

  room.humans.delete(nickname);

  const table = tables.find(t => t.id === tableId);
  const seat = room.state
    ? room.state.players.find(p => p.name === nickname)
    : null;

  if (seat && room.state.status === "playing") {
    // Место уходит под управление бота, чтобы партия продолжилась
    seat.isBot = true;
    afterStateChanged(room);
  }

  broadcast(room, {
    type: "playerLeft",
    playerId: seat ? seat.id : nickname,
  });

  // Передача прав создателя первому оставшемуся игроку —
  // иначе стол ожидания завис бы без возможности начать игру
  if (table && table.creatorNickname === nickname && room.humans.size > 0) {
    table.creatorNickname = room.humans.keys().next().value;
    console.log(`[LOBBY] Создателем стола «${table.name}» стал ${table.creatorNickname}`);
  }

  // Последний ушёл — уничтожаем комнату вместе с таймерами
  if (room.humans.size === 0) {
    // Запускаем отсчёт автоудаления пустого стола
    if (table) {
      table.autoDeleteAt = Date.now() + AUTO_DELETE_AFTER_MS;
    }
    destroyRoom(tableId);
  }
}

// Действие игрока. Диспетчеризация по игре комнаты:
//   УНО   — playCard / drawCard / sayUno
//   Дурак — attack / defend / throwIn / take / pass
function handleAction(ws, nickname, action) {
  const room = ws.tableId ? games.get(ws.tableId) : null;
  if (!room || !room.state) return;
  if (room.state.status !== "playing") return;

  const me = room.state.players.find(p => p.name === nickname && !p.isBot);
  if (!me) return;

  // Предварительная проверка очереди — ошибку видим только мы
  const expectedId =
    room.game === "durak"
      ? getExpectedActorId(room.state)
      : room.state.players[room.state.currentPlayerIndex].id;

  if (expectedId !== me.id) {
    sendTo(ws, { type: "error", message: "Сейчас не твой ход" });
    return;
  }

  let next;

  if (room.game === "durak") {
    if (action && action.type === "attack") {
      next = durakAttack(room.state, me.id, action.cardId);
    } else if (action && action.type === "defend") {
      next = durakDefend(room.state, me.id, action.attackCardId, action.defenseCardId);
    } else if (action && action.type === "throwIn") {
      next = durakThrowIn(room.state, me.id, action.cardId);
    } else if (action && action.type === "take") {
      next = durakTake(room.state, me.id);
    } else if (action && action.type === "pass") {
      next = durakPass(room.state, me.id);
    } else {
      sendTo(ws, { type: "error", message: "Неизвестное действие" });
      return;
    }
  } else {
    if (action && action.type === "playCard") {
      next = playCard(room.state, me.id, action.cardId, action.chosenColor);
    } else if (action && action.type === "drawCard") {
      next = drawCard(room.state, me.id);
    } else if (action && action.type === "sayUno") {
      next = sayUno(room.state, me.id);
    } else {
      sendTo(ws, { type: "error", message: "Неизвестное действие" });
      return;
    }
  }

  // Движок сообщает об отклонении через lastAction —
  // такое состояние не применяем и не рассылаем
  const errorSet = room.game === "durak" ? DURAK_ERROR_RESULTS : ERROR_RESULTS;
  if (errorSet.has(next.lastAction)) {
    sendTo(ws, { type: "error", message: next.lastAction });
    return;
  }

  room.state = next;
  afterStateChanged(room);
}

// ===== WebSocket-сервер =====

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  // Токен сессии передаётся в query-string: /ws?token=...
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  const session = token ? sessions.get(token) : null;

  if (!session) {
    sendTo(ws, { type: "error", message: "Нет сессии. Войди заново" });
    ws.close();
    return;
  }

  const nickname = session.nickname;
  console.log(`[WS] Подключение: ${nickname}`);

  ws.on("message", raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!message || typeof message.type !== "string") return;

    if (message.type === "join") {
      handleJoin(ws, nickname, message.tableId);
    } else if (message.type === "action") {
      handleAction(ws, nickname, message.action);
    } else if (message.type === "leave") {
      if (ws.tableId) {
        handleLeave(nickname, ws.tableId, ws);
        ws.tableId = null;
      }
    }
  });

  ws.on("close", () => {
    if (ws._replaced) return; // соединение заменено новым — выходим тихо

    console.log(`[WS] Отключение: ${nickname}`);
    if (ws.tableId) {
      handleLeave(nickname, ws.tableId, ws);
    }
  });
});

// ===== REST API =====

// Сюда будет обращаться Fabric-считыватель.
app.post("/api/minecraft/payment", (req, res) => {
  const { nickname, amount, currency, rawMessage, eventId } = req.body || {};

  if (!nickname || typeof nickname !== "string") {
    return res.status(400).json({
      ok: false,
      error: "Bad nickname",
    });
  }

  const parsedAmount = Number(amount);

  if (!Number.isInteger(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({
      ok: false,
      error: "Bad amount",
    });
  }

  const key = nickname.toLowerCase();
  let user = users.get(key);

  let created = false;

  if (!user) {
    created = true;

    user = {
      nickname,
      password: generatePassword(),
      balance: 0,
      createdAt: new Date().toISOString(),
      lastPaymentAt: null,
      stats: { wins: 0, losses: 0, gamesPlayed: 0 },
    };

    users.set(key, user);
  }

  user.balance += parsedAmount;
  user.lastPaymentAt = new Date().toISOString();

  const tellMessage = `Твой пароль от сайта: ${user.password}`;

  console.log("[PAYMENT]", {
    nickname,
    amount: parsedAmount,
    currency,
    rawMessage,
    eventId,
    created,
    newBalance: user.balance,
  });

  return res.json({
    ok: true,
    created,
    nickname: user.nickname,
    balance: user.balance,
    password: user.password,
    tellMessage,
  });
});

// Вход на сайт.
app.post("/api/auth/login", (req, res) => {
  const { nickname, password } = req.body || {};

  if (!nickname || !password) {
    return res.status(400).json({
      ok: false,
      error: "Нужен ник и пароль",
    });
  }

  const user = users.get(nickname.toLowerCase());

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "Игрок не найден",
    });
  }

  if (user.password !== password) {
    return res.status(401).json({
      ok: false,
      error: "Неверный пароль",
    });
  }

  const token = generateToken();

  sessions.set(token, {
    nickname: user.nickname,
    createdAt: new Date().toISOString(),
  });

  return res.json({
    ok: true,
    token,
    user: safeUser(user),
  });
});

// Проверка сессии и получение профиля.
app.get("/api/me", (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token || !sessions.has(token)) {
    return res.status(401).json({
      ok: false,
      error: "Нет сессии",
    });
  }

  const session = sessions.get(token);
  const user = users.get(session.nickname.toLowerCase());

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "Игрок не найден",
    });
  }

  return res.json({
    ok: true,
    user: safeUser(user),
  });
});

// Выход.
app.post("/api/auth/logout", (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (token) {
    sessions.delete(token);
  }

  return res.json({
    ok: true,
  });
});

// Лобби: количество игроков, статус и момент автоудаления берём
// из актуального состояния, чтобы список всегда отражал реальность
app.get("/api/lobby", (req, res) => {
  return res.json({
    ok: true,
    tables: tables.map(tableView),
  });
});

// Создание стола в лобби.
app.post("/api/lobby/create", (req, res) => {
  const nickname = getSessionNickname(req);

  if (!nickname) {
    return res.status(401).json({
      ok: false,
      error: "Нет сессии",
    });
  }

  const { name, minAmount, difficulty, mode, password, game } = req.body || {};

  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({
      ok: false,
      error: "Название стола обязательно",
    });
  }

  const amount = Number(minAmount);

  if (!Number.isInteger(amount) || amount < 10) {
    return res.status(400).json({
      ok: false,
      error: "Минимальная сумма должна быть целым числом от 10",
    });
  }

  // Некорректная или отсутствующая сложность -> средняя (обратная совместимость).
  // Для режима "players" клиент сложность не отправляет вовсе
  const tableDifficulty = ALLOWED_DIFFICULTIES.includes(difficulty)
    ? difficulty
    : "medium";

  // Некорректный или отсутствующий режим -> "bots" (обратная совместимость)
  const tableMode = ALLOWED_MODES.includes(mode) ? mode : "bots";

  // Некорректная или отсутствующая игра -> "uno" (обратная совместимость)
  const tableGame = ALLOWED_GAMES.includes(game) ? game : "uno";

  // Пароль имеет смысл только в режиме "players"
  const tablePassword =
    tableMode === "players" &&
    typeof password === "string" &&
    password.trim() !== ""
      ? password.trim()
      : null;

  const newTable = {
    id: `uno-table-${Date.now()}`,
    game: tableGame,
    name: name.trim(),
    players: 0,
    maxPlayers: 8,
    minPlayers: 2,
    minAmount: amount,
    difficulty: tableDifficulty,
    status: "waiting",
    mode: tableMode,
    creatorNickname: nickname,
    password: tablePassword,
    // Стол создан пустым — сразу запускаем отсчёт автоудаления.
    // При входе первого игрока он сбросится
    autoDeleteAt: Date.now() + AUTO_DELETE_AFTER_MS,
  };

  tables.push(newTable);

  console.log(`[LOBBY] ${nickname} создал стол «${newTable.name}» (${tableGame}/${tableMode})`);

  return res.json({
    ok: true,
    table: tableView(newTable),
  });
});

// Проверка возможности входа за стол (пароль, статус, вместимость).
// Реальную посадку выполняет WebSocket-join на странице игры.
app.post("/api/lobby/join", (req, res) => {
  const nickname = getSessionNickname(req);

  if (!nickname) {
    return res.status(401).json({
      ok: false,
      error: "Нет сессии",
    });
  }

  const { tableId, password } = req.body || {};

  if (typeof tableId !== "string" || tableId === "") {
    return res.status(400).json({
      ok: false,
      error: "Не указан стол",
    });
  }

  const table = tables.find(t => t.id === tableId);

  if (!table) {
    return res.status(404).json({
      ok: false,
      error: "Стол не найден",
    });
  }

  const room = games.get(tableId);
  const mode = table.mode || "bots";

  // Уже за этим столом (переподключение) — пускаем без проверок ниже
  const alreadySeated =
    !!room &&
    (room.humans.has(nickname) ||
      (room.state != null &&
        room.state.players.some(p => p.name === nickname)));

  if (!alreadySeated) {
    // В начатую партию режима "players" вход запрещён
    if (mode === "players" && tableStatus(table) === "playing") {
      return res.status(409).json({
        ok: false,
        error: "Игра уже идёт",
      });
    }

    // Проверка пароля (хранится в памяти, мок — без хеширования)
    if (table.password != null) {
      if (typeof password !== "string" || password !== table.password) {
        return res.status(403).json({
          ok: false,
          error: "Неверный пароль",
        });
      }
    }

    // Вместимость в фазе ожидания
    if (room && room.state === null && room.humans.size >= MAX_PLAYERS) {
      return res.status(409).json({
        ok: false,
        error: "Стол заполнен",
      });
    }
  }

  return res.json({
    ok: true,
  });
});

// Создатель запускает партию в режиме "players" (для любой игры)
app.post("/api/lobby/start", (req, res) => {
  const nickname = getSessionNickname(req);

  if (!nickname) {
    return res.status(401).json({
      ok: false,
      error: "Нет сессии",
    });
  }

  const { tableId } = req.body || {};

  if (typeof tableId !== "string" || tableId === "") {
    return res.status(400).json({
      ok: false,
      error: "Не указан стол",
    });
  }

  const table = tables.find(t => t.id === tableId);

  if (!table) {
    return res.status(404).json({
      ok: false,
      error: "Стол не найден",
    });
  }

  if ((table.mode || "bots") !== "players") {
    return res.status(400).json({
      ok: false,
      error: "Этот стол запускается автоматически",
    });
  }

  if (table.creatorNickname !== nickname) {
    return res.status(403).json({
      ok: false,
      error: "Только создатель может начать игру",
    });
  }

  if (tableStatus(table) === "playing") {
    return res.status(409).json({
      ok: false,
      error: "Игра уже идёт",
    });
  }

  const room = games.get(tableId);

  if (!room || room.state !== null) {
    return res.status(409).json({
      ok: false,
      error: "Игра уже идёт",
    });
  }

  if (room.humans.size < 2) {
    return res.status(400).json({
      ok: false,
      error: "Нужно минимум 2 игрока",
    });
  }

  // Партия только из живых игроков, без ботов.
  // Тип игры берём из стола — работает и для УНО, и для Дурака
  room.state = createStateFor(table, [...room.humans.keys()], 0);
  room.startedAt = Date.now();
  room.resultRecorded = false;

  startTurnTimer(room);
  afterStateChanged(room);

  console.log(`[LOBBY] ${nickname} начал игру на столе «${table.name}»`);

  return res.json({
    ok: true,
  });
});

// Удаление стола создателем (только до начала игры)
app.post("/api/lobby/delete", (req, res) => {
  const nickname = getSessionNickname(req);

  if (!nickname) {
    return res.status(401).json({
      ok: false,
      error: "Нет сессии",
    });
  }

  const { tableId } = req.body || {};

  if (typeof tableId !== "string" || tableId === "") {
    return res.status(400).json({
      ok: false,
      error: "Не указан стол",
    });
  }

  const table = tables.find(t => t.id === tableId);

  if (!table) {
    return res.status(404).json({
      ok: false,
      error: "Стол не найден",
    });
  }

  if (table.creatorNickname !== nickname) {
    return res.status(403).json({
      ok: false,
      error: "Только создатель может удалить стол",
    });
  }

  if (tableStatus(table) === "playing") {
    return res.status(409).json({
      ok: false,
      error: "Нельзя удалить стол во время игры",
    });
  }

  destroyRoom(tableId);
  tables = tables.filter(t => t.id !== tableId);

  console.log(`[LOBBY] ${nickname} удалил стол «${table.name}»`);

  return res.json({
    ok: true,
  });
});

// Кик игрока со стола (только создатель)
app.post("/api/lobby/kick", (req, res) => {
  const nickname = getSessionNickname(req);

  if (!nickname) {
    return res.status(401).json({
      ok: false,
      error: "Нет сессии",
    });
  }

  const { tableId, playerNickname } = req.body || {};

  if (typeof tableId !== "string" || tableId === "") {
    return res.status(400).json({
      ok: false,
      error: "Не указан стол",
    });
  }

  if (typeof playerNickname !== "string" || playerNickname === "") {
    return res.status(400).json({
      ok: false,
      error: "Не указан игрок",
    });
  }

  const table = tables.find(t => t.id === tableId);

  if (!table) {
    return res.status(404).json({
      ok: false,
      error: "Стол не найден",
    });
  }

  if (table.creatorNickname !== nickname) {
    return res.status(403).json({
      ok: false,
      error: "Кикать может только создатель",
    });
  }

  if (playerNickname === nickname) {
    return res.status(400).json({
      ok: false,
      error: "Нельзя кикнуть себя",
    });
  }

  const room = games.get(tableId);

  if (!room || !room.humans.has(playerNickname)) {
    return res.status(404).json({
      ok: false,
      error: "Игрок не за этим столом",
    });
  }

  room.humans.delete(playerNickname);

  // Если партия идёт — место кикнутого доигрывает бот
  const seat = room.state
    ? room.state.players.find(p => p.name === playerNickname)
    : null;

  if (seat && room.state.status === "playing") {
    seat.isBot = true;
    afterStateChanged(room);
  }

  broadcast(room, {
    type: "playerLeft",
    playerId: seat ? seat.id : playerNickname,
  });

  // Соединение кикнутого НЕ закрываем принудительно: иначе GameSocket
  // начал бы переподключаться и вернул игрока за стол. Клиент сам
  // обнаружит кик через опрос my-table и выйдет из комнаты.

  if (room.humans.size === 0) {
    // Запускаем отсчёт автоудаления пустого стола
    table.autoDeleteAt = Date.now() + AUTO_DELETE_AFTER_MS;
    destroyRoom(tableId);
  }

  console.log(`[LOBBY] ${nickname} кикнул ${playerNickname} со стола «${table.name}»`);

  return res.json({
    ok: true,
  });
});

// Информация о столе, где сейчас находится пользователь.
// Используется клиентом для: обнаружения кика, экрана ожидания,
// списка игроков, определения прав создателя и типа игры
app.get("/api/lobby/my-table", (req, res) => {
  const nickname = getSessionNickname(req);

  if (!nickname) {
    return res.status(401).json({
      ok: false,
      error: "Нет сессии",
    });
  }

  for (const [tableId, room] of games) {
    if (!room.humans.has(nickname)) continue;

    const table = tables.find(t => t.id === tableId);
    if (!table) continue;

    return res.json({
      ok: true,
      table: {
        id: table.id,
        name: table.name,
        game: table.game || "uno",
        mode: table.mode || "bots",
        status: tableStatus(table),
        isCreator: table.creatorNickname === nickname,
        players: [...room.humans.keys()],
        minPlayers: table.minPlayers,
      },
    });
  }

  // Пользователь не за каким столом
  return res.json({
    ok: true,
    table: null,
  });
});

// Прокрутка слотов. Баланс меняет только сервер одной операцией;
// статистика wins/losses/gamesPlayed слотами НЕ затрагивается
app.post("/api/slots/spin", (req, res) => {
  const nickname = getSessionNickname(req);

  if (!nickname) {
    return res.status(401).json({
      ok: false,
      error: "Нет сессии",
    });
  }

  const { bet } = req.body || {};
  const parsedBet = Number(bet);

  if (!Number.isInteger(parsedBet) || parsedBet < SLOT_MIN_BET) {
    return res.status(400).json({
      ok: false,
      error: `Ставка должна быть целым числом от ${SLOT_MIN_BET}`,
    });
  }

  const user = users.get(nickname.toLowerCase());

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "Игрок не найден",
    });
  }

  // Атомарность обеспечивается синхронностью: списание и начисление
  // происходят в одном обработчике без промежуточных await,
  // поэтому параллельные запросы не могут создать гонку
  if (parsedBet > user.balance) {
    return res.status(400).json({
      ok: false,
      error: "Недостаточно средств",
    });
  }

  // Серверный RNG на криптографическом генераторе
  const reels = [
    SLOT_SYMBOLS[crypto.randomInt(SLOT_SYMBOLS.length)],
    SLOT_SYMBOLS[crypto.randomInt(SLOT_SYMBOLS.length)],
    SLOT_SYMBOLS[crypto.randomInt(SLOT_SYMBOLS.length)],
  ];

  // Таблица выплат: 3 одинаковых — x10, любые 2 одинаковых — x2
  let winAmount = 0;

  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    winAmount = parsedBet * 10;
  } else if (
    reels[0] === reels[1] ||
    reels[1] === reels[2] ||
    reels[0] === reels[2]
  ) {
    winAmount = parsedBet * 2;
  }

  // Списание ставки и начисление выигрыша одной операцией
  user.balance = user.balance - parsedBet + winAmount;

  console.log("[SLOTS]", {
    nickname,
    bet: parsedBet,
    reels,
    winAmount,
    newBalance: user.balance,
  });

  return res.json({
    ok: true,
    reels,
    winAmount,
    newBalance: user.balance,
  });
});

// Результат завершённой ЛОКАЛЬНОЙ игры (fallback-режим клиента УНО).
// Сетевые партии сервер записывает сам в recordResults().
app.post("/api/game/result", (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token || !sessions.has(token)) {
    return res.status(401).json({
      ok: false,
      error: "Нет сессии",
    });
  }

  const session = sessions.get(token);
  const user = users.get(session.nickname.toLowerCase());

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "Игрок не найден",
    });
  }

  const { winner, players, durationSec } = req.body || {};

  if (
    !Array.isArray(players) ||
    players.length === 0 ||
    players.some(p => typeof p !== "string")
  ) {
    return res.status(400).json({
      ok: false,
      error: "Некорректный список игроков",
    });
  }

  if (typeof winner !== "string" || !players.includes(winner)) {
    return res.status(400).json({
      ok: false,
      error: "Победитель должен быть среди игроков",
    });
  }

  const parsedDuration = Number(durationSec);
  const duration =
    Number.isInteger(parsedDuration) && parsedDuration >= 0 ? parsedDuration : 0;

  // Ник берём из сессии, а не из тела запроса —
  // иначе любой клиент мог бы накрутить статистику кому угодно
  if (!user.stats) {
    user.stats = { wins: 0, losses: 0, gamesPlayed: 0 };
  }

  user.stats.gamesPlayed += 1;

  if (winner.toLowerCase() === session.nickname.toLowerCase()) {
    user.stats.wins += 1;
  } else {
    user.stats.losses += 1;
  }

  const entry = {
    id: `game-${Date.now()}`,
    winner,
    players,
    date: new Date().toISOString(),
    durationSec: duration,
  };

  history.unshift(entry);
  if (history.length > 10) {
    history.pop();
  }

  return res.json({
    ok: true,
    stats: user.stats,
  });
});

// История последних игр.
app.get("/api/history", (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token || !sessions.has(token)) {
    return res.status(401).json({
      ok: false,
      error: "Нет сессии",
    });
  }

  return res.json({
    ok: true,
    history,
  });
});

// SPA fallback: все остальные GET-запросы отдают index.html собранного
// фронтенда. Это позволяет открывать вложенные маршруты приложения
// напрямую (обновление страницы, переход по ссылке).
// /api и /ws исключены: неизвестные API-маршруты должны отдавать JSON-ошибку,
// а не HTML-страницу.
app.get("*", (req, res) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
    return res.status(404).json({
      ok: false,
      error: "Не найдено",
    });
  }

  const indexPath = path.join(DIST_DIR, "index.html");

  // Фронтенд ещё не собран — не падаем, а объясняем, что делать
  if (!fs.existsSync(indexPath)) {
    return res
      .status(503)
      .send("Фронтенд не собран. Выполни в папке frontend команду: npm run build");
  }

  res.sendFile(indexPath);
});

// Автоудаление пустых столов: проверяем каждые 10 секунд.
// Отсчёт задаётся полем autoDeleteAt:
//   * выставляется при создании стола и когда последний игрок уходит;
//   * сбрасывается в null при входе игрока (см. addHumanToRoom);
//   * null — стол не удаляется (так живут нетронутые стандартные столы)
setInterval(() => {
  const now = Date.now();

  tables = tables.filter(table => {
    // Отсчёт не запущен — стол оставляем
    if (table.autoDeleteAt == null) return true;

    if (now >= table.autoDeleteAt) {
      destroyRoom(table.id);
      console.log(`[LOBBY] Стол «${table.name}» удалён автоматически (пустовал дольше 30 сек)`);
      return false;
    }

    return true;
  });
}, AUTO_DELETE_CHECK_MS);

server.listen(PORT, () => {
  console.log(`Mock server running on http://localhost:${PORT}`);
  console.log(`WebSocket available on ws://localhost:${PORT}/ws`);
});
