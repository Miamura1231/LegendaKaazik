import type {
  DurakCard,
  DurakGameState,
  DurakPlayer,
  Suit,
} from "./types";

// ===== Константы для отображения =====

export const SUITS: Suit[] = ["spades", "hearts", "diamonds", "clubs"];

export const SUIT_SYMBOLS: Record<Suit, string> = {
  spades: "♠",
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
};

// Красные масти — для подсветки в интерфейсе
export const RED_SUITS: Suit[] = ["hearts", "diamonds"];

export const RANK_LABELS: Record<number, string> = {
  6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
  11: "В", 12: "Д", 13: "К", 14: "А",
};

// Сообщения движка, означающие отклонённое действие.
// Тот же набор определён в mock-server/durakEngine.js — держим синхронно
export const DURAK_ERROR_RESULTS = new Set<string>([
  "Не твой ход!",
  "Карта не найдена",
  "Этой картой нельзя отбиться",
  "Такую карту нельзя подкинуть",
  "Сейчас нельзя брать карты",
  "Вы уже сказали пас",
  "Сейчас нельзя пасовать",
  "Атака уже сделана",
  "Сейчас нельзя отбиваться",
  "Сейчас нельзя подкидывать",
]);

// Максимум карт в одной атаке (классическое правило)
export const MAX_TABLE_PAIRS = 6;

export function cardLabel(card: DurakCard): string {
  return `${RANK_LABELS[card.rank]}${SUIT_SYMBOLS[card.suit]}`;
}

// ===== Вспомогательные функции =====

function createDeck(): DurakCard[] {
  const deck: DurakCard[] = [];
  let id = 0;

  for (const suit of SUITS) {
    for (let rank = 6; rank <= 14; rank++) {
      deck.push({
        id: `dcard-${id++}`,
        rank: rank as DurakCard["rank"],
        suit,
      });
    }
  }

  return deck;
}

function shuffle<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function clone(state: DurakGameState): DurakGameState {
  return JSON.parse(JSON.stringify(state)) as DurakGameState;
}

// Может ли defense побить attack (с учётом козыря)
export function canBeat(attack: DurakCard, defense: DurakCard, trumpSuit: Suit): boolean {
  if (defense.suit === attack.suit) return defense.rank > attack.rank;
  return defense.suit === trumpSuit;
}

// Ранги всех карт на столе — подкидывать можно только их
export function tableRanks(state: DurakGameState): Set<number> {
  const ranks = new Set<number>();
  for (const pair of state.tablePairs) {
    ranks.add(pair.attack.rank);
    if (pair.defense) ranks.add(pair.defense.rank);
  }
  return ranks;
}

export function canThrowIn(card: DurakCard, state: DurakGameState): boolean {
  return tableRanks(state).has(card.rank);
}

// Все карты руки, которыми можно побить данную атаку
export function getBeatingCards(
  hand: DurakCard[],
  attack: DurakCard,
  trumpSuit: Suit
): DurakCard[] {
  return hand.filter(card => canBeat(attack, card, trumpSuit));
}

// Карты руки, которые можно подкинуть при текущем столе
export function getThrowInCandidates(hand: DurakCard[], state: DurakGameState): DurakCard[] {
  return hand.filter(card => canThrowIn(card, state));
}

// ===== Создание игры =====

function dealPlayers(playerNames: string[], botCount: number, deck: DurakCard[]): DurakPlayer[] {
  const players: DurakPlayer[] = [];

  playerNames.forEach((name, index) => {
    players.push({
      id: `player-${index}`,
      name,
      hand: deck.splice(0, 6),
      isBot: false,
    });
  });

  for (let i = 0; i < botCount; i++) {
    players.push({
      id: `bot-${i}`,
      name: `Бот ${i + 1}`,
      hand: deck.splice(0, 6),
      isBot: true,
    });
  }

  return players;
}

export function createDurakGame(playerNames: string[], botCount: number): DurakGameState {
  const deck = shuffle(createDeck());

  // Козырная карта — нижняя карта колоды.
  // При нашем лимите в 4 игрока (24 карты из 35 после снятия козыря)
  // колода не может опустеть, поэтому trumpCard гарантированно есть
  const trumpCard = deck.pop()!;

  const players = dealPlayers(playerNames, botCount, deck);

  // Первый атакующий — владелец младшего козыря;
  // если козырей ни у кого нет — первый игрок
  let attackerIndex = 0;
  let bestRank = Infinity;

  players.forEach((player, index) => {
    for (const card of player.hand) {
      if (card.suit === trumpCard.suit && card.rank < bestRank) {
        bestRank = card.rank;
        attackerIndex = index;
      }
    }
  });

  const defenderIndex = (attackerIndex + 1) % players.length;

  return {
    id: `durak-${Date.now()}`,
    players,
    drawPile: deck,
    trumpCard,
    trumpSuit: trumpCard.suit,
    discardPile: [],
    tablePairs: [],
    phase: "attack",
    attackerIndex,
    defenderIndex,
    passedPlayerIds: [],
    status: "playing",
    winner: null,
    lastAction: `Игра началась. Козырь: ${SUIT_SYMBOLS[trumpCard.suit]}. Атакует ${players[attackerIndex].name}`,
  };
}

// ===== Внутренняя механика боя =====

// Добрать руки до 6 карт: сначала все, кроме защитника (по кругу от атакующего),
// затем защитник
function refillHands(state: DurakGameState): void {
  const total = state.players.length;
  const order: number[] = [];

  for (let i = 0; i < total; i++) {
    const idx = (state.attackerIndex + i) % total;
    if (idx !== state.defenderIndex) order.push(idx);
  }
  order.push(state.defenderIndex);

  let drew = true;
  while (drew && state.drawPile.length > 0) {
    drew = false;
    for (const idx of order) {
      if (state.drawPile.length === 0) break;
      const player = state.players[idx];
      if (player.hand.length < 6) {
        player.hand.push(state.drawPile.pop()!);
        drew = true;
      }
    }
  }
}

// Проверка завершения: первый, кто избавился от карт при пустой колоде, — победитель.
// Игра заканчивается сразу (упрощённое правило для мультиплеера:
// при 2 игроках это классика — оставшийся является дураком)
function checkFinish(state: DurakGameState): boolean {
  if (state.status !== "playing") return true;

  const done = state.players.find(
    p => p.hand.length === 0 && state.drawPile.length === 0
  );

  if (done) {
    state.status = "finished";
    state.winner = done.name;
    state.lastAction = `${done.name} избавился от карт и выиграл!`;
    return true;
  }

  return false;
}

// Завершение боя: стол уходит в сброс (бито) или защитнику (взятие),
// руки добираются, роли ротируются
function endBout(state: DurakGameState, took: boolean): void {
  if (!took) {
    // Бито — все карты со стола уходят в сброс
    for (const pair of state.tablePairs) {
      state.discardPile.push(pair.attack);
      if (pair.defense) state.discardPile.push(pair.defense);
    }
  }

  state.tablePairs = [];
  refillHands(state);

  if (checkFinish(state)) return;

  const total = state.players.length;
  // При взятии атакует следующий после защитника;
  // при бито — сам защитник
  state.attackerIndex = took
    ? (state.defenderIndex + 1) % total
    : state.defenderIndex;
  state.defenderIndex = (state.attackerIndex + 1) % total;
  state.phase = "attack";
  state.passedPlayerIds = [];
}

// ===== Действия игроков =====

export function durakAttack(
  state: DurakGameState,
  playerId: string,
  cardId: string
): DurakGameState {
  const s = clone(state);

  if (s.status !== "playing") return s;

  if (s.phase !== "attack") {
    s.lastAction = "Атака уже сделана";
    return s;
  }

  const attacker = s.players[s.attackerIndex];
  if (attacker.id !== playerId) {
    s.lastAction = "Не твой ход!";
    return s;
  }

  const cardIndex = attacker.hand.findIndex(c => c.id === cardId);
  if (cardIndex === -1) {
    s.lastAction = "Карта не найдена";
    return s;
  }

  const card = attacker.hand.splice(cardIndex, 1)[0];
  s.tablePairs.push({ attack: card, defense: null });
  s.phase = "defend";
  s.passedPlayerIds = [];
  s.lastAction = `${attacker.name} атакует ${cardLabel(card)}`;

  return s;
}

export function durakDefend(
  state: DurakGameState,
  playerId: string,
  attackCardId: string,
  defenseCardId: string
): DurakGameState {
  const s = clone(state);

  if (s.status !== "playing") return s;

  if (s.phase !== "defend") {
    s.lastAction = "Сейчас нельзя отбиваться";
    return s;
  }

  const defender = s.players[s.defenderIndex];
  if (defender.id !== playerId) {
    s.lastAction = "Не твой ход!";
    return s;
  }

  const pair = s.tablePairs.find(p => p.attack.id === attackCardId && !p.defense);
  if (!pair) {
    s.lastAction = "Карта не найдена";
    return s;
  }

  const cardIndex = defender.hand.findIndex(c => c.id === defenseCardId);
  if (cardIndex === -1) {
    s.lastAction = "Карта не найдена";
    return s;
  }

  const card = defender.hand[cardIndex];
  if (!canBeat(pair.attack, card, s.trumpSuit)) {
    s.lastAction = "Этой картой нельзя отбиться";
    return s;
  }

  defender.hand.splice(cardIndex, 1);
  pair.defense = card;
  s.phase = "throwIn";
  s.passedPlayerIds = [];
  s.lastAction = `${defender.name} отбился ${cardLabel(card)}`;

  return s;
}

export function durakThrowIn(
  state: DurakGameState,
  playerId: string,
  cardId: string
): DurakGameState {
  const s = clone(state);

  if (s.status !== "playing") return s;

  if (s.phase !== "throwIn") {
    s.lastAction = "Сейчас нельзя подкидывать";
    return s;
  }

  const defender = s.players[s.defenderIndex];
  const actor = s.players.find(p => p.id === playerId);

  if (!actor || actor.id === defender.id) {
    s.lastAction = "Не твой ход!";
    return s;
  }

  if (s.passedPlayerIds.includes(playerId)) {
    s.lastAction = "Вы уже сказали пас";
    return s;
  }

  const cardIndex = actor.hand.findIndex(c => c.id === cardId);
  if (cardIndex === -1) {
    s.lastAction = "Карта не найдена";
    return s;
  }

  const card = actor.hand[cardIndex];

  // Подкинуть можно только карту с рангом, уже лежащим на столе
  if (!tableRanks(s).has(card.rank)) {
    s.lastAction = "Такую карту нельзя подкинуть";
    return s;
  }

  // Лимиты: не больше 6 пар, и защитник должен иметь возможность отбиться
  if (s.tablePairs.length >= MAX_TABLE_PAIRS || s.tablePairs.length >= defender.hand.length) {
    s.lastAction = "Такую карту нельзя подкинуть";
    return s;
  }

  actor.hand.splice(cardIndex, 1);
  s.tablePairs.push({ attack: card, defense: null });
  s.phase = "defend";
  s.passedPlayerIds = [];
  s.lastAction = `${actor.name} подкидывает ${cardLabel(card)}`;

  return s;
}

export function durakTake(state: DurakGameState, playerId: string): DurakGameState {
  const s = clone(state);

  if (s.status !== "playing") return s;

  if (s.phase !== "defend") {
    s.lastAction = "Сейчас нельзя брать карты";
    return s;
  }

  const defender = s.players[s.defenderIndex];
  if (defender.id !== playerId) {
    s.lastAction = "Не твой ход!";
    return s;
  }

  if (!s.tablePairs.some(p => !p.defense)) {
    s.lastAction = "Сейчас нельзя брать карты";
    return s;
  }

  let taken = 0;
  for (const pair of s.tablePairs) {
    defender.hand.push(pair.attack);
    taken++;
    if (pair.defense) {
      defender.hand.push(pair.defense);
      taken++;
    }
  }

  s.tablePairs = [];
  s.lastAction = `${defender.name} забрал ${taken} ${taken === 1 ? "карту" : "карт"}`;

  endBout(s, true);

  return s;
}

export function durakPass(state: DurakGameState, playerId: string): DurakGameState {
  const s = clone(state);

  if (s.status !== "playing") return s;

  if (s.phase !== "throwIn") {
    s.lastAction = "Сейчас нельзя пасовать";
    return s;
  }

  const defender = s.players[s.defenderIndex];
  const actor = s.players.find(p => p.id === playerId);

  if (!actor || actor.id === defender.id) {
    s.lastAction = "Не твой ход!";
    return s;
  }

  if (s.passedPlayerIds.includes(playerId)) {
    s.lastAction = "Вы уже сказали пас";
    return s;
  }

  s.passedPlayerIds.push(playerId);

  // Если все, кроме защитника, пасанули — бито
  const others = s.players.filter(p => p.id !== defender.id);
  if (others.every(p => s.passedPlayerIds.includes(p.id))) {
    endBout(s, false);
    if (s.status === "playing") {
      s.lastAction = `Бито! Атакует ${s.players[s.attackerIndex].name}`;
    }
  } else {
    s.lastAction = `${actor.name} сказал пас`;
  }

  return s;
}

// ===== Таймаут хода =====

// Авто-действие по таймауту:
// attack  -> атакующий автоматически играет младшую некозырную карту
//            (пас без атаки завис бы навсегда)
// defend  -> защитник забирает карты
// throwIn -> все пасуют (бито)
export function durakAutoTimeout(state: DurakGameState): DurakGameState {
  let s = clone(state);

  if (s.status !== "playing") return s;

  if (s.phase === "attack") {
    const attacker = s.players[s.attackerIndex];
    const card = [...attacker.hand].sort((a, b) => {
      const ta = a.suit === s.trumpSuit ? 1 : 0;
      const tb = b.suit === s.trumpSuit ? 1 : 0;
      if (ta !== tb) return ta - tb;
      return a.rank - b.rank;
    })[0];
    s = durakAttack(s, attacker.id, card.id);
  } else if (s.phase === "defend") {
    s = durakTake(s, s.players[s.defenderIndex].id);
  } else {
    const defender = s.players[s.defenderIndex];
    s.passedPlayerIds = s.players
      .filter(p => p.id !== defender.id)
      .map(p => p.id);
    endBout(s, false);
    if (s.status === "playing") {
      s.lastAction = `Время вышло — бито! Атакует ${s.players[s.attackerIndex].name}`;
    }
  }

  return s;
}

// ID игрока, который должен действовать сейчас (для ботов и подсветки UI)
export function getExpectedActorId(state: DurakGameState): string | null {
  if (state.status !== "playing") return null;

  if (state.phase === "attack") return state.players[state.attackerIndex].id;
  if (state.phase === "defend") return state.players[state.defenderIndex].id;

  // throwIn: первый не-защитник, ещё не пасанувший
  const defender = state.players[state.defenderIndex];
  const pending = state.players.find(
    p => p.id !== defender.id && !state.passedPlayerIds.includes(p.id)
  );
  return pending ? pending.id : null;
}
