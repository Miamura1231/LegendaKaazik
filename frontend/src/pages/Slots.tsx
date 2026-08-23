import { useState } from "react";
import type { FormEvent } from "react";
import { apiSlotsSpin } from "../api/client";
import { useAuthStore } from "../store/authStore";
import { showToast } from "../components/Toast";

// Минимальная ставка (валидация дублируется на сервере)
const MIN_BET = 10;

export function Slots() {
  const { user, setBalance } = useAuthStore();
  const [betText, setBetText] = useState(String(MIN_BET));
  const [spinning, setSpinning] = useState(false);
  // Последний результат прокрутки для визуализации
  const [reels, setReels] = useState<string[] | null>(null);
  const [lastWin, setLastWin] = useState<number | null>(null);

  if (!user) return <div className="loading">Загрузка...</div>;

  const bet = Number(betText);
  // Ставка: целое число от MIN_BET до текущего баланса
  const betValid = Number.isInteger(bet) && bet >= MIN_BET && bet <= user.balance;

  const handleSpin = async (e: FormEvent) => {
    e.preventDefault();

    if (!betValid) {
      showToast("error", `Ставка — целое число от ${MIN_BET} до ${user.balance}`);
      return;
    }

    setSpinning(true);
    try {
      const response = await apiSlotsSpin(bet);

      if (response.ok && response.reels) {
        setReels(response.reels);
        setLastWin(response.winAmount ?? 0);

        // Баланс считает сервер — обновляем локальную копию из ответа
        if (typeof response.newBalance === "number") {
          setBalance(response.newBalance);
        }

        if ((response.winAmount ?? 0) > 0) {
          showToast("success", `Выигрыш: ${response.winAmount}$`);
        } else {
          showToast("info", "Не повезло — попробуй ещё раз");
        }
      } else {
        showToast("error", response.error || "Не удалось крутить");
      }
    } finally {
      setSpinning(false);
    }
  };

  return (
    <div className="container">
      <div className="card" style={{ maxWidth: "520px", margin: "2rem auto", textAlign: "center" }}>
        <h2>Слоты</h2>
        <p style={{ color: "var(--text-secondary)", marginTop: "0.5rem" }}>
          3 одинаковых — x10, 2 одинаковых — x2
        </p>

        {/* Барабаны */}
        <div style={{
          display: "flex",
          justifyContent: "center",
          gap: "1rem",
          margin: "2rem 0",
        }}>
          {(reels ?? ["❔", "❔", "❔"]).map((symbol, index) => (
            <div
              key={index}
              style={{
                width: "90px",
                height: "110px",
                background: "var(--bg-primary)",
                border: "2px solid var(--bg-tertiary)",
                borderRadius: "8px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "2.5rem",
              }}
            >
              {symbol}
            </div>
          ))}
        </div>

        {/* Результат последней прокрутки */}
        {lastWin !== null && (
          <p style={{ marginBottom: "1rem" }}>
            {lastWin > 0 ? (
              <span style={{ color: "var(--success)", fontWeight: "bold" }}>
                Выигрыш: {lastWin}$
              </span>
            ) : (
              <span style={{ color: "var(--error)" }}>Проигрыш</span>
            )}
          </p>
        )}

        <form onSubmit={handleSpin}>
          <div className="form-group" style={{ maxWidth: "240px", margin: "0 auto 1rem" }}>
            <label>Ставка (баланс: {user.balance}$)</label>
            <input
              type="number"
              value={betText}
              min={MIN_BET}
              max={user.balance}
              onChange={e => setBetText(e.target.value)}
            />
          </div>
          <button type="submit" disabled={spinning || !betValid}>
            {spinning ? "Кручение..." : "Крутить"}
          </button>
        </form>
      </div>
    </div>
  );
}
