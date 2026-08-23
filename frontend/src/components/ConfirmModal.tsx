interface ConfirmModalProps {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  // Красная кнопка подтверждения для опасных действий
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmText = "Подтвердить",
  cancelText = "Отмена",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      {/* stopPropagation — чтобы клик внутри окна не закрывал его */}
      <div className="modal card" onClick={e => e.stopPropagation()}>
        <h3>{title}</h3>
        <p style={{ marginTop: "0.75rem", color: "var(--text-secondary)" }}>
          {message}
        </p>
        <div className="modal-actions">
          <button onClick={onCancel}>{cancelText}</button>
          <button className={danger ? "btn-danger" : undefined} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
