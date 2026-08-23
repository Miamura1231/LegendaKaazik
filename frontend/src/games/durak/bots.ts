// Логика ботов для Дурака.
// В онлайн-режиме ботов выполняет сервер (копия в mock-server/durakEngine.js),
// эта клиентская версия нужна для единообразия и возможных тестов.

import type { DurakCard, DurakGameState, Suit } from "./types";
import {
  durakAttack,
  durakDefend,
  durakThrowIn,
  durakTake,
  durakPass,
  getExpectedActorId,
  getBeatingCards,
  canThrowIn,
  MAX_TABLE_PAIRS,
} from "./engine";

// Сортировка: сначала некозырные, внутри — по возрастанию ранга
function preferNonTrump(trumpSuit: Suit) {
  return (a: DurakCard, b: DurakCard) => {
    const ta = a.suit === trumpSuit ? 1 : 0;
    const tb = b.suit === trumpSuit ? 1 : 0;
    if (ta !== tb) return ta - tb;
    return a.rank - b.rank;
  };
}

export function makeDurakBotMove(state: DurakGameState, botId: string): DurakGameState {
  // Бот ходит строго в свою очередь
  if (getExpectedActorId(state) !== botId) return state;

  const bot = state.players.find(p => p.id === botId);
  if (!bot) return state;

  if (state.phase === "attack") {
    // Атака наименьшей некозырной картой; если только козыри — наименьшим козырем
    const card = [...bot.hand].sort(preferNonTrump(state.trumpSuit))[0];
    return durakAttack(state, botId, card.id);
  }

  if (state.phase === "defend") {
    // Защита наименьшей подходящей картой (некозырные предпочтительнее)
    for (const pair of state.tablePairs) {
      if (pair.defense) continue;

      const options = getBeatingCards(bot.hand, pair.attack, state.trumpSuit)
        .sort(preferNonTrump(state.trumpSuit));

      if (options.length > 0) {
        return durakDefend(state, botId, pair.attack.id, options[0].id);
      }
    }

    // Отбиться нечем — забираем карты
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
