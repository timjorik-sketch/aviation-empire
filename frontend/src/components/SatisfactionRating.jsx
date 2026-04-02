export function scoreToRating(score) {
  if (score == null) return null;
  if (score >= 85) return 5.0;
  if (score >= 70) return 4.5;
  if (score >= 55) return 4.0;
  if (score >= 40) return 3.5;
  if (score >= 25) return 3.0;
  if (score >= 15) return 2.5;
  if (score >= 10) return 2.0;
  if (score >= 5)  return 1.5;
  if (score >= 1)  return 1.0;
  return 0.5;
}

export function getSatColor(score) {
  if (score == null) return '#999';
  if (score >= 85) return '#16a34a';
  if (score >= 70) return '#65a30d';
  if (score >= 55) return '#ca8a04';
  if (score >= 40) return '#ea580c';
  return '#dc2626';
}

// 5 SVG circles: full / left-half / empty. size = diameter per circle (px).
export default function SatisfactionRating({ score, size = 14, hideLabel = false }) {
  if (score == null) return null;
  const rating = scoreToRating(score);
  const color  = 'currentColor';
  const gap    = 3;
  const r      = (size - 2) / 2; // 1 px stroke room each side
  const cy     = size / 2;
  const totalW = 5 * size + 4 * gap;

  const types = [];
  for (let i = 1; i <= 5; i++) {
    const fill = Math.max(0, Math.min(1, rating - (i - 1)));
    types.push(fill >= 1 ? 'full' : fill >= 0.5 ? 'half' : 'empty');
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, lineHeight: 1 }}>
      <svg
        width={totalW}
        height={size}
        viewBox={`0 0 ${totalW} ${size}`}
        style={{ display: 'block', flexShrink: 0 }}
      >
        {types.map((type, i) => {
          const cx = i * (size + gap) + size / 2;
          if (type === 'full') {
            return <circle key={i} cx={cx} cy={cy} r={r} fill={color} />;
          }
          if (type === 'half') {
            // Left-half arc: top → counterclockwise → bottom, then close
            return (
              <g key={i}>
                <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={1.5} />
                <path
                  d={`M ${cx} ${cy - r} A ${r} ${r} 0 0 0 ${cx} ${cy + r} Z`}
                  fill={color}
                />
              </g>
            );
          }
          return (
            <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={1.5} />
          );
        })}
      </svg>
      {!hideLabel && (
        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'currentColor', lineHeight: 1 }}>
          {rating.toFixed(1)}
        </span>
      )}
    </span>
  );
}
