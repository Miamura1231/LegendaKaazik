import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiLobby, apiCreateLobbyTable, apiJoinTable } from "../api/client";
import { useAuthStore } from "../store/authStore";
import { showToast } from "../components/Toast";
import type { LobbyTable, LobbyTableMode, LobbyGame } from "../api/types";
import type { BotDifficulty } from "../games/uno/types";

// Человекочитаемые названия сложностей
const DIFFICULTY_LABELS: Record<BotDifficulty, string> = {
  easy: "Лёгкая",
  medium: "Средняя",
  hard: "Сложная",
};

// Человекочитаемые названия режимов стола
const MODE_LABELS: Record<LobbyTableMode, string> = {
  bots: "Боты",
  players: "Игроки",
};

// Человекочитаемые названия игр
const GAME_LABELS: Record<LobbyGame, string> = {
  uno: "УНО",
  durak: "Дурак",
};

// Период тихого опроса списка столов, чтобы видеть,
// сколько игроков сейчас за каждым столом
const LOBBY_POLL_INTERVAL_MS = 5000;

// Форматирование остатка времени до автоудаления стола
function formatAutoDelete(autoDeleteAt: number, nowTs: number): string {
  const secondsLeft = Math.ceil((autoDeleteAt - nowTs) / 1000);
  return secondsLeft > 0 ? `через ${secondsLeft} сек` : "удаляется...";
}

export function Lobby() {
  const [tables, setTables] = useState<LobbyTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMinAmount, setNewMinAmount] = useState(10);
  const [newDifficulty, setNewDifficulty] = useState<BotDifficulty>("medium");
  const [newMode, setNewMode] = useState<LobbyTableMode>("bots");
  const [newGame, setNewGame] = useState<LobbyGame>("uno");
  const [newPassword, setNewPassword] = useState("");
  const [creating, setCreating] = useState(false);
  // Стол, для которого вводится пароль перед входом
  const [pendingTable, setPendingTable] = useState<LobbyTable | null>(null);
  const [joinPassword, setJoinPassword] = useState("");
  // Текущее время для обратного отсчёта автоудаления
  const [nowTs, setNowTs] = useState(() => Date.now());
  const { user } = useAuthStore();
  const navigate = useNavigate();

  // Есть ли хотя бы один стол с запущенным отсчётом автоудаления.
  // Интервал секунды нужен только в этом случае
  const hasCountdown = tables.some(t => t.autoDeleteAt != null);

  // Тихая загрузка списка столов (без переключения спиннера).
  // Используется при первом рендере, после создания стола и в опросе.
  const fetchTables = async () => {
    const response = await apiLobby();

    if (response.ok && Array.isArray(response.tables)) {
      setTables(response.tables);
      setError(null);
    } else {
      setError(response.error || "Не удалось загрузить список столов");
    }
  };

  useEffect(() => {
    loadLobby();

    // Живое обновление количества игроков на столах
    const pollId = setInterval(fetchTables, LOBBY_POLL_INTERVAL_MS);

    return () => clearInterval(pollId);
  }, []);

  // Обратный отсчёт автоудаления: тик раз в секунду,
  // только пока есть столы с отсчётом
  useEffect(() => {
    if (!hasCountdown) return;

    const tickId = setInterval(() => setNowTs(Date.now()), 1000);

    return () => clearInterval(tickId);
  }, [hasCountdown]);

  const loadLobby = async () => {
    setLoading(true);
    try {
      await fetchTables();
    } finally {
      // Спиннер убираем при любом исходе — раньше при сетевой ошибке
      // загрузка зависала навсегда
      setLoading(false);
    }
  };

  // Вход за стол: сначала серверная проверка (пароль/статус),
  // затем переход на страницу стола.
  // Тип игры передаём через navigation state — диспетчер GameTable
  // определит игру мгновенно, не дожидаясь ответов API
  const performJoin = async (table: LobbyTable, password?: string) => {
    const response = await apiJoinTable(table.id, password);

    if (response.ok) {
      setPendingTable(null);
      setJoinPassword("");
      navigate(`/game/${table.id}`, { state: { game: table.game ?? "uno" } });
    } else {
      showToast("error", response.error || "Не удалось войти за стол");
    }
  };

  const handleJoinTable = (table: LobbyTable) => {
    if (!user) return;

    if (user.balance < table.minAmount) {
      showToast("error", `Недостаточно средств. Минимум: ${table.minAmount}$`);
      return;
    }

    // Стол с паролем — сначала спрашиваем пароль в модальном окне
    if (table.hasPassword) {
      setPendingTable(table);
      setJoinPassword("");
      return;
    }

    void performJoin(table);
  };

  const handleCreateTable = async () => {
    if (!newName.trim()) {
      showToast("error", "Введите название стола");
      return;
    }

    if (Number(newMinAmount) < 10) {
      showToast("error", "Минимальная сумма должна быть не меньше 10");
      return;
    }

    setCreating(true);
    try {
      const response = await apiCreateLobbyTable(
        newName.trim(),
        Number(newMinAmount),
        // Сложность нужна только для режима с ботами
        newMode === "bots" ? newDifficulty : undefined,
        newMode,
        // Пароль передаём только для режима "players"
        newMode === "players" ? (newPassword.trim() || undefined) : undefined,
        newGame
      );

      if (response.ok && response.table) {
        // Хост режима "только игроки" сразу попадает в комнату ожидания,
        // где видит список игроков и кнопки "Начать игру"/"Удалить стол"
        if ((response.table.mode ?? "bots") === "players") {
          navigate(`/game/${response.table.id}`, {
            state: { game: response.table.game ?? "uno" },
          });
          return;
        }

        // Обновляем список с сервера, чтобы он гарантированно
        // совпадал с состоянием бэкенда
        await fetchTables();
        setShowCreateForm(false);
        setNewName("");
        setNewMinAmount(10);
        setNewDifficulty("medium");
        setNewMode("bots");
        setNewGame("uno");
        setNewPassword("");
        showToast("success", `Стол «${response.table.name}» создан`);
      } else {
        showToast("error", response.error || "Не удалось создать стол");
      }
    } finally {
      // Разблокируем кнопку при любом исходе — раньше при сетевой
      // ошибке creating навсегда оставался true
      setCreating(false);
    }
  };

  if (loading) return <div className="loading">Загрузка лобби...</div>;

  return (
    <div className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
        <h2 style={{ margin: 0 }}>Лобби</h2>
        <button onClick={() => setShowCreateForm(prev => !prev)}>
          {showCreateForm ? "Отмена" : "Создать стол"}
        </button>
      </div>

      {error && (
        <div className="error" style={{ marginBottom: "1rem" }}>
          {error}{" "}
          <button
            onClick={loadLobby}
            style={{ marginLeft: "0.5rem", padding: "0.25rem 0.75rem" }}
          >
            Повторить
          </button>
        </div>
      )}

      {showCreateForm && (
        <div className="card" style={{ padding: "1.5rem", marginBottom: "2rem" }}>
          <h3 style={{ marginBottom: "1rem" }}>Новый стол</h3>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "center" }}>
            <label>
              Название:
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="УНО #3"
                style={{ marginLeft: "0.5rem" }}
              />
            </label>
            {/* Выбор игры: УНО или Дурак */}
            <label>
              Игра:
              <select
                value={newGame}
                onChange={e => setNewGame(e.target.value as LobbyGame)}
                style={{ marginLeft: "0.5rem" }}
              >
                <option value="uno">УНО</option>
                <option value="durak">Дурак</option>
              </select>
            </label>
            <label>
              Мин. сумма:
              <input
                type="number"
                value={newMinAmount}
                min={10}
                onChange={e => setNewMinAmount(Number(e.target.value))}
                style={{ marginLeft: "0.5rem" }}
              />
            </label>
            {/* Переключатель режима: "С ботами" / "Только игроки".
                По умолчанию — "С ботами" */}
            <label>
              Режим:
              <select
                value={newMode}
                onChange={e => setNewMode(e.target.value as LobbyTableMode)}
                style={{ marginLeft: "0.5rem" }}
              >
                <option value="bots">С ботами</option>
                <option value="players">Только игроки</option>
              </select>
            </label>
            {/* Сложность ботов имеет смысл только в режиме "bots" */}
            {newMode === "bots" && (
              <label>
                Сложность ботов:
                <select
                  value={newDifficulty}
                  onChange={e => setNewDifficulty(e.target.value as BotDifficulty)}
                  style={{ marginLeft: "0.5rem" }}
                >
                  <option value="easy">Лёгкая</option>
                  <option value="medium">Средняя</option>
                  <option value="hard">Сложная</option>
                </select>
              </label>
            )}
            {newMode === "players" && (
              <label>
                Пароль:
                <input
                  type="text"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="необязательно"
                  style={{ marginLeft: "0.5rem" }}
                />
              </label>
            )}
            <button onClick={handleCreateTable} disabled={creating}>
              {creating ? "Создание..." : "Создать"}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
        {tables.map(table => {
          // В начатую партию режима "players" вход запрещён
          const joinLocked =
            (table.mode ?? "bots") === "players" && table.status === "playing";

          return (
            <div key={table.id} className="card">
              <h3>
                {table.name}
                {/* Замок — у стола есть пароль */}
                {table.hasPassword ? " 🔒" : ""}
              </h3>
              {/* Тип игры показываем, только если это не УНО */}
              {(table.game ?? "uno") !== "uno" && (
                <p><strong>Игра:</strong> {GAME_LABELS[(table.game ?? "uno") as LobbyGame] ?? table.game}</p>
              )}
              <p><strong>Режим:</strong> {MODE_LABELS[table.mode ?? "bots"]}</p>
              <p><strong>Создатель:</strong> {table.creatorNickname || "система"}</p>
              <p><strong>Игроки:</strong> {table.players}/{table.maxPlayers}</p>
              <p><strong>Мин. сумма:</strong> {table.minAmount}$</p>
              {/* Fallback на medium для столов, созданных до появления сложности */}
              {(table.mode ?? "bots") === "bots" && (table.game ?? "uno") === "uno" && (
                <p><strong>Сложность:</strong> {DIFFICULTY_LABELS[table.difficulty ?? "medium"]}</p>
              )}
              <p><strong>Статус:</strong> {table.status === "waiting" ? "Ожидание" : table.status === "playing" ? "Идёт игра" : table.status}</p>
              {/* Обратный отсчёт автоудаления пустого стола */}
              {table.autoDeleteAt != null && (
                <p style={{ color: "var(--error)" }}>
                  <strong>Автоудаление:</strong> {formatAutoDelete(table.autoDeleteAt, nowTs)}
                </p>
              )}
              <button
                onClick={() => handleJoinTable(table)}
                disabled={joinLocked}
                style={{ width: "100%", marginTop: "1rem" }}
              >
                {joinLocked ? "Игра уже идёт" : "Присоединиться"}
              </button>
            </div>
          );
        })}
      </div>

      {/* Модальное окно ввода пароля для защищённых столов */}
      {pendingTable && (
        <div className="modal-overlay" onClick={() => setPendingTable(null)}>
          <div className="modal card" onClick={e => e.stopPropagation()}>
            <h3>Стол «{pendingTable.name}»</h3>
            <p style={{ marginTop: "0.75rem", color: "var(--text-secondary)" }}>
              Этот стол защищён паролем
            </p>
            <input
              type="text"
              value={joinPassword}
              onChange={e => setJoinPassword(e.target.value)}
              placeholder="Пароль"
              autoFocus
              style={{ marginTop: "1rem" }}
            />
            <div className="modal-actions">
              <button onClick={() => setPendingTable(null)}>Отмена</button>
              <button onClick={() => performJoin(pendingTable, joinPassword)}>
                Войти
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
