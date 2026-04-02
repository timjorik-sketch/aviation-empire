const buttonStyle = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  font: 'inherit',
  color: '#000',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  textDecorationColor: 'rgba(0,0,0,0.4)',
};

const spanStyle = {
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  color: '#000',
  textDecorationColor: 'rgba(0,0,0,0.4)',
};

/**
 * Renders an airport as "Full Name (CODE)" where CODE is an underlined black clickable link.
 * If only code is provided (no name), renders just the CODE as a link.
 * Props: code (required), name (optional), onNavigate (optional callback)
 */
export default function AirportLink({ code, name, onNavigate }) {
  if (!code) return null;

  const codeEl = onNavigate ? (
    <button style={buttonStyle} onClick={(e) => { e.stopPropagation(); onNavigate(code); }}>
      {code}
    </button>
  ) : (
    <span style={spanStyle}>{code}</span>
  );

  if (name) {
    return <span>{name} ({codeEl})</span>;
  }
  return codeEl;
}
