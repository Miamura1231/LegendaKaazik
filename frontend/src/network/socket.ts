// Клиент игрового WebSocket-соединения.
// Сервер: ws://<host>:3001/ws?token=<сессионный токен>.
// После открытия соединения отправляется join с tableId,
// далее клиент только шлёт действия и получает состояния от сервера.
// Поддерживает несколько игр: состояние приходит с полем game,
// действия отправляются с указанием игры.

import type { ClientMessage, ServerMessage, ConnectionState, GameName } from "./types";
import type { GameState as UnoGameState, GameAction as UnoGameAction } from "../games/uno/types";
import type { DurakGameState, DurakAction } from "../games/durak/types";
import { getToken } from "../api/client";

// Пауза между попытками переподключения
const RECONNECT_DELAY_MS = 3000;
// Максимум попыток переподключения после разрыва установленного соединения
const MAX_RECONNECT_ATTEMPTS = 5;
// Если первое подключение не открылось за это время — считаем сервер
// недоступным и сообщаем игре о необходимости fallback
const CONNECT_TIMEOUT_MS = 5000;

export class GameSocket {
  private ws: WebSocket | null = null;
  private tableId: string | null = null;

  private stateCallback:
    ((game: GameName, state: UnoGameState | DurakGameState) => void) | null = null;
  private errorCallback: ((message: string) => void) | null = null;
  private statusCallback: ((status: ConnectionState) => void) | null = null;
  private failureCallback: (() => void) | null = null;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  // Флаг ручного закрытия (disconnect) — в этом случае не переподключаемся
  private manuallyClosed = false;
  // Было ли хотя бы одно успешное соединение за жизнь экземпляра
  private everConnected = false;
  // Пришла ли ошибка от сервера до получения первого состояния
  // (например, "Нет сессии") — такие ошибки не имеет смысла ретраить
  private gotFatalError = false;
  // Защита от двойного вызова failureCallback
  private failed = false;

  connect(tableId: string): void {
    this.tableId = tableId;
    this.manuallyClosed = false;
    this.failed = false;
    this.gotFatalError = false;
    this.reconnectAttempts = 0;
    this.everConnected = false;
    this.openSocket();
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.clearTimers();

    if (this.ws) {
      // Убираем обработчики, чтобы close не запустил переподключение
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }

    this.setStatus("disconnected");
  }

  // Действие всегда сопровождается именем игры.
  // Тип действия — union действий обеих игр (раньше был unknown,
  // что ломало типизацию ClientMessage)
  sendAction(game: GameName, action: UnoGameAction | DurakAction): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message: ClientMessage = { type: "action", game, action };
      this.ws.send(JSON.stringify(message));
    }
  }

  onStateUpdate(
    callback: (game: GameName, state: UnoGameState | DurakGameState) => void
  ): void {
    this.stateCallback = callback;
  }

  onError(callback: (message: string) => void): void {
    this.errorCallback = callback;
  }

  // Изменения статуса соединения — для индикатора в интерфейсе
  onStatusChange(callback: (status: ConnectionState) => void): void {
    this.statusCallback = callback;
  }

  // Соединиться не удалось окончательно — игра решает, что делать
  // (УНО уходит в локальный режим, Дурак показывает ошибку)
  onConnectionFailed(callback: () => void): void {
    this.failureCallback = callback;
  }

  // ===== Внутренние методы =====

  private openSocket(): void {
    this.clearTimers();
    this.setStatus("connecting");

    const token = getToken();

    // Адрес сокета зависит от того, как открыт сайт:
    //  * напрямую с сервера (порт 3001 или без порта, например
    //    Cloudflare Tunnel) — тот же хост и протокол страницы,
    //    https автоматически превращается в wss;
    //  * иначе (локальная разработка через Vite на порту 5173) —
    //    порт 3001 того же хоста (работает и для localhost,
    //    и для доступа по локальной сети вида 192.168.x.x:5173).
    const { protocol, hostname, port } = window.location;
    let wsBaseUrl: string;

    if (port === "3001" || port === "") {
      const wsProtocol = protocol === "https:" ? "wss" : "ws";
      wsBaseUrl = `${wsProtocol}://${window.location.host}/ws`;
    } else {
      wsBaseUrl = `ws://${hostname || "localhost"}:3001/ws`;
    }

    const tokenPart = token ? `?token=${encodeURIComponent(token)}` : "";
    const url = `${wsBaseUrl}${tokenPart}`;

    let opened = false;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.handleFailure();
      return;
    }

    // Таймаут первого подключения: если за 5 секунд не открылись — fallback.
    // После первого успеха (everConnected) этот таймаут не используется:
    // дальнейшие разрывы обрабатываются политикой переподключения.
    if (!this.everConnected) {
      this.connectTimer = setTimeout(() => {
        if (!opened) {
          this.ws?.close();
          this.handleFailure();
        }
      }, CONNECT_TIMEOUT_MS);
    }

    this.ws.onopen = () => {
      opened = true;
      this.everConnected = true;
      this.reconnectAttempts = 0;
      this.setStatus("connected");

      if (this.tableId) {
        const join: ClientMessage = { type: "join", tableId: this.tableId };
        this.ws?.send(JSON.stringify(join));
      }
    };

    this.ws.onmessage = event => {
      let data: unknown;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        // Некорректный JSON — игнорируем
        return;
      }

      // Проверяем форму сообщения перед приведением типа
      if (
        !data ||
        typeof data !== "object" ||
        typeof (data as { type?: unknown }).type !== "string"
      ) {
        return;
      }

      const message = data as ServerMessage;

      switch (message.type) {
        case "state":
          this.stateCallback?.(message.game, message.state);
          break;

        case "error":
          // Ошибка до первого состояния — фатальна (сессия/стол),
          // переподключаться бессмысленно
          this.gotFatalError = true;
          this.errorCallback?.(message.message);
          break;

        case "playerJoined":
          console.log(`[WS] К столу присоединился: ${message.playerName}`);
          break;

        case "playerLeft":
          console.log(`[WS] Стол покинул игрок: ${message.playerId}`);
          break;
      }
    };

    this.ws.onerror = () => {
      // Детали ошибки придут в onclose — здесь ничего не делаем
    };

    this.ws.onclose = () => {
      if (this.manuallyClosed) return;

      // Сервер сам отказал нам (нет сессии, стол заполнен) — не ретраим
      if (this.gotFatalError) {
        this.handleFailure();
        return;
      }

      this.setStatus("disconnected");

      if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
          this.openSocket();
        }, RECONNECT_DELAY_MS);
      } else {
        // Попытки исчерпаны — сдаёмся и сообщаем игре
        this.handleFailure();
      }
    };
  }

  private handleFailure(): void {
    if (this.failed) return;
    this.failed = true;

    this.clearTimers();
    this.setStatus("failed");
    this.failureCallback?.();
  }

  private setStatus(status: ConnectionState): void {
    this.statusCallback?.(status);
  }

  private clearTimers(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
