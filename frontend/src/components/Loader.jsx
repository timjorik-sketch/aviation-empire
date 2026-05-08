export default function Loader({ fullPage = false, size, message }) {
  const logoSize = size ?? (fullPage ? 96 : 56);
  return (
    <div className={`loader ${fullPage ? 'loader--full' : 'loader--inline'}`}>
      <style>{`
        .loader {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 14px;
        }
        .loader--full { min-height: 70vh; padding: 48px 16px; }
        .loader--inline { padding: 32px 16px; }
        .loader__logo {
          height: ${logoSize}px;
          width: auto;
          animation: loader-pulse 1.4s ease-in-out infinite;
        }
        .loader__msg {
          color: #666;
          font-size: 0.85rem;
          margin: 0;
          letter-spacing: 0.02em;
        }
        @keyframes loader-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.4; transform: scale(0.92); }
        }
      `}</style>
      <img src="/logo/logo_black.png" alt="Loading" className="loader__logo" />
      {message && <p className="loader__msg">{message}</p>}
    </div>
  );
}
