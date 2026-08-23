// Авторитетная игровая логика УНО для сервера.
// Портирована из frontend/src/games/uno/engine.ts и frontend/src/games/uno/bots.ts.
// Правила полностью идентичны клиентской версии — расхождений быть не должно.

/**
 * @typedef {"red"|"yellow"|"green"|"blue"|"wild"} CardColor
 * @typedef {string} CardValue
 * @typedef {{ id: string, color: CardColor, value: CardValue }} Card
 * @typedef {{ id: string, name: string, hand: Card[], isBot: boolean, saidUno: boolean }} Player
 * @typedef {Object} GameState
 */

function createDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = [
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "skip", "reverse", "draw2",
  ];

  const deck = [];
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

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Взять count карт из колоды.
// Если колода опустела — пересобираем её из карт сброса (кроме верхней).
function takeCards(state, count) {
  const taken = [];

  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0) {
      // Пересобирать нечего — колода и сброс почти пусты
      if (state.discardPile.length <= 1) break;

      const topCard = state.discardPile.pop();
      state.drawPile = shuffle(state.discardPile);
      state.discardPile = [topCard];
    }

    const card = state.drawPile.pop();
    if (!card) break;
    taken.push(card);
  }

  return taken;
}

// Флаг "сказал УНО" имеет смысл только при ровно одной карте в руке
function syncUnoFlag(player) {
  if (player.hand.length !== 1) {
    player.saidUno = false;
  }
}

/**
 * Создать новую игру.
 * @param {string[]} playerNames ники живых игроков (сидят первыми по порядку)
 * @param {number} botCount сколько ботов добавить после людей
 * @param {"easy"|"medium"|"hard"} difficulty сложность ботов
 */
function createGame(playerNames, botCount, difficulty = "medium") {
  const deck = shuffle(createDeck());

  const players = [];

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

  // Первая карта сброса — ближайшая не-дикая с конца колоды
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

function canPlayCard(card, topCard, currentColor) {
  if (card.color === "wild") return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function getNextPlayerIndex(state, skip = 0) {
  const total = state.players.length;
  let index = state.currentPlayerIndex;

  for (let i = 0; i <= skip; i++) {
    index = (index + state.direction + total) % total;
  }

  return index;
}

function playCard(state, playerId, cardId, chosenColor) {
  const newState = JSON.parse(JSON.stringify(state));
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

  let skipCount = 0;

  if (card.value === "skip") {
    skipCount = 1;
  } else if (card.value === "reverse") {
    newState.direction = newState.direction * -1;
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

  syncUnoFlag(player);

  if (player.hand.length === 1 && !player.saidUno) {
    newState.lastAction = `${player.name} забыл сказать УНО!`;
  } else {
    newState.lastAction = `${player.name} сыграл карту`;
  }

  newState.currentPlayerIndex = getNextPlayerIndex(newState, skipCount);

  return newState;
}

function drawCard(state, playerId) {
  const newState = JSON.parse(JSON.stringify(state));
  const playerIndex = newState.players.findIndex(p => p.id === playerId);

  if (playerIndex !== newState.currentPlayerIndex) {
    newState.lastAction = "Не твой ход!";
    return newState;
  }

  const player = newState.players[playerIndex];

  const drawn = takeCards(newState, 1);

  if (drawn.length === 0) {
    // Колода и сброс пусты — передаём ход дальше, чтобы игра не зависла
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

function sayUno(state, playerId) {
  const newState = JSON.parse(JSON.stringify(state));
  const player = newState.players.find(p => p.id === playerId);

  if (!player) return newState;

  player.saidUno = true;
  newState.lastAction = `${player.name} сказал УНО!`;

  return newState;
}

function getPlayableCards(hand, topCard, currentColor) {
  return hand.filter(card => canPlayCard(card, topCard, currentColor));
}

// ===== Логика ботов (порт frontend/src/games/uno/bots.ts) =====

function getMostFrequentColor(state, botId) {
  const bot = state.players.find(p => p.id === botId);
  if (!bot) return "red";

  const colorCounts = { red: 0, yellow: 0, green: 0, blue: 0, wild: 0 };

  bot.hand.forEach(card => {
    if (card.color !== "wild") {
      colorCounts[card.color]++;
    }
  });

  let maxColor = "red";
  let maxCount = 0;

  Object.entries(colorCounts).forEach(([color, count]) => {
    if (color !== "wild" && count > maxCount) {
      maxColor = color;
      maxCount = count;
    }
  });

  return maxColor;
}

// Приоритет карт для сложного бота: сначала штрафные и блокирующие,
// затем числа, дикие карты приберегаем на конец
const HARD_PRIORITY = {
  draw2: 0,
  skip: 1,
  reverse: 2,
  "0": 3, "1": 3, "2": 3, "3": 3, "4": 3,
  "5": 3, "6": 3, "7": 3, "8": 3, "9": 3,
  wild4: 4,
  wild: 5,
};

function chooseCardByDifficulty(cards, difficulty) {
  switch (difficulty) {
    case "easy":
      return cards[Math.floor(Math.random() * cards.length)];

    case "hard":
      return [...cards].sort(
        (a, b) => HARD_PRIORITY[a.value] - HARD_PRIORITY[b.value]
      )[0];

    case "medium":
    default:
      return cards[0];
  }
}

function makeBotMove(state, botId) {
  const botIndex = state.players.findIndex(p => p.id === botId);

  if (botIndex !== state.currentPlayerIndex || state.status !== "playing") {
    return state;
  }

  const bot = state.players[botIndex];
  const topCard = state.discardPile[state.discardPile.length - 1];
  const playableCards = getPlayableCards(bot.hand, topCard, state.currentColor);

  if (playableCards.length > 0) {
    const difficulty = state.difficulty || "medium";
    const cardToPlay = chooseCardByDifficulty(playableCards, difficulty);

    let chosenColor;
    if (cardToPlay.color === "wild") {
      chosenColor = getMostFrequentColor(state, botId);
    }

    let newState = playCard(state, botId, cardToPlay.id, chosenColor);

    const updatedBot = newState.players.find(p => p.id === botId);
    if (updatedBot && updatedBot.hand.length === 1 && !updatedBot.saidUno) {
      newState = sayUno(newState, botId);
    }

    return newState;
  }

  return drawCard(state, botId);
}

module.exports = {
  createGame,
  playCard,
  drawCard,
  sayUno,
  getPlayableCards,
  makeBotMove,
};
