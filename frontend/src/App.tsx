import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect } from "react";
import { Navbar } from "./components/Navbar.tsx";
import { Login } from "./pages/Login";
import { Profile } from "./pages/Profile";
import { Lobby } from "./pages/Lobby";
import { GameTable } from "./pages/GameTable";
import { History } from "./pages/History";
import { Slots } from "./pages/Slots";
import { ToastContainer } from "./components/Toast";
import { useAuthStore } from "./store/authStore";

function App() {
  const { user, loading, checkSession } = useAuthStore();

  useEffect(() => {
    checkSession();
  }, []);

  if (loading) {
    return <div className="loading">Загрузка...</div>;
  }

  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        <Route
          path="/login"
          element={user ? <Navigate to="/lobby" /> : <Login />}
        />
        <Route
          path="/profile"
          element={user ? <Profile /> : <Navigate to="/login" />}
        />
        <Route
          path="/lobby"
          element={user ? <Lobby /> : <Navigate to="/login" />}
        />
        <Route
          path="/game/:tableId"
          element={user ? <GameTable /> : <Navigate to="/login" />}
        />
        <Route
          path="/history"
          element={user ? <History /> : <Navigate to="/login" />}
        />
        {/* Слоты — соло-игра, комнаты и WebSocket не используются */}
        <Route
          path="/slots"
          element={user ? <Slots /> : <Navigate to="/login" />}
        />
        <Route
          path="/"
          element={<Navigate to={user ? "/lobby" : "/login"} />}
        />
      </Routes>
      {/* Глобальный контейнер уведомлений — монтируется один раз */}
      <ToastContainer />
    </BrowserRouter>
  );
}

export default App;
