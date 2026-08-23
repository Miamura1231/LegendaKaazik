import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";

export function Navbar() {
  const { user } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();

  // Кнопка "Назад" видна только на странице игрового стола
  const isOnGameTable = /^\/game\/.+/.test(location.pathname);

  return (
    <nav className="navbar">
      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        {isOnGameTable && (
          <button
            onClick={() => navigate("/lobby")}
            style={{ padding: "0.4rem 0.9rem" }}
          >
            ← Назад
          </button>
        )}
        <Link to="/" className="navbar-brand">
          Card Games
        </Link>
      </div>
      <div className="navbar-links">
        {user ? (
          <>
            <Link to="/profile">Профиль</Link>
            <Link to="/lobby">Лобби</Link>
            <Link to="/slots">Слоты</Link>
            <Link to="/history">История</Link>
            <span>Баланс: <span className="balance">{user.balance}$</span></span>
            {/* Кнопка выхода из аккаунта находится в профиле */}
          </>
        ) : (
          <Link to="/login">Вход</Link>
        )}
      </div>
    </nav>
  );
}
