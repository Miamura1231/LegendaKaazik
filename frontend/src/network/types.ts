import type { GameState as UnoGameState, GameAction as UnoGameAction } from "../games/uno/types";
import type { DurakGameState, DurakAction } from "../games/durak/types";

// Игры, поддерживаемые мультиплеером
export type GameName = "uno" | "durak";

/** Сообщения, которые клиент отправляет серверу. */
export type ClientMessage =
  | { type: "join"; tableId: string }
  | { type: "leave" }
  // Игра указывается явно: сервер дополнительно сверяет её с комнатой
  | { type: "action"; game: GameName; action: UnoGameAction | DurakAction };

/** Сообщения, которые сервер отправляет клиенту. */
export type ServerMessage =
  // Поле game позволяет клиенту выбрать правильную игровую компоненту
  | { type: "state"; game: GameName; state: UnoGameState | DurakGameState }
  | { type: "error"; message: string }
  | { type: "playerJoined"; playerId: string; playerName: string }
  | { type: "playerLeft"; playerId: string };

/**
 * Состояние соединения с сервером.
 * "failed" — соединиться не удалось вовсе (таймаут первого подключения
 * или исчерпаны попытки переподключения). По этому сигналу УНО
 * переключается в локальный режим, Дурак показывает ошибку.
 */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed";
