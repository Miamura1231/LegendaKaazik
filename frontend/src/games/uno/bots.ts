import type { GameState, CardColor, Card, CardValue, BotDifficulty } from "./types";
import { getPlayableCards, playCard, drawCard, sayUno } from "./engine";

function getMostFrequentColor(state: GameState, botId: string): CardColor {
  const bot = state.players.find(p => p.id === botId);
  if (!bot) return "red";

  const colorCounts: Record<CardColor, number> = {
    red: 0,
    yellow: 0,
    green: 0,
    blue: 0,
    wild: 0,
  };

  bot.hand.forEach(card => {
    if (card.color !== "wild") {
      colorCounts[card.color]++;
    }
  });

  let maxColor: CardColor = "red";
  let maxCount = 0;

  Object.entries(colorCounts).forEach(([color, count]) => {
    if (color !== "wild" && count > maxCount) {
      maxColor = color as CardColor;
      maxCount = count;
    }
  });

  return maxColor;
}

// Приоритет карт для сложного бота:
// сначала штрафные и блокирующие, затем обычные числа,
// дикие карты приберегаем на самый конец.
const HARD_PRIORITY: Record<CardValue, number> = {
  draw2: 0,
  skip: 1,
  reverse: 2,
  "0": 3, "1": 3, "2": 3, "3": 3, "4": 3,
  "5": 3, "6": 3, "7": 3, "8": 3, "9": 3,
  wild4: 4,
  wild: 5,
};

// Выбор карты из подходящих в зависимости от сложности.
function chooseCardByDifficulty(cards: Card[], difficulty: BotDifficulty): Card {
  switch (difficulty) {
    case "easy":
      // Случайная подходящая карта
      return cards[Math.floor(Math.random() * cards.length)];

    case "hard":
      // Сортировка по приоритету, берём первую
      return [...cards].sort(
        (a, b) => HARD_PRIORITY[a.value] - HARD_PRIORITY[b.value]
      )[0];

    case "medium":
    default:
      // Первая подходящая
      return cards[0];
  }
}

export function makeBotMove(state: GameState, botId: string): GameState {
  const botIndex = state.players.findIndex(p => p.id === botId);

  if (botIndex !== state.currentPlayerIndex || state.status !== "playing") {
    return state;
  }

  const bot = state.players[botIndex];
  const topCard = state.discardPile[state.discardPile.length - 1];
  const playableCards = getPlayableCards(bot.hand, topCard, state.currentColor);

  if (playableCards.length > 0) {
    // Fallback на medium для состояний, созданных до появления сложности
    const difficulty = state.difficulty ?? "medium";
    const cardToPlay = chooseCardByDifficulty(playableCards, difficulty);

    let chosenColor: CardColor | undefined;
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

  // Нет подходящих карт — берём из колоды (для любой сложности)
  return drawCard(state, botId);
}
