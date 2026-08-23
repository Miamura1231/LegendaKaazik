import { useState } from "react";
import type { MutableRefObject } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuthStore } from "../../store/authStore";
import { GameSocket } from "../../network/socket";
import { showToast } from "../../components/Toast";
import { ConfirmModal } from "../../components/ConfirmModal";
import { apiKickPlayer } from "../../api/client";
import type { ConnectionState } from "../../network/types";
import type { MyTableInfo } from "../../api/types";
import type { DurakCard, DurakGameState, DurakAction } from "./types";
import {
  SUIT_SYMBOLS,
  RED_SUITS,
  RANK_LABELS,
  canBeat,
  getThrowInCandidates,
} from "./engine";

interface DurakGameProps {
  // Информация о столе из опроса my-table (права создателя для кика)
  tableInfo: MyTableInfo | null;
  connStatus: ConnectionState;
  // Сокетом владеет диспетчер — сюда приходит его ref
  socketRef: MutableRefObject<GameSocket | null>;
  // Авторитетное состояние партии от сервера
  serverState: DurakGameState | null;
}

// Карточка Дурака (стили инлайн — переиспользовать uno-карты нельзя)
function CardView({
  card,
  selected,
  dimmed,
  onClick,
}: {
  card: DurakCard;
  selected?: boolean;
  dimmed?: boolean;
  onClick?: () => void;
}) {
  const red = RED_SUITS.includes(card.suit);

  return (
    <div
      onClick={onClick}
      style={{
        width: "64px",
        height: "92px",
        borderRadius: "6px",
        background: "var(--bg-primary)",
        border: selected ? "2px solid var(--accent)" : "1px solid var(--bg-tertiary)",
        opacity: dimmed ? 0.45 : 1,
        cursor: onClick ? "pointer" : "default",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: "bold",
        fontSize: "1.1rem",
        lineHeight: 1.2,
        color: red ? "#e74c3c" : "var(--text-primary)",
        userSelect: "none",
      }}
    >
      <div>{RANK_LABELS[card.rank]}</div>
      <div>{SUIT_SYMBOLS[card.suit]}</div>
    </div>
  );
}

export function DurakGame({
  tableInfo,
  connStatus,
  socketRef,
  serverState,
}: DurakGameProps) {
  const { tableId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  // Выбранная карта руки для защиты
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  // Состояние приходит от диспетчера (сокет живёт там)
  const gs = serverState;

  if (!gs || !user) {
    return <div className="loading">Ожидание состояния игры...</div>;
  }

  const me = gs.players.find(p => p.name === user.nickname);
  if (!me) {
    return <div className="loading">Вы не найдены за этим столом</div>;
  }

  const attacker = gs.players[gs.attackerIndex];
  const defender = gs.players[gs.defenderIndex];
  const amAttacker = attacker.id === me.id;
  const amDefender = defender.id === me.id;

  // Мой ли сейчас ход (по фазе и роли)
  const isMyMove =
    (gs.phase === "attack" && amAttacker) ||
    (gs.phase === "defend" && amDefender) ||
    (gs.phase === "throwIn" && !amDefender && !gs.passedPlayerIds.includes(me.id));

  const send = (action: DurakAction) => {
    socketRef.current?.sendAction("durak", action);
    setSelectedCardId(null);
  };

  // ===== Защита: выбор своей карты, затем клик по карте атаки на столе =====
  const unbeatenPairs = gs.tablePairs.filter(p => !p.defense);
  const selectedCard = me.hand.find(c => c.id === selectedCardId) ?? null;
  const beatableAttackIds = selectedCard
    ? unbeatenPairs
        .filter(p => canBeat(p.attack, selectedCard, gs.trumpSuit))
        .map(p => p.attack.id)
    : [];

  // ===== Подкидывание: доступные карты с учётом лимитов стола =====
  const throwAllowed =
    gs.phase === "throwIn" &&
    gs.tablePairs.length < 6 &&
    gs.tablePairs.length < defender.hand.length;
  const throwCandidates = throwAllowed ? getThrowInCandidates(me.hand, gs) : [];

  const handleCardClick = (card: DurakCard) => {
    if (gs.phase === "attack" && amAttacker) {
      send({ type: "attack", cardId: card.id });
      return;
    }

    if (gs.phase === "defend" && amDefender) {
      setSelectedCardId(prev => (prev === card.id ? null : card.id));
      return;
    }

    if (gs.phase === "throwIn" && isMyMove && throwCandidates.some(c => c.id === card.id)) {
      send({ type: "throwIn", cardId: card.id });
    }
  };

  const handleTableAttackClick = (attackCardId: string) => {
    if (gs.phase !== "defend" || !amDefender || !selectedCard) return;
    if (beatableAttackIds.includes(attackCardId)) {
      send({ type: "defend", attackCardId, defenseCardId: selectedCard.id });
    }
  };

  const handleKick = async (playerNickname: string) => {
    if (!tableId) return;
    const response = await apiKickPlayer(tableId, playerNickname);
    if (!response.ok) {
      showToast("error", response.error || "Не удалось кикнуть игрока");
    }
  };

  // Подпись индикатора соединения
  const connLabel =
    connStatus === "connected"
      ? "Онлайн"
      : connStatus === "connecting"
        ? "Подключение..."
        : connStatus === "disconnected"
          ? "Переподключение..."
          : "Нет связи";

  // Подсказка по текущей фазе
  const phaseHint = (() => {
    if (gs.phase === "attack") {
      return amAttacker ? "Твоя атака: выбери карту" : `Атакует: ${attacker.name}`;
    }
    if (gs.phase === "defend") {
      if (!amDefender) return `Отбивается: ${defender.name}`;
      return selectedCard
        ? "Кликни карту атаки на столе, чтобы отбиться"
        : "Выбери карту для защиты или забери карты";
    }
    if (!isMyMove) return "Ожидаем подкидывание или пас...";
    return throwCandidates.length > 0
      ? "Можно подкинуть карту того же ранга или сказать пас"
      : "Подкидывать нечего — скажи пас";
  })();

  if (gs.status === "finished") {
    return (
      <div className="container">
        <div className="card" style={{ textAlign: "center", maxWidth: "600px", margin: "4rem auto" }}>
          <h2>Игра окончена!</h2>
          <p style={{ fontSize: "1.5rem", marginTop: "1rem" }}>
            Победитель: <strong>{gs.winner}</strong>
          </p>
          <button onClick={() => navigate("/lobby")} style={{ marginTop: "2rem" }}>
            Вернуться в лобби
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
        <h2>Дурак - {tableId}</h2>
        <button className="btn-danger" onClick={() => setShowExitConfirm(true)}>
          Выйти
        </button>
      </div>

      {/* Индикатор соединения */}
      <div style={{ marginBottom: "1rem" }}>
        <span className={`conn-indicator conn-${connStatus}`}>{connLabel}</span>
      </div>

      {/* Соперники */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: "1rem",
        marginBottom: "2rem",
      }}>
        {gs.players.filter(p => p.id !== me.id).map(player => (
          <div key={player.id} className="card" style={{ padding: "1rem" }}>
            <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>
              {player.name}
              {player.id === attacker.id ? " 🗡" : ""}
              {player.id === defender.id ? " 🛡" : ""}
            </h3>
            <p>Карт: {player.hand.length}</p>
            {tableInfo?.isCreator && !player.isBot && (
              <button
                onClick={() => handleKick(player.name)}
                style={{ marginTop: "0.5rem", padding: "0.2rem 0.7rem", fontSize: "0.85rem" }}
              >
                Кикнуть
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Колода и козырь */}
      <div style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: "2rem",
        marginBottom: "2rem",
        padding: "1.5rem",
        background: "var(--bg-secondary)",
        borderRadius: "8px",
      }}>
        <div style={{ textAlign: "center" }}>
          <p style={{ marginBottom: "0.5rem", color: "var(--text-secondary)" }}>
            Колода ({gs.drawPile.length})
          </p>
          <div style={{
            width: "64px",
            height: "92px",
            borderRadius: "6px",
            background: "var(--bg-tertiary)",
            border: "1px solid var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto",
          }}>
            🂠
          </div>
        </div>
        {gs.trumpCard && (
          <div style={{ textAlign: "center" }}>
            <p style={{ marginBottom: "0.5rem", color: "var(--text-secondary)" }}>
              Козырь: {SUIT_SYMBOLS[gs.trumpSuit]}
            </p>
            <CardView card={gs.trumpCard} />
          </div>
        )}
      </div>

      {/* Стол: пары атака/защита */}
      <div style={{
        minHeight: "120px",
        padding: "1.5rem",
        background: "var(--bg-secondary)",
        borderRadius: "8px",
        marginBottom: "1rem",
        display: "flex",
        flexWrap: "wrap",
        gap: "1.5rem",
        justifyContent: "center",
      }}>
        {gs.tablePairs.length === 0 && (
          <p style={{ color: "var(--text-secondary)" }}>Стол пуст</p>
        )}
        {gs.tablePairs.map(pair => (
          <div key={pair.attack.id} style={{ position: "relative", width: "88px", height: "104px" }}>
            <div
              onClick={() => handleTableAttackClick(pair.attack.id)}
              style={{ position: "absolute", top: 0, left: 0 }}
            >
              <CardView
                card={pair.attack}
                dimmed={!pair.defense && beatableAttackIds.includes(pair.attack.id)}
                onClick={
                  gs.phase === "defend" && amDefender && beatableAttackIds.includes(pair.attack.id)
                    ? () => handleTableAttackClick(pair.attack.id)
                    : undefined
                }
              />
            </div>
            {pair.defense && (
              <div style={{ position: "absolute", top: "14px", left: "22px" }}>
                <CardView card={pair.defense} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Статус и таймер */}
      <div style={{ marginBottom: "1rem", textAlign: "center" }}>
        <p style={{ color: "var(--text-secondary)" }}>{gs.lastAction}</p>
        <p style={{ marginTop: "0.5rem" }}>{phaseHint} — {gs.timeLeft ?? "—"} сек</p>
      </div>

      {/* Кнопки действий по фазе */}
      <div style={{ display: "flex", gap: "1rem", justifyContent: "center", marginBottom: "1rem" }}>
        {gs.phase === "defend" && amDefender && (
          <button
            onClick={() => send({ type: "take" })}
            disabled={unbeatenPairs.length === 0}
          >
            Забрать карты
          </button>
        )}
        {gs.phase === "throwIn" && isMyMove && (
          <button onClick={() => send({ type: "pass" })}>
            Пас
          </button>
        )}
      </div>

      {/* Рука игрока */}
      <div style={{
        background: "var(--bg-secondary)",
        padding: "2rem",
        borderRadius: "8px",
      }}>
        <h3 style={{ marginBottom: "1rem", textAlign: "center" }}>
          Твоя рука ({me.hand.length})
        </h3>
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", flexWrap: "wrap" }}>
          {me.hand.map(card => {
            const clickable =
              (gs.phase === "attack" && amAttacker) ||
              (gs.phase === "defend" && amDefender) ||
              (gs.phase === "throwIn" && isMyMove && throwCandidates.some(c => c.id === card.id));

            return (
              <CardView
                key={card.id}
                card={card}
                selected={card.id === selectedCardId}
                dimmed={!clickable}
                onClick={clickable ? () => handleCardClick(card) : undefined}
              />
            );
          })}
        </div>
      </div>

      {showExitConfirm && (
        <ConfirmModal
          title="Выход из игры"
          message="Вы уверены? Прогресс игры будет потерян"
          confirmText="Выйти"
          cancelText="Отмена"
          danger
          onConfirm={() => navigate("/lobby")}
          onCancel={() => setShowExitConfirm(false)}
        />
      )}
    </div>
  );
}
