import { create } from "zustand";
import { apiLogin, apiMe, apiLogout, setToken, clearToken, getToken } from "../api/client";
import type { User } from "../api/types";

type AuthState = {
  user: User | null;
  loading: boolean;
  error: string | null;
  login: (nickname: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  // Точечное обновление баланса (например, после прокрутки слотов),
  // чтобы не перезапрашивать весь профиль
  setBalance: (balance: number) => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  error: null,

  login: async (nickname, password) => {
    set({ loading: true, error: null });
    const response = await apiLogin(nickname, password);

    if (response.ok && response.token && response.user) {
      setToken(response.token);
      set({ user: response.user, loading: false });
    } else {
      set({ error: response.error || "Ошибка входа", loading: false });
    }
  },

  logout: async () => {
    await apiLogout();
    clearToken();
    set({ user: null });
  },

  checkSession: async () => {
    // Если токена нет — сразу считаем сессию отсутствующей,
    // чтобы не отправлять заведомо неавторизованный запрос
    if (!getToken()) {
      set({ user: null, loading: false });
      return;
    }

    const response = await apiMe();

    if (response.ok && response.user) {
      set({ user: response.user, loading: false });
    } else {
      clearToken();
      set({ user: null, loading: false });
    }
  },

  setBalance: (balance) =>
    set(state => ({
      user: state.user ? { ...state.user, balance } : null,
    })),
}));
