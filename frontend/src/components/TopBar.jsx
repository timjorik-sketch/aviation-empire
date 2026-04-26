
const styles = {
  bar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
    flexWrap: 'wrap',
    gap: '1rem',
  },
  btn: {
    background: '#2C2C2C',
    color: 'white',
    border: 'none',
    padding: '0.75rem 1.5rem',
    borderRadius: '6px',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    transition: 'opacity 0.2s',
  },
  arrow:         { fontSize: '1.25rem' },
  balance:       { background: 'white', padding: '0.75rem 1.5rem', borderRadius: '6px', color: '#2C2C2C', border: '1px solid #E0E0E0' },
  balanceLabel:  { marginRight: '0.5rem', color: '#666666' },
  balanceAmount: { fontWeight: 700, fontSize: '1.1rem', fontVariantNumeric: 'tabular-nums' },
};

export default function TopBar({ onBack, balance, backLabel = 'Dashboard' }) {
  return (
    <div style={styles.bar}>
      <button
        onClick={onBack}
        style={styles.btn}
        onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
        onMouseLeave={e => e.currentTarget.style.opacity = '1'}
      >
        <span style={styles.arrow}>←</span>
        {backLabel}
      </button>
      {balance != null && (
        <div style={styles.balance}>
          <span style={styles.balanceLabel}>Balance:</span>
          <span style={styles.balanceAmount}>${balance.toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}
