import { useState, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { createGame, playCard, drawCard, sayUno, getPlayableCards } from "../games/uno/engine";
import { makeBotMove } from "../games/uno/bots";
import { CardComponent } from "../games/uno/CardComponent";
import { useAuthStore } from "../store/authStore";
import {
  apiLobby,
  apiGameResult,
  apiMyTable,
  apiStartGame,
  apiDeleteTable,
  apiKickPlayer,
} from "../api/client";
import { showToast } from "../components/Toast";
import { ConfirmModal } from "../components/ConfirmModal";
import { GameSocket } from "../network/socket";
import type { ConnectionState, GameName } from "../network/types";
import type { MyTableInfo } from "../api/types";
import type { GameState, CardColor, BotDifficulty, GameAction } from "../games/uno/types";
import type { DurakGameState } from "../games/durak/types";
import { DurakGame } from "../games/durak/DurakGame";

// Время на один ход в секундах (локальный режим; на сервере то же значение)
const TURN_TIME = 30;

// Максимальное количество мест за столом (люди + боты)
const MAX_SEATS = 4;

// Период опроса my-table: обнаружение кика + обновление экрана ожидания
const MY_TABLE_POLL_INTERVAL_MS = 3000;

// Режим работы УНО-стола:
// connecting — ждём первый ответ сервера или решение о fallback
// server     — авторитетный сервер, состояние приходит по WebSocket
// local      — fallback: локальная игра с ботами (прежняя логика)
type GameMode = "connecting" | "server" | "local";

// Общие пропсы игровых компонентов: сокетом владеет диспетчер,
// компоненты только используют его для отправки действий
interface GameComponentProps {
  tableInfo: MyTableInfo | null;
  connStatus: ConnectionState;
  socketRef: MutableRefObject<GameSocket | null>;
}

// ===== Игровой компонент УНО =====
// Сокет создаётся в диспетчере и переживает смену экранов (ожидание/игра),
// поэтому здесь только: приём состояния через пропсы, локальный fallback
// с ботами и таймерами, отправка действий.

function UnoGame({
  tableInfo,
  connStatus,
  socketRef,
  serverState,
  connFailed,
}: GameComponentProps & {
  serverState: GameState | null;
  connFailed: boolean;
}) {
  const { tableId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();

  // Локальное состояние для fallback-режима
  const [localState, setLocalState] = useState<GameState | null>(null);
  const [choosingColor, setChoosingColor] = useState(false);
  const [pendingCard, setPendingCard] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState(TURN_TIME);
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  // Режим выводится из источника состояния:
  // есть серверное — "server"; связь окончательно потеряна — "local";
  // иначе ещё подключаемся
  const mode: GameMode = serverState ? "server" : connFailed ? "local" : "connecting";

  // Отображаемое состояние: приоритет у авторитетного сервера
  const game = serverState ?? localState;

  // Актуальное ЛОКАЛЬНОЕ состояние для таймеров (они работают только
  // в локальном режиме). Защищает от устаревших замыканий.
  const gameRef = useRef<GameState | null>(null);
  const botMoveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Момент начала локальной партии — для расчёта длительности
  const gameStartRef = useRef<number>(Date.now());
  // Защита от повторной отправки результата (локальный режим)
  const resultSentRef = useRef(false);
  // Защита от повторного тоста о результате (серверный режим)
  const resultToastShownRef = useRef(false);

  useEffect(() => {
    gameRef.current = localState;
  }, [localState]);

  // Запуск локальной партии при окончательной потере связи.
  // Сложность ботов берём из данных стола в лобби.
  useEffect(() => {
    if (!connFailed || localState || !user) return;

    let cancelled = false;

    const startLocalGame = async (nickname: string) => {
      let difficulty: BotDifficulty = "medium";

      const lobbyResponse = await apiLobby();
      if (lobbyResponse.ok && Array.isArray(lobbyResponse.tables)) {
        const table = lobbyResponse.tables.find(t => t.id === tableId);
        if (
          table &&
          (table.difficulty === "easy" ||
           table.difficulty === "medium" ||
           table.difficulty === "hard")
        ) {
          difficulty = table.difficulty;
        }
      }

      if (cancelled) return;

      gameStartRef.current = Date.now();
      resultSentRef.current = false;
      setLocalState(createGame([nickname], 3, difficulty));
    };

    void startLocalGame(user.nickname);

    return () => {
      cancelled = true;
    };
    // Одноразовый запуск при появлении connFailed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connFailed]);

  // Тост о результате в серверном режиме (статистику пишет сервер)
  useEffect(() => {
    if (mode !== "server" || !game) return;

    if (game.status === "playing") {
      // Новая партия на том же столе — разрешаем будущий тост
      resultToastShownRef.current = false;
      return;
    }

    if (game.status !== "finished" || resultToastShownRef.current) return;
    resultToastShownRef.current = true;

    const iWon = game.winner === user?.nickname;
    showToast(
      iWon ? "success" : "info",
      iWon ? "Победа! Результат записан" : `Партия окончена. Победил ${game.winner}`
    );
  }, [game?.status, mode, user?.nickname]);

  // Отправка результата на сервер в ЛОКАЛЬНОМ режиме — ровно один раз.
  // В серверном режиме это делает сам сервер.
  useEffect(() => {
    if (mode !== "local") return;
    if (!game || !user || game.status !== "finished") return;
    if (resultSentRef.current) return;
    resultSentRef.current = true;

    const iWon = game.winner === user.nickname;
    const durationSec = Math.max(
      0,
      Math.round((Date.now() - gameStartRef.current) / 1000)
    );

    apiGameResult(game.winner ?? "", game.players.map(p => p.name), durationSec)
      .then(response => {
        if (response.ok) {
          showToast(
            iWon ? "success" : "info",
            iWon
              ? "Победа! Результат записан в статистику"
              : "Игра окончена. Результат записан в статистику"
          );
        } else {
          showToast("error", response.error || "Не удалось сохранить результат игры");
        }
      });
  }, [game?.status, mode, user]);

  // ===== Локальный режим: таймер хода =====

  // Сброс таймера при смене хода или статуса игры
  useEffect(() => {
    if (mode !== "local") return;
    setTimeLeft(TURN_TIME);
  }, [localState?.currentPlayerIndex, localState?.status, mode]);

  // Тикающий таймер хода (только уменьшение счётчика — без побочных эффектов)
  useEffect(() => {
    if (mode !== "local" || !localState || localState.status !== "playing") return;

    const intervalId = setInterval(() => {
      setTimeLeft(prev => Math.max(0, prev - 1));
    }, 1000);

    return () => clearInterval(intervalId);
  }, [localState?.currentPlayerIndex, localState?.status, mode]);

  // Авто-взятие карты, когда время вышло.
  useEffect(() => {
    if (mode !== "local" || timeLeft !== 0) return;

    const currentGame = gameRef.current;
    if (!currentGame || currentGame.status !== "playing") return;

    const currentPlayer = currentGame.players[currentGame.currentPlayerIndex];
    if (!currentPlayer) return;

    setLocalState(drawCard(currentGame, currentPlayer.id));
  }, [timeLeft, mode]);

  // Локальный режим: ход бота.
  // При срабатывании дополнительно проверяем через ref, что бот всё ещё
  // текущий игрок и игра не закончилась.
  useEffect(() => {
    if (mode !== "local" || !localState || localState.status !== "playing") return;

    const currentPlayer = localState.players[localState.currentPlayerIndex];
    if (!currentPlayer.isBot) return;

    botMoveTimeout.current = setTimeout(() => {
      const currentGame = gameRef.current;
      if (!currentGame || currentGame.status !== "playing") return;

      const activePlayer = currentGame.players[currentGame.currentPlayerIndex];
      if (activePlayer.id !== currentPlayer.id) return;

      setLocalState(makeBotMove(currentGame, currentPlayer.id));
    }, 1500);

    return () => {
      if (botMoveTimeout.current) {
        clearTimeout(botMoveTimeout.current);
        botMoveTimeout.current = null;
      }
    };
  }, [localState?.currentPlayerIndex, localState?.status, mode]);

  if (!game || !user) {
    return (
      <div className="loading">
        {mode === "connecting" ? "Подключение к столу..." : "Загрузка игры..."}
      </div>
    );
  }

  // Своего игрока ищем по нику — работает при любом месте за столом
  // (в локальном режиме игрок всегда первый, так что тоже подходит)
  const myPlayer = game.players.find(p => p.name === user.nickname) ?? game.players[0];
  const currentPlayer = game.players[game.currentPlayerIndex];
  const isMyTurn = currentPlayer.id === myPlayer.id;
  const topCard = game.discardPile[game.discardPile.length - 1];
  const playableCards = getPlayableCards(myPlayer.hand, topCard, game.currentColor);

  // Отсчёт времени: в серверном режиме приходит от сервера,
  // в локальном — собственный таймер компонента
  const shownTimeLeft =
    mode === "server" && game.timeLeft != null ? game.timeLeft : timeLeft;

  // Единая точка отправки действий:
  // серверный режим — через сокет (состояние придёт обратно от сервера),
  // локальный — применение движка прямо здесь
  const submitAction = (serverAction: GameAction, localNext: () => GameState) => {
    if (mode === "server") {
      socketRef.current?.sendAction("uno", serverAction);
      return;
    }
    setLocalState(localNext());
  };

  const handlePlayCard = (cardId: string) => {
    if (!isMyTurn || game.status !== "playing") {
      showToast("error", "Сейчас не твой ход");
      return;
    }

    const card = myPlayer.hand.find(c => c.id === cardId);
    if (!card) return;

    if (!playableCards.some(c => c.id === card.id)) {
      showToast("error", "Эту карту сейчас нельзя сыграть");
      return;
    }

    if (card.color === "wild") {
      setPendingCard(cardId);
      setChoosingColor(true);
      return;
    }

    submitAction(
      { type: "playCard", cardId },
      () => playCard(game, myPlayer.id, cardId)
    );
  };

  const handleChooseColor = (color: CardColor) => {
    if (!pendingCard) return;

    submitAction(
      { type: "playCard", cardId: pendingCard, chosenColor: color },
      () => playCard(game, myPlayer.id, pendingCard, color)
    );

    setChoosingColor(false);
    setPendingCard(null);
  };

  const handleDrawCard = () => {
    if (!isMyTurn || game.status !== "playing") {
      showToast("error", "Сейчас не твой ход");
      return;
    }

    submitAction(
      { type: "drawCard" },
      () => drawCard(game, myPlayer.id)
    );
  };

  const handleSayUno = () => {
    if (myPlayer.hand.length === 1 && !myPlayer.saidUno) {
      submitAction(
        { type: "sayUno" },
        () => sayUno(game, myPlayer.id)
      );
    }
  };

  const handleKick = async (playerNickname: string) => {
    if (!tableId) return;
    const response = await apiKickPlayer(tableId, playerNickname);
    if (!response.ok) {
      showToast("error", response.error || "Не удалось кикнуть игрока");
    }
  };

  // Подпись индикатора соединения
  const connLabel =
    mode === "local"
      ? "Локальный режим"
      : connStatus === "connected"
        ? "Онлайн"
        : connStatus === "connecting"
          ? "Подключение..."
          : connStatus === "disconnected"
            ? "Переподключение..."
            : "Нет связи";
  const connClass = mode === "local" ? "local" : connStatus;

  if (game.status === "finished") {
    return (
      <div className="container">
        <div className="card" style={{ textAlign: "center", maxWidth: "600px", margin: "4rem auto" }}>
          <h2>Игра окончена!</h2>
          <p style={{ fontSize: "1.5rem", marginTop: "1rem" }}>
            Победитель: <strong>{game.winner}</strong>
          </p>
          <button onClick={() => navigate("/lobby")} style={{ marginTop: "2rem" }}>
            Вернуться в лобби
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
        <h2>УНО - {tableId}</h2>
        {/* Выход через подтверждение — красная кнопка */}
        <button className="btn-danger" onClick={() => setShowExitConfirm(true)}>
          Выйти
        </button>
      </div>

      {/* Индикатор соединения с сервером */}
      <div style={{ marginBottom: "1rem" }}>
        <span className={`conn-indicator conn-${connClass}`}>{connLabel}</span>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: "1rem",
        marginBottom: "2rem",
      }}>
        {game.players.map((player, index) => (
          <div
            key={player.id}
            className="card"
            style={{
              padding: "1rem",
              border: index === game.currentPlayerIndex ? "2px solid var(--accent)" : "1px solid var(--bg-tertiary)",
              opacity: index === game.currentPlayerIndex ? 1 : 0.7,
            }}
          >
            <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>
              {player.name} {player.id === myPlayer.id ? "(Вы)" : ""}
            </h3>
            <p>Карт: {player.hand.length}</p>
            {player.hand.length === 1 && player.saidUno && (
              <p style={{ color: "var(--success)", fontWeight: "bold" }}>УНО!</p>
            )}
            {/* Кик доступен только создателю и только живым игрокам */}
            {tableInfo?.isCreator && !player.isBot && player.name !== user.nickname && (
              <button
                onClick={() => handleKick(player.name)}
                style={{ marginTop: "0.5rem", padding: "0.2rem 0.7rem", fontSize: "0.85rem" }}
              >
                Кикнуть
              </button>
            )}
          </div>
        ))}
      </div>

      <div style={{
        display: "flex",
        justifyContent: "center",
        gap: "2rem",
        marginBottom: "2rem",
        padding: "2rem",
        background: "var(--bg-secondary)",
        borderRadius: "8px",
      }}>
        <div>
          <p style={{ textAlign: "center", marginBottom: "0.5rem", color: "var(--text-secondary)" }}>
            Колода ({game.drawPile.length})
          </p>
          <CardComponent card={{ id: "deck", color: "wild", value: "wild" }} faceDown />
        </div>
        <div>
          <p style={{ textAlign: "center", marginBottom: "0.5rem", color: "var(--text-secondary)" }}>
            Стол
          </p>
          <CardComponent card={topCard} />
        </div>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <p style={{ textAlign: "center", color: "var(--text-secondary)" }}>
          {game.lastAction}
        </p>
        <p style={{ textAlign: "center", marginTop: "0.5rem" }}>
          Ход: <strong>{currentPlayer.name}</strong> — {shownTimeLeft} сек
        </p>
      </div>

      <div style={{
        background: "var(--bg-secondary)",
        padding: "2rem",
        borderRadius: "8px",
        marginBottom: "1rem",
      }}>
        <h3 style={{ marginBottom: "1rem", textAlign: "center" }}>Твоя рука ({myPlayer.hand.length} карт)</h3>
        <div style={{
          display: "flex",
          gap: "0.5rem",
          justifyContent: "center",
          flexWrap: "wrap",
        }}>
          {myPlayer.hand.map(card => {
            const canPlay = isMyTurn && playableCards.some(c => c.id === card.id);
            return (
              <CardComponent
                key={card.id}
                card={card}
                onClick={() => handlePlayCard(card.id)}
                disabled={!canPlay}
              />
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", gap: "1rem", justifyContent: "center" }}>
        <button onClick={handleDrawCard} disabled={!isMyTurn}>
          Взять карту
        </button>
        {myPlayer.hand.length === 1 && !myPlayer.saidUno && (
          <button onClick={handleSayUno} style={{ background: "var(--success)" }}>
            Сказать УНО!
          </button>
        )}
      </div>

      {choosingColor && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(0,0,0,0.8)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
        }}>
          <div className="card" style={{ textAlign: "center" }}>
            <h3 style={{ marginBottom: "1rem" }}>Выбери цвет</h3>
            <div style={{ display: "flex", gap: "1rem" }}>
              {(["red", "yellow", "green", "blue"] as CardColor[]).map(color => (
                <button
                  key={color}
                  onClick={() => handleChooseColor(color)}
                  style={{
                    width: "60px",
                    height: "60px",
                    background: color === "red" ? "#e74c3c" :
                                 color === "yellow" ? "#f1c40f" :
                                 color === "green" ? "#27ae60" : "#3498db",
                    border: "2px solid #fff",
                    borderRadius: "8px",
                    cursor: "pointer",
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {showExitConfirm && (
        <ConfirmModal
          title="Выход из игры"
          message="Вы уверены? Прогресс игры будет потерян"
          confirmText="Выйти"
          cancelText="Отмена"
          danger
          onConfirm={() => navigate("/lobby")}
          onCancel={() => setShowExitConfirm(false)}
        />
      )}
    </div>
  );
}

// ===== Диспетчер игровых столов =====
// Владеет ЕДИНСТВЕННЫМ сокетом на всю страницу стола: он не размонтируется
// при показе экрана ожидания, поэтому сервер больше не считает игрока
// вышедшим (раньше это приводило к ложному кику через ~3 секунды).

export function GameTable() {
  const { tableId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthStore();

  // Какая игра за этим столом (определяется при монтировании)
  const [gameType, setGameType] = useState<GameName>("uno");
  // Информация о столе из опроса my-table (ожидание, права создателя)
  const [tableInfo, setTableInfo] = useState<MyTableInfo | null>(null);

  // Соединение и состояния обеих игр живут ЗДЕСЬ, а не в игровых компонентах
  const socketRef = useRef<GameSocket | null>(null);
  const [connStatus, setConnStatus] = useState<ConnectionState>("connecting");
  const [connFailed, setConnFailed] = useState(false);
  const [unoServerState, setUnoServerState] = useState<GameState | null>(null);
  const [durakServerState, setDurakServerState] = useState<DurakGameState | null>(null);

  // Ref для чтения актуального типа игры внутри колбэков сокета
  const gameTypeRef = useRef<GameName>("uno");

  // "Предохранитель" кика: считаем киком отсутствие нас за столом
  // только если раньше мы там себя видели
  const wasInTableRef = useRef(false);

  useEffect(() => {
    gameTypeRef.current = gameType;
  }, [gameType]);

  // 1) Мгновенное определение игры из navigation state,
  //    который передаёт лобби при переходе на стол
  useEffect(() => {
    const navState = location.state as { game?: unknown } | null;
    if (navState && (navState.game === "uno" || navState.game === "durak")) {
      setGameType(navState.game);
    }
  }, [location.state]);

  // 2) Уточнение типа игры через список столов
  //    (например, после F5, когда navigation state пуст)
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const response = await apiLobby();
      if (cancelled || !response.ok || !Array.isArray(response.tables)) return;

      const table = response.tables.find(t => t.id === tableId);
      if (table && (table.game === "uno" || table.game === "durak")) {
        setGameType(table.game);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tableId]);

  // Подключение к игровому серверу при монтировании страницы стола.
  // Соединение живёт независимо от того, какой подэкран показан
  // (ожидание или игра), — это и есть фикс ложного кика
  useEffect(() => {
    if (!user || !tableId) return;

    const socket = new GameSocket();
    socketRef.current = socket;

    socket.onStatusChange(status => setConnStatus(status));

    // Раскладываем состояния по играм
    socket.onStateUpdate((gameName, state) => {
      if (gameName === "durak") {
        setDurakServerState(state as DurakGameState);
      } else {
        setUnoServerState(state as GameState);
      }
    });

    socket.onError(message => showToast("error", message));

    // Связь потеряна окончательно: УНО уйдёт в локальный режим,
    // для Дурака покажем экран ошибки
    socket.onConnectionFailed(() => {
      setConnFailed(true);

      if (gameTypeRef.current === "durak") {
        showToast("error", "Мультиплеер для этой игры требует подключения к серверу");
      } else {
        showToast(
          "info",
          "Мультиплеер недоступен — включён локальный режим с ботами"
        );
      }
    });

    socket.connect(tableId);

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [user, tableId]);

  // 3) Опрос my-table раз в 3 секунды:
  //    обнаружение кика/удаления стола, экран ожидания, права создателя,
  //    уточнение типа игры.
  //    Ошибки сети игнорируем — они не повод выкидывать игрока
  useEffect(() => {
    if (!user) return;

    let cancelled = false;

    const poll = async () => {
      const response = await apiMyTable();

      if (cancelled || !response.ok) return;

      if (response.table === null) {
        // Нас больше нет за столом (кик или стол удалён).
        // Срабатывает только если мы уже успели увидеть себя за столом
        if (wasInTableRef.current) {
          wasInTableRef.current = false;
          showToast("info", "Вас кикнули из стола");
          navigate("/lobby");
        }
        return;
      }

      wasInTableRef.current = true;
      setTableInfo(response.table);

      if (response.table.game === "uno" || response.table.game === "durak") {
        setGameType(response.table.game);
      }
    };

    void poll();
    const intervalId = setInterval(poll, MY_TABLE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [user, navigate]);

  if (!user) {
    return <div className="loading">Загрузка...</div>;
  }

  // Действия создателя в режиме "только игроки" (общие для обеих игр)

  const handleStartGame = async () => {
    if (!tableId) return;
    const response = await apiStartGame(tableId);
    if (!response.ok) {
      showToast("error", response.error || "Не удалось начать игру");
    }
    // При успехе состояние партии придёт по WebSocket —
    // интерфейс переключится на игру автоматически
  };

  const handleDeleteTable = async () => {
    if (!tableId) return;
    const response = await apiDeleteTable(tableId);
    if (response.ok) {
      showToast("success", "Стол удалён");
      navigate("/lobby");
    } else {
      showToast("error", response.error || "Не удалось удалить стол");
    }
  };

  const handleKick = async (playerNickname: string) => {
    if (!tableId) return;
    const response = await apiKickPlayer(tableId, playerNickname);
    if (!response.ok) {
      showToast("error", response.error || "Не удалось кикнуть игрока");
    }
  };

  // Общий экран ожидания для режима "только игроки" (обе игры):
  // партии ещё нет, показываем список подключившихся и управление создателя.
  // ВАЖНО: сокет при этом остаётся подключённым — игрок числится за столом
  if (tableInfo && tableInfo.mode === "players" && tableInfo.status === "waiting") {
    // Создатель — всегда первый в списке (права передаются
    // первому оставшемуся при выходе предыдущего создателя)
    const creatorNickname = tableInfo.players[0];
    const canStart = tableInfo.players.length >= Math.max(2, tableInfo.minPlayers);

    return (
      <div className="container">
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
          <h2>{tableInfo.name}</h2>
          {/* Из фазы ожидания выход безопасен — подтверждение не нужно */}
          <button className="btn-danger" onClick={() => navigate("/lobby")}>
            Выйти
          </button>
        </div>

        <div className="card" style={{ maxWidth: "600px", margin: "2rem auto" }}>
          <h3>Игроки за столом ({tableInfo.players.length}/{MAX_SEATS})</h3>
          <ul style={{ marginTop: "1rem", paddingLeft: "1.25rem", listStyle: "none" }}>
            {tableInfo.players.map(nickname => (
              <li
                key={nickname}
                style={{
                  marginBottom: "0.5rem",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.75rem",
                }}
              >
                <span>
                  {nickname}
                  {nickname === user.nickname ? " (вы)" : ""}
                  {nickname === creatorNickname ? " — создатель" : ""}
                </span>
                {tableInfo.isCreator && nickname !== user.nickname && (
                  <button
                    onClick={() => handleKick(nickname)}
                    style={{ padding: "0.2rem 0.7rem", fontSize: "0.85rem" }}
                  >
                    Кикнуть
                  </button>
                )}
              </li>
            ))}
          </ul>

          <p style={{ marginTop: "1rem", color: "var(--text-secondary)" }}>
            Минимум для старта: {Math.max(2, tableInfo.minPlayers)} игрока
          </p>

          {tableInfo.isCreator ? (
            <div style={{ display: "flex", gap: "1rem", marginTop: "1.5rem" }}>
              <button onClick={handleStartGame} disabled={!canStart}>
                Начать игру
              </button>
              <button className="btn-danger" onClick={handleDeleteTable}>
                Удалить стол
              </button>
            </div>
          ) : (
            <p style={{ marginTop: "1.5rem", color: "var(--accent)" }}>
              Ожидание начала игры...
            </p>
          )}
        </div>
      </div>
    );
  }

  // Маршрутизация на конкретную игру

  // Дурак без сервера и без состояния — игра невозможна
  if (gameType === "durak") {
    if (connFailed && !durakServerState) {
      return (
        <div className="container">
          <div className="card" style={{ textAlign: "center", maxWidth: "600px", margin: "4rem auto" }}>
            <h2>Нет подключения</h2>
            <p style={{ marginTop: "1rem", color: "var(--text-secondary)" }}>
              Мультиплеер для этой игры требует подключения к серверу
            </p>
            <button onClick={() => navigate("/lobby")} style={{ marginTop: "2rem" }}>
              Вернуться в лобби
            </button>
          </div>
        </div>
      );
    }

    return (
      <DurakGame
        tableInfo={tableInfo}
        connStatus={connStatus}
        socketRef={socketRef}
        serverState={durakServerState}
      />
    );
  }

  return (
    <UnoGame
      tableInfo={tableInfo}
      connStatus={connStatus}
      socketRef={socketRef}
      serverState={unoServerState}
      connFailed={connFailed}
    />
  );
}
