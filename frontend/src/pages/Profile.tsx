import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { ConfirmModal } from "../components/ConfirmModal";

export function Profile() {
  const { user, logout, checkSession } = useAuthStore();
  const navigate = useNavigate();
  // Подтверждение выхода из аккаунта
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // Обновляем профиль при входе на страницу,
  // чтобы статистика была актуальной после сыгранных игр
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const handleLogout = async () => {
    setShowLogoutConfirm(false);
    await logout();
    navigate("/login");
  };

  if (!user) return <div className="loading">Загрузка...</div>;

  const stats = user.stats;

  return (
    <div className="container">
      <div className="card" style={{ maxWidth: "600px", margin: "2rem auto" }}>
        <h2>Профиль</h2>
        <div style={{ marginTop: "1rem" }}>
          <p><strong>Ник:</strong> {user.nickname}</p>
          <p><strong>Баланс:</strong> <span className="balance">{user.balance}$</span></p>
          <p><strong>Создан:</strong> {new Date(user.createdAt).toLocaleString("ru-RU")}</p>
          {user.lastPaymentAt && (
            <p><strong>Последнее пополнение:</strong> {new Date(user.lastPaymentAt).toLocaleString("ru-RU")}</p>
          )}
        </div>

        {stats && (
          <>
            <h3 style={{ marginTop: "2rem", marginBottom: "1rem" }}>Статистика</h3>
            <div className="stats-grid">
              <div className="stat-box">
                <div className="stat-value">{stats.gamesPlayed}</div>
                <div>Игр сыграно</div>
              </div>
              <div className="stat-box">
                <div className="stat-value" style={{ color: "var(--success)" }}>{stats.wins}</div>
                <div>Победы</div>
              </div>
              <div className="stat-box">
                <div className="stat-value" style={{ color: "var(--error)" }}>{stats.losses}</div>
                <div>Поражения</div>
              </div>
            </div>
          </>
        )}

        {/* Выход из аккаунта — опасное действие: красная кнопка
            с подтверждением через модальное окно */}
        <button
          className="btn-danger"
          onClick={() => setShowLogoutConfirm(true)}
          style={{ marginTop: "2rem" }}
        >
          Выйти из аккаунта
        </button>
      </div>

      {showLogoutConfirm && (
        <ConfirmModal
          title="Выход из аккаунта"
          message="Вы уверены, что хотите выйти из аккаунта?"
          confirmText="Выйти"
          cancelText="Отмена"
          danger
          onConfirm={handleLogout}
          onCancel={() => setShowLogoutConfirm(false)}
        />
      )}
    </div>
  );
}
