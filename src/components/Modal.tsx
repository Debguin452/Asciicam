interface ExtraAction { label: string; onClick: () => void; danger?: boolean; }

interface ModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  extraAction?: ExtraAction;
}

export default function Modal({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", onConfirm, onCancel, danger, extraAction }: ModalProps) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <div className="modal-message">{message}</div>
        <div className="modal-actions">
          {extraAction && (
            <button className={`btn ${extraAction.danger ? "btn-danger" : "btn-ghost"}`} onClick={extraAction.onClick}>
              {extraAction.label}
            </button>
          )}
          <button className="btn btn-ghost" onClick={onCancel}>{cancelLabel}</button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
