import type {
  LoginResponse,
  MeResponse,
  LobbyResponse,
  LobbyTable,
  LobbyTableMode,
  LobbyGame,
  MyTableResponse,
  GameResultResponse,
  HistoryResponse,
  SlotsSpinResponse,
} from "./types";
import type { BotDifficulty } from "../games/uno/types";

// Адрес REST API определяется по тому, как открыт сайт:
//  * напрямую с сервера (порт 3001 или без порта, например Cloudflare
//    Tunnel) — API ходит на тот же origin, где открыт сайт;
//  * иначе (локальная разработка через Vite на порту 5173) —
//    на порт 3001 того же хоста (работает и для localhost,
//    и для доступа по локальной сети вида 192.168.x.x:5173).
function resolveApiUrl(): string {
  const { protocol, hostname, port } = window.location;

  if (port === "3001" || port === "") {
    return window.location.origin;
  }

  return `${protocol}//${hostname}:3001`;
}

const API_URL = resolveApiUrl();

// Экспортируется: используется в authStore.checkSession
export function getToken(): string | null {
  return localStorage.getItem("token");
}

export function setToken(token: string) {
  localStorage.setItem("token", token);
}

export function clearToken() {
  localStorage.removeItem("token");
}

// Заголовки авторизации, если токен есть.
function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Единая обёртка над fetch.
// Гарантирует, что вместо необработанного исключения всегда вернётся
// объект вида { ok: false, error: "..." }.
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(url, init);

    try {
      return (await response.json()) as T;
    } catch {
      // Сервер ответил не JSON (пустое тело, HTML-страница ошибки и т.п.)
      return {
        ok: false,
        error: `Некорректный ответ сервера (HTTP ${response.status})`,
      } as T;
    }
  } catch {
    // Сервер недоступен / проблемы с сетью
    return {
      ok: false,
      error: "Сервер недоступен. Проверь, что запущен mock-server (порт 3001)",
    } as T;
  }
}

// Заготовка init-объекта для JSON-запросов.
function jsonInit(
  method: string,
  body: unknown,
  headers?: Record<string, string>
): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

export async function apiLogin(nickname: string, password: string): Promise<LoginResponse> {
  return request(`${API_URL}/api/auth/login`, jsonInit("POST", { nickname, password }));
}

export async function apiMe(): Promise<MeResponse> {
  return request(`${API_URL}/api/me`, { headers: authHeaders() });
}

export async function apiLogout(): Promise<void> {
  await request(`${API_URL}/api/auth/logout`, {
    method: "POST",
    headers: authHeaders(),
  });

  clearToken();
}

// Выход со ВСЕХ устройств: сервер удаляет все сессии игрока,
// включая текущую. Локальный токен очищается как обычно.
// Кнопка «Выйти со всех устройств» подключается на странице профиля
export async function apiLogoutAll(): Promise<void> {
  await request(`${API_URL}/api/auth/logout-all`, {
    method: "POST",
    headers: authHeaders(),
  });

  clearToken();
}

export async function apiLobby(): Promise<LobbyResponse> {
  // Список столов требует сессию: с этапа 1 все /api-эндпоинты
  // закрыты токеном, кроме логина и платёжного эндпоинта Minecraft
  return request(`${API_URL}/api/lobby`, { headers: authHeaders() });
}

// difficulty опционален: в режиме "только игроки" сложность ботов
// не нужна и на сервер не отправляется
export async function apiCreateLobbyTable(
  name: string,
  minAmount: number,
  difficulty?: BotDifficulty,
  mode: LobbyTableMode = "bots",
  password?: string,
  game: LobbyGame = "uno"
): Promise<{ ok: boolean; table?: LobbyTable; error?: string }> {
  // Собираем тело вручную, чтобы не отправлять поля со значением undefined
  const body: Record<string, unknown> = { name, minAmount, mode, game };

  if (difficulty) {
    body.difficulty = difficulty;
  }

  if (password) {
    body.password = password;
  }

  return request(`${API_URL}/api/lobby/create`, jsonInit("POST", body, authHeaders()));
}

// Проверка входа за стол (пароль, статус "игра идёт", вместимость).
// Сама посадка происходит через WebSocket на странице игры
export async function apiJoinTable(
  tableId: string,
  password?: string
): Promise<{ ok: boolean; error?: string }> {
  return request(
    `${API_URL}/api/lobby/join`,
    jsonInit("POST", { tableId, password }, authHeaders())
  );
}

// Создатель запускает партию в режиме "только игроки"
export async function apiStartGame(
  tableId: string
): Promise<{ ok: boolean; error?: string }> {
  return request(
    `${API_URL}/api/lobby/start`,
    jsonInit("POST", { tableId }, authHeaders())
  );
}

// Удаление стола создателем (до начала игры)
export async function apiDeleteTable(
  tableId: string
): Promise<{ ok: boolean; error?: string }> {
  return request(
    `${API_URL}/api/lobby/delete`,
    jsonInit("POST", { tableId }, authHeaders())
  );
}

// Кик игрока со стола (только создатель)
export async function apiKickPlayer(
  tableId: string,
  playerNickname: string
): Promise<{ ok: boolean; error?: string }> {
  return request(
    `${API_URL}/api/lobby/kick`,
    jsonInit("POST", { tableId, playerNickname }, authHeaders())
  );
}

// Информация о столе, где сейчас находится пользователь.
// table === null означает, что пользователь нигде не сидит
// (используется для обнаружения кика и экрана ожидания)
export async function apiMyTable(): Promise<MyTableResponse> {
  return request(`${API_URL}/api/lobby/my-table`, { headers: authHeaders() });
}

// Прокрутка слотов. Баланс и результат считает сервер
export async function apiSlotsSpin(bet: number): Promise<SlotsSpinResponse> {
  return request(`${API_URL}/api/slots/spin`, jsonInit("POST", { bet }, authHeaders()));
}

// Отправка результата завершённой игры.
// Ник игрока сервер определяет сам по токену сессии.
export async function apiGameResult(
  winner: string,
  players: string[],
  durationSec: number
): Promise<GameResultResponse> {
  return request(
    `${API_URL}/api/game/result`,
    jsonInit("POST", { winner, players, durationSec }, authHeaders())
  );
}

export async function apiHistory(): Promise<HistoryResponse> {
  return request(`${API_URL}/api/history`, { headers: authHeaders() });
}

// ===== Админка (этап 5) =====
//
// Типы описаны здесь, а не в ./types, чтобы не трогать файл,
// которого нет в этом чате. При желании их можно перенести туда.

// Игрок в списке админки: балансы, роль и обе статистики
export interface AdminPlayerInfo {
  nickname: string;
  balance: number;
  role: string;
  createdAt: string;
  lastPaymentAt: string | null;
  stats: { wins: number; losses: number; gamesPlayed: number };
  slotsStats: { spins: number; betTotal: number; winTotal: number };
}

// Стол в списке админки: публичные поля + живой состав.
// Поля игры/сложности оставлены строками: сервер отдаёт их как есть
export interface AdminTableInfo {
  id: string;
  game: string;
  name: string;
  players: number;
  maxPlayers: number;
  minPlayers: number;
  minAmount: number;
  difficulty: string;
  status: string;
  mode: string;
  creatorNickname: string;
  hasPassword: boolean;
  autoDeleteAt: number | null;
  // Кто реально сидит за столом прямо сейчас
  humans: string[];
  // Есть ли живая комната (партия или ожидание режима "players")
  hasRoom: boolean;
}

// Запись журнала действий админов
export interface AdminLogEntry {
  id: number;
  admin: string;
  action: string;
  details: string | null;
  date: string;
}

// Список всех игроков с балансами и статистикой
export async function apiAdminPlayers(): Promise<{
  ok: boolean;
  players?: AdminPlayerInfo[];
  error?: string;
}> {
  return request(`${API_URL}/api/admin/players`, { headers: authHeaders() });
}

// Ручное начисление (delta > 0) или списание (delta < 0) валюты.
// Списание сверх баланса сервер отклонит
export async function apiAdminAdjustBalance(
  nickname: string,
  delta: number
): Promise<{
  ok: boolean;
  player?: { nickname: string; balance: number };
  error?: string;
}> {
  return request(
    `${API_URL}/api/admin/balance`,
    jsonInit("POST", { nickname, delta }, authHeaders())
  );
}

// Активные столы с составом участников
export async function apiAdminTables(): Promise<{
  ok: boolean;
  tables?: AdminTableInfo[];
  error?: string;
}> {
  return request(`${API_URL}/api/admin/tables`, { headers: authHeaders() });
}

// Принудительное удаление стола (в т.ч. зависшего во время игры)
export async function apiAdminDeleteTable(
  tableId: string
): Promise<{ ok: boolean; error?: string }> {
  return request(
    `${API_URL}/api/admin/tables/delete`,
    jsonInit("POST", { tableId }, authHeaders())
  );
}

// Сброс всей статистики игрока (баланс не трогается)
export async function apiAdminResetStats(
  nickname: string
): Promise<{ ok: boolean; error?: string }> {
  return request(
    `${API_URL}/api/admin/reset-stats`,
    jsonInit("POST", { nickname }, authHeaders())
  );
}

// Журнал действий админов. limit опционален (сервер по умолчанию 50)
export async function apiAdminLog(limit?: number): Promise<{
  ok: boolean;
  log?: AdminLogEntry[];
  error?: string;
}> {
  const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";

  return request(`${API_URL}/api/admin/log${query}`, { headers: authHeaders() });
}
