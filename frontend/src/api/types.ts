import type { BotDifficulty } from "../games/uno/types";

// Режим стола: с ботами или только живые игроки
export type LobbyTableMode = "bots" | "players";

// Игра за столом (мультигейм)
export type LobbyGame = "uno" | "durak";

export type LoginRequest = {
  nickname: string;
  password: string;
};

export type UserStats = {
  wins: number;
  losses: number;
  gamesPlayed: number;
};

export type User = {
  nickname: string;
  balance: number;
  createdAt: string;
  lastPaymentAt: string | null;
  stats?: UserStats;
};

export type LoginResponse = {
  ok: boolean;
  token?: string;
  user?: User;
  error?: string;
};

export type MeResponse = {
  ok: boolean;
  user?: User;
  error?: string;
};

export type LobbyTable = {
  id: string;
  game: string;
  name: string;
  players: number;
  maxPlayers: number;
  minPlayers: number;
  minAmount: number;
  difficulty: BotDifficulty;
  status: "waiting" | "playing" | "finished";
  // Новые поля опциональны — старые ответы сервера без них
  // не должны ломать типизацию (обратная совместимость)
  mode?: LobbyTableMode;
  creatorNickname?: string;
  hasPassword?: boolean;
  /**
   * Момент автоудаления пустого стола (мс, Date.now()-база).
   * null/undefined — отсчёт не идёт (за столом игроки или стол
   * ещё ни разу не использовался)
   */
  autoDeleteAt?: number | null;
};

export type LobbyResponse = {
  ok: boolean;
  tables: LobbyTable[];
  // Ошибка загрузки лобби (например, сервер недоступен)
  error?: string;
};

export type GameResultResponse = {
  ok: boolean;
  stats?: UserStats;
  error?: string;
};

export type HistoryEntry = {
  id: string;
  winner: string;
  players: string[];
  date: string;
  durationSec: number;
};

export type HistoryResponse = {
  ok: boolean;
  history?: HistoryEntry[];
  error?: string;
};

// Информация о столе, где сейчас находится пользователь.
// Приходит из GET /api/lobby/my-table (опрос раз в 3 секунды)
export type MyTableInfo = {
  id: string;
  name: string;
  game: LobbyGame;
  mode: LobbyTableMode;
  status: "waiting" | "playing";
  isCreator: boolean;
  players: string[];
  minPlayers: number;
};

export type MyTableResponse = {
  ok: boolean;
  table: MyTableInfo | null;
  error?: string;
};

// Ответ прокрутки слотов
export type SlotsSpinResponse = {
  ok: boolean;
  reels?: string[];
  winAmount?: number;
  newBalance?: number;
  error?: string;
};
