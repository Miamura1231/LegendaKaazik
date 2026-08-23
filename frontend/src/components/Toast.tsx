import { create } from "zustand";

export type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastStore {
  toasts: ToastItem[];
  show: (type: ToastType, message: string) => void;
  hide: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  show: (type, message) => {
    const id = nextId++;
    set(prev => ({ toasts: [...prev.toasts, { id, type, message }] }));

    // Автоскрытие через 3 секунды
    window.setTimeout(() => get().hide(id), 3000);
  },

  hide: id =>
    set(prev => ({ toasts: prev.toasts.filter(t => t.id !== id) })),
}));

// Императивный вызов без хуков — удобно из обработчиков событий
export function showToast(type: ToastType, message: string): void {
  useToastStore.getState().show(type, message);
}

// Контейнер монтируется один раз в App и рендерит все активные уведомления
export function ToastContainer() {
  const toasts = useToastStore(state => state.toasts);
  const hide = useToastStore(state => state.hide);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`toast toast-${toast.type}`}
          onClick={() => hide(toast.id)}
          role="status"
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
