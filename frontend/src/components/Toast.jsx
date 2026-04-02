import { useEffect } from 'react';

function ToastItem({ message, type, onClose, duration }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onClose, duration);
    return () => clearTimeout(t);
  }, [message]);

  if (!message) return null;

  const icons = { success: '✓', error: '✕', warning: '⚠' };

  return (
    <div className={`toast-item toast-item--${type}`}>
      <span className="toast-icon">{icons[type] || '•'}</span>
      <span className="toast-text">{message}</span>
      <button className="toast-close" onClick={onClose}>×</button>
    </div>
  );
}

export default function Toast({
  error, onClearError,
  success, onClearSuccess,
  duration = 4500,
}) {
  if (!error && !success) return null;
  return (
    <div className="toast-stack">
      {success && <ToastItem message={success} type="success" onClose={onClearSuccess ?? (() => {})} duration={duration} />}
      {error   && <ToastItem message={error}   type="error"   onClose={onClearError  ?? (() => {})} duration={duration} />}
    </div>
  );
}
