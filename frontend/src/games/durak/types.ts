// Типы игры "Дурак" (подкидной, 2-6 игроков, только онлайн).

export type Suit = "spades" | "hearts" | "diamonds" | "clubs";

// Ранг карты: 6-10 обычные, 11=Валет, 12=Дама, 13=Король, 14=Туз
export type Rank = 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface DurakCard {
  id: string;
  rank: Rank;
  suit: Suit;
}

export interface DurakPlayer {
  id: string;
  name: string;
  hand: DurakCard[];
  isBot: boolean;
}

// Пара на столе: карта атаки и (опционально) карта защиты
export interface TablePair {
  attack: DurakCard;
  defense: DurakCard | null;
}

// Фазы розыгрыша (боя):
// attack  — атакующий кладёт первую карту
// defend  — защитник отбивается или забирает карты
// throwIn — остальные игроки подкидывают или пасуют
export type DurakPhase = "attack" | "defend" | "throwIn";

export interface DurakGameState {
  id: string;
  players: DurakPlayer[];
  drawPile: DurakCard[];
  // Нижняя карта колоды — козырная; лежит рубашкой вверх до конца игры
  trumpCard: DurakCard | null;
  trumpSuit: Suit;
  discardPile: DurakCard[];
  tablePairs: TablePair[];
  phase: DurakPhase;
  attackerIndex: number;
  defenderIndex: number;
  // Кто пасанул в текущем раунде подкидывания
  passedPlayerIds: string[];
  status: "waiting" | "playing" | "finished";
  winner: string | null;
  lastAction: string;
  // Остаток секунд на ход (заполняется сервером)
  timeLeft?: number;
}

export type DurakAction =
  | { type: "attack"; cardId: string }
  | { type: "defend"; attackCardId: string; defenseCardId: string }
  | { type: "throwIn"; cardId: string }
  | { type: "take" }
  | { type: "pass" };
