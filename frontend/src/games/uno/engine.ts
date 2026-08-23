import type { Card, CardColor, CardValue, GameState, Player, BotDifficulty } from "./types";

function createDeck(): Card[] {
  const colors: CardColor[] = ["red", "yellow", "green", "blue"];
  const values: CardValue[] = [
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "skip", "reverse", "draw2"
  ];

  const deck: Card[] = [];
  let id = 0;

  colors.forEach(color => {
    values.forEach(value => {
      if (value === "0") {
        deck.push({ id: `card-${id++}`, color, value });
      } else {
        deck.push({ id: `card-${id++}`, color, value });
        deck.push({ id: `card-${id++}`, color, value });
      }
    });
  });

  for (let i = 0; i < 4; i++) {
    deck.push({ id: `card-${id++}`, color: "wild", value: "wild" });
    deck.push({ id: `card-${id++}`, color: "wild", value: "wild4" });
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

// Взять count карт из колоды.
// Если колода опустела — пересобираем её из карт сброса (кроме верхней).
// Раньше штрафные карты draw2/wild4 брались без пересборки,
// и при пустой колоде игрок просто не получал карты.
function takeCards(state: GameState, count: number): Card[] {
  const taken: Card[] = [];

  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0) {
      // Пересобирать нечего — колода и сброс почти пусты
      if (state.discardPile.length <= 1) break;

      const topCard = state.discardPile.pop()!;
      state.drawPile = shuffle(state.discardPile);
      state.discardPile = [topCard];
    }

    const card = state.drawPile.pop();
    if (!card) break;
    taken.push(card);
  }

  return taken;
}

// Флаг "сказал УНО" имеет смысл только при ровно одной карте в руке.
// Сбрасываем его во всех остальных случаях — иначе после добора карт
// флаг оставался true навсегда, и механика УНО ломалась при следующих кругах.
function syncUnoFlag(player: Player): void {
  if (player.hand.length !== 1) {
    player.saidUno = false;
  }
}

export function createGame(
  playerNames: string[],
  botCount: number,
  difficulty: BotDifficulty = "medium"
): GameState {
  const deck = shuffle(createDeck());

  const players: Player[] = [];

  playerNames.forEach((name, index) => {
    const hand = deck.splice(0, 7);
    players.push({
      id: `player-${index}`,
      name,
      hand,
      isBot: false,
      saidUno: false,
    });
  });

  for (let i = 0; i < botCount; i++) {
    const hand = deck.splice(0, 7);
    players.push({
      id: `bot-${i}`,
      name: `Бот ${i + 1}`,
      hand,
      isBot: true,
      saidUno: false,
    });
  }

  // Первая карта сброса — ищем ближайшую не-дикую с конца колоды.
  // Цикл ограничен размером колоды, бесконечный цикл невозможен.
  let firstIndex = deck.length - 1;
  while (firstIndex >= 0 && deck[firstIndex].color === "wild") {
    firstIndex--;
  }
  const firstCard = deck.splice(firstIndex, 1)[0];

  return {
    id: `game-${Date.now()}`,
    players,
    currentPlayerIndex: 0,
    drawPile: deck,
    discardPile: [firstCard],
    direction: 1,
    currentColor: firstCard.color,
    status: "playing",
    winner: null,
    lastAction: `Игра началась. Ход: ${players[0].name}`,
    difficulty,
  };
}

function canPlayCard(card: Card, topCard: Card, currentColor: CardColor): boolean {
  if (card.color === "wild") return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function getNextPlayerIndex(state: GameState, skip: number = 0): number {
  const total = state.players.length;
  let index = state.currentPlayerIndex;

  for (let i = 0; i <= skip; i++) {
    index = (index + state.direction + total) % total;
  }

  return index;
}

export function playCard(state: GameState, playerId: string, cardId: string, chosenColor?: CardColor): GameState {
  const newState = JSON.parse(JSON.stringify(state)) as GameState;
  const playerIndex = newState.players.findIndex(p => p.id === playerId);

  if (playerIndex !== newState.currentPlayerIndex) {
    newState.lastAction = "Не твой ход!";
    return newState;
  }

  const player = newState.players[playerIndex];
  const cardIndex = player.hand.findIndex(c => c.id === cardId);

  if (cardIndex === -1) {
    newState.lastAction = "Карта не найдена";
    return newState;
  }

  const card = player.hand[cardIndex];
  const topCard = newState.discardPile[newState.discardPile.length - 1];

  if (!canPlayCard(card, topCard, newState.currentColor)) {
    newState.lastAction = "Эту карту нельзя сыграть";
    return newState;
  }

  player.hand.splice(cardIndex, 1);
  newState.discardPile.push(card);

  if (card.color !== "wild") {
    newState.currentColor = card.color;
  } else if (chosenColor) {
    newState.currentColor = chosenColor;
  }
  // Если дикая карта сыграна без chosenColor — цвет остаётся прежним.

  let skipCount = 0;

  if (card.value === "skip") {
    skipCount = 1;
  } else if (card.value === "reverse") {
    newState.direction = (newState.direction * -1) as 1 | -1;
    // При двух игроках reverse работает как skip
    if (newState.players.length === 2) {
      skipCount = 1;
    }
  } else if (card.value === "draw2") {
    const nextIndex = getNextPlayerIndex(newState);
    const nextPlayer = newState.players[nextIndex];
    nextPlayer.hand.push(...takeCards(newState, 2));
    syncUnoFlag(nextPlayer);
    skipCount = 1;
  } else if (card.value === "wild4") {
    const nextIndex = getNextPlayerIndex(newState);
    const nextPlayer = newState.players[nextIndex];
    nextPlayer.hand.push(...takeCards(newState, 4));
    syncUnoFlag(nextPlayer);
    skipCount = 1;
  }

  if (player.hand.length === 0) {
    newState.status = "finished";
    newState.winner = player.name;
    newState.lastAction = `${player.name} выиграл!`;
    return newState;
  }

  // Сбрасываем флаг УНО, если карт в руке стало больше одной
  syncUnoFlag(player);

  if (player.hand.length === 1 && !player.saidUno) {
    newState.lastAction = `${player.name} забыл сказать УНО!`;
  } else {
    newState.lastAction = `${player.name} сыграл карту`;
  }

  newState.currentPlayerIndex = getNextPlayerIndex(newState, skipCount);

  return newState;
}

export function drawCard(state: GameState, playerId: string): GameState {
  const newState = JSON.parse(JSON.stringify(state)) as GameState;
  const playerIndex = newState.players.findIndex(p => p.id === playerId);

  if (playerIndex !== newState.currentPlayerIndex) {
    newState.lastAction = "Не твой ход!";
    return newState;
  }

  const player = newState.players[playerIndex];

  const drawn = takeCards(newState, 1);

  if (drawn.length === 0) {
    // Взять карту невозможно (колода и сброс пусты).
    // Передаём ход дальше, чтобы игра не зависла.
    newState.lastAction = `${player.name} не смог взять карту — колода пуста`;
    newState.currentPlayerIndex = getNextPlayerIndex(newState);
    return newState;
  }

  player.hand.push(drawn[0]);
  syncUnoFlag(player);

  newState.lastAction = `${player.name} взял карту`;
  newState.currentPlayerIndex = getNextPlayerIndex(newState);

  return newState;
}

export function sayUno(state: GameState, playerId: string): GameState {
  const newState = JSON.parse(JSON.stringify(state)) as GameState;
  const player = newState.players.find(p => p.id === playerId);

  if (!player) return newState;

  player.saidUno = true;
  newState.lastAction = `${player.name} сказал УНО!`;

  return newState;
}

export function getPlayableCards(hand: Card[], topCard: Card, currentColor: CardColor): Card[] {
  return hand.filter(card => canPlayCard(card, topCard, currentColor));
}
