// Авторитетная серверная логика Дурака (подкидной).
// Портирована из frontend/src/games/durak/engine.ts и bots.ts — правила идентичны.

/**
 * @typedef {"spades"|"hearts"|"diamonds"|"clubs"} Suit
 * @typedef {{ id: string, rank: number, suit: Suit }} DurakCard
 */

const SUITS = ["spades", "hearts", "diamonds", "clubs"];

const SUIT_SYMBOLS = { spades: "♠", hearts: "♥", diamonds: "♦", clubs: "♣" };

const RANK_LABELS = {
  6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
  11: "В", 12: "Д", 13: "К", 14: "А",
};

// Сообщения движка, означающие отклонённое действие.
// Дублируют набор из клиентского engine.ts — держим синхронно
const DURAK_ERROR_RESULTS = new Set([
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

const MAX_TABLE_PAIRS = 6;

function cardLabel(card) {
  return `${RANK_LABELS[card.rank]}${SUIT_SYMBOLS[card.suit]}`;
}

function createDeck() {
  const deck = [];
  let id = 0;

  for (const suit of SUITS) {
    for (let rank = 6; rank <= 14; rank++) {
      deck.push({ id: `dcard-${id++}`, rank, suit });
    }
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

function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

function canBeat(attack, defense, trumpSuit) {
  if (defense.suit === attack.suit) return defense.rank > attack.rank;
  return defense.suit === trumpSuit;
}

function tableRanks(state) {
  const ranks = new Set();
  for (const pair of state.tablePairs) {
    ranks.add(pair.attack.rank);
    if (pair.defense) ranks.add(pair.defense.rank);
  }
  return ranks;
}

function canThrowIn(card, state) {
  return tableRanks(state).has(card.rank);
}

function getBeatingCards(hand, attack, trumpSuit) {
  return hand.filter(card => canBeat(attack, card, trumpSuit));
}

function dealPlayers(playerNames, botCount, deck) {
  const players = [];

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

function createDurakGame(playerNames, botCount) {
  const deck = shuffle(createDeck());

  // Козырная карта — нижняя карта колоды.
  // При лимите 4 игрока (24 карты из 35) колода не пустеет,
  // поэтому trumpCard гарантированно существует
  const trumpCard = deck.pop();

  const players = dealPlayers(playerNames, botCount, deck);

  // Первый атакующий — владелец младшего козыря,
  // иначе первый игрок
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

// Добрать руки до 6 карт: сначала все, кроме защитника, затем защитник
function refillHands(state) {
  const total = state.players.length;
  const order = [];

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
        player.hand.push(state.drawPile.pop());
        drew = true;
      }
    }
  }
}

// Первый, кто избавился от карт при пустой колоде, — победитель.
// Игра заканчивается сразу (упрощённое правило; при 2 игроках — классика)
function checkFinish(state) {
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

// Завершение боя: сброс стола (бито) или передача защитнику (взятие),
// добор рук, ротация ролей
function endBout(state, took) {
  if (!took) {
    for (const pair of state.tablePairs) {
      state.discardPile.push(pair.attack);
      if (pair.defense) state.discardPile.push(pair.defense);
    }
  }

  state.tablePairs = [];
  refillHands(state);

  if (checkFinish(state)) return;

  const total = state.players.length;
  state.attackerIndex = took
    ? (state.defenderIndex + 1) % total
    : state.defenderIndex;
  state.defenderIndex = (state.attackerIndex + 1) % total;
  state.phase = "attack";
  state.passedPlayerIds = [];
}

function durakAttack(state, playerId, cardId) {
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

function durakDefend(state, playerId, attackCardId, defenseCardId) {
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

function durakThrowIn(state, playerId, cardId) {
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

  if (!tableRanks(s).has(card.rank)) {
    s.lastAction = "Такую карту нельзя подкинуть";
    return s;
  }

  // Лимиты: не больше 6 пар, защитник должен иметь возможность отбиться
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

function durakTake(state, playerId) {
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

function durakPass(state, playerId) {
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

// Авто-действие по таймауту хода:
// attack -> авто-атака младшей некозырной, defend -> взятие, throwIn -> все пасуют
function durakAutoTimeout(state) {
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

// ID игрока, который должен действовать сейчас
function getExpectedActorId(state) {
  if (state.status !== "playing") return null;

  if (state.phase === "attack") return state.players[state.attackerIndex].id;
  if (state.phase === "defend") return state.players[state.defenderIndex].id;

  const defender = state.players[state.defenderIndex];
  const pending = state.players.find(
    p => p.id !== defender.id && !state.passedPlayerIds.includes(p.id)
  );
  return pending ? pending.id : null;
}

// ===== Боты =====

function preferNonTrump(trumpSuit) {
  return (a, b) => {
    const ta = a.suit === trumpSuit ? 1 : 0;
    const tb = b.suit === trumpSuit ? 1 : 0;
    if (ta !== tb) return ta - tb;
    return a.rank - b.rank;
  };
}

function makeDurakBotMove(state, botId) {
  if (getExpectedActorId(state) !== botId) return state;

  const bot = state.players.find(p => p.id === botId);
  if (!bot) return state;

  if (state.phase === "attack") {
    const card = [...bot.hand].sort(preferNonTrump(state.trumpSuit))[0];
    return durakAttack(state, botId, card.id);
  }

  if (state.phase === "defend") {
    for (const pair of state.tablePairs) {
      if (pair.defense) continue;

      const options = getBeatingCards(bot.hand, pair.attack, state.trumpSuit)
        .sort(preferNonTrump(state.trumpSuit));

      if (options.length > 0) {
        return durakDefend(state, botId, pair.attack.id, options[0].id);
      }
    }

    return durakTake(state, botId);
  }

  // throwIn: подкидываем совпадающий ранг, НО только пока не достигнуты
  // лимиты стола (не больше 6 пар и пар меньше, чем карт защитника).
  // Раньше бот не проверял лимиты, движок отклонял его попытки,
  // и партия замирала в бесконечном цикле "Такую карту нельзя подкинуть".
  // Теперь при исчерпанных лимитах или отсутствии кандидата бот говорит пас
  const defender = state.players[state.defenderIndex];
  const throwAllowed =
    state.tablePairs.length < MAX_TABLE_PAIRS &&
    state.tablePairs.length < defender.hand.length;

  if (throwAllowed) {
    const candidate = bot.hand
      .filter(card => canThrowIn(card, state))
      .sort(preferNonTrump(state.trumpSuit))[0];

    if (candidate) {
      return durakThrowIn(state, botId, candidate.id);
    }
  }

  return durakPass(state, botId);
}

module.exports = {
  createDurakGame,
  durakAttack,
  durakDefend,
  durakThrowIn,
  durakTake,
  durakPass,
  durakAutoTimeout,
  getExpectedActorId,
  makeDurakBotMove,
  DURAK_ERROR_RESULTS,
};
