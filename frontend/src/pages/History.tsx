import { useEffect, useState } from "react";
import { apiHistory } from "../api/client";
import { useAuthStore } from "../store/authStore";
import type { HistoryEntry } from "../api/types";

export function History() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuthStore();

  const load = async () => {
    setLoading(true);

    const response = await apiHistory();

    if (response.ok && Array.isArray(response.history)) {
      setHistory(response.history);
      setError(null);
    } else {
      setError(response.error || "Не удалось загрузить историю игр");
    }

    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) return <div className="loading">Загрузка истории...</div>;

  return (
    <div className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>История игр</h2>
        <button onClick={load}>Обновить</button>
      </div>

      {error && <div className="error" style={{ marginBottom: "1rem" }}>{error}</div>}

      {history.length === 0 ? (
        <div className="card">
          <p style={{ color: "var(--text-secondary)" }}>Пока нет сыгранных игр.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: "1rem" }}>
          <table className="history-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Победитель</th>
                <th>Игроки</th>
                <th>Дата</th>
                <th>Длительность</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry, index) => (
                <tr key={entry.id}>
                  <td>{index + 1}</td>
                  <td
                    style={
                      entry.winner === user?.nickname
                        ? { color: "var(--success)", fontWeight: "bold" }
                        : undefined
                    }
                  >
                    {entry.winner}
                  </td>
                  <td>{entry.players.join(", ")}</td>
                  <td>{new Date(entry.date).toLocaleString("ru-RU")}</td>
                  <td>{entry.durationSec} сек</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
