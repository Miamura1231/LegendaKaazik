export type CardColor = "red" | "yellow" | "green" | "blue" | "wild";

export type CardValue =
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
  | "skip" | "reverse" | "draw2"
  | "wild" | "wild4";

// Сложность ботов за столом
export type BotDifficulty = "easy" | "medium" | "hard";

export interface Card {
  id: string;
  color: CardColor;
  value: CardValue;
}

export interface Player {
  id: string;
  name: string;
  hand: Card[];
  isBot: boolean;
  saidUno: boolean;
}

export interface GameState {
  id: string;
  players: Player[];
  currentPlayerIndex: number;
  drawPile: Card[];
  discardPile: Card[];
  direction: 1 | -1;
  currentColor: CardColor;
  status: "waiting" | "playing" | "finished";
  winner: string | null;
  lastAction: string;
  // Сложность всех ботов за этим столом
  difficulty: BotDifficulty;
  /**
   * Остаток секунд на ход. Заполняется сервером (рассылается каждый тик).
   * В локальном режиме поле не используется — там свой таймер в компоненте.
   */
  timeLeft?: number;
}

export type GameAction =
  | { type: "playCard"; cardId: string; chosenColor?: CardColor }
  | { type: "drawCard" }
  | { type: "sayUno" }
  | { type: "challengeUno"; targetPlayerId: string };
