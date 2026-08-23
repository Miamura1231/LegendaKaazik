import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { showToast } from "../components/Toast";

export function Login() {
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const { login, loading } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await login(nickname, password);

    const state = useAuthStore.getState();

    if (state.user) {
      showToast("success", `Добро пожаловать, ${state.user.nickname}!`);
      navigate("/lobby");
    } else if (state.error) {
      // Ошибка входа через toast вместо inline-блока
      showToast("error", state.error);
    }
  };

  return (
    <div className="container">
      <div className="card" style={{ maxWidth: "400px", margin: "4rem auto" }}>
        <h2>Вход</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Ник</label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="DragonM0LL"
              required
            />
          </div>
          <div className="form-group">
            <label>Пароль</label>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="18624"
              required
            />
          </div>
          <button type="submit" disabled={loading} style={{ width: "100%" }}>
            {loading ? "Вход..." : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}
