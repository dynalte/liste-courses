import React from 'react';

export interface DayPoint {
  day: string;
  label: string;
  kcal: number;
  avg: number;
}

/**
 * Graphique mixte : barres = kcal, courbe = note moyenne /100.
 * Pur SVG, sans dépendance. Clic sur un jour → onSelect(day).
 */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function scoreColor(avg: number): string {
  if (avg >= 75) return '#2dd36f';
  if (avg >= 50) return '#ffc409';
  return '#eb445a';
}

const DietChart: React.FC<{
  points: DayPoint[];
  selDay?: string;
  onSelect?: (day: string) => void;
}> = ({ points, selDay, onSelect }) => {
  const W = 340;
  const H = 200;
  const M = { l: 34, r: 30, t: 12, b: 24 };
  const plotW = W - M.l - M.r;
  const plotH = H - M.t - M.b;
  const maxKcal = Math.max(500, ...points.map((p) => p.kcal));
  const yMax = Math.ceil(maxKcal / 500) * 500;
  const n = Math.max(1, points.length);
  const slot = plotW / n;
  const barW = Math.min(26, slot * 0.52);

  const x = (i: number) => M.l + slot * i + slot / 2;
  const yKcal = (k: number) => M.t + plotH * (1 - Math.min(1, k / yMax));
  const yScore = (s: number) => M.t + plotH * (1 - Math.min(100, Math.max(0, s)) / 100);

  const linePts = points.map((p, i) => ({ x: x(i), y: yScore(p.avg) }));
  const showLabels = n <= 10;
  const every = Math.max(1, Math.ceil(n / 8));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
      {/* grille + axe kcal */}
      {[0, 0.5, 1].map((f) => {
        const y = M.t + plotH * (1 - f);
        return (
          <g key={f}>
            <line x1={M.l} y1={y} x2={W - M.r} y2={y} stroke="currentColor" opacity="0.15" strokeWidth="1" />
            <text x={M.l - 4} y={y + 3} textAnchor="end" fontSize="9" fill="currentColor" opacity="0.6">
              {Math.round(yMax * f)}
            </text>
          </g>
        );
      })}
      {/* axe score */}
      {[0, 50, 100].map((s) => (
        <text key={s} x={W - M.r + 4} y={yScore(s) + 3} fontSize="9" fill="currentColor" opacity="0.6">
          {s}
        </text>
      ))}
      {/* barres kcal */}
      {points.map((p, i) => {
        const h = Math.max(2, M.t + plotH - yKcal(p.kcal));
        const sel = p.day === selDay;
        return (
          <g key={p.day} onClick={() => onSelect?.(p.day)} style={onSelect ? { cursor: 'pointer' } : undefined}>
            <rect
              x={x(i) - barW / 2}
              y={M.t + plotH - h}
              width={barW}
              height={h}
              rx={Math.min(5, barW / 3)}
              fill="var(--ion-color-primary, #3880ff)"
              opacity={sel ? 1 : 0.45}
            />
            {showLabels && (
              <text x={x(i)} y={M.t + plotH - h - 4} textAnchor="middle" fontSize="9" fill="currentColor" opacity="0.8">
                {Math.round(p.kcal)}
              </text>
            )}
          </g>
        );
      })}
      {/* courbe note moyenne */}
      {points.length > 0 && (
        <>
          <path d={smoothPath(linePts)} fill="none" stroke="#ff6473" strokeWidth="2.5" strokeLinecap="round" />
          {points.map((p, i) => (
            <g key={`d${p.day}`}>
              <circle cx={x(i)} cy={yScore(p.avg)} r={p.day === selDay ? 5 : 3.5} fill={scoreColor(p.avg)} stroke="var(--ion-background-color, #fff)" strokeWidth="1.5" />
              {showLabels && (
                <text x={x(i)} y={yScore(p.avg) - 9} textAnchor="middle" fontSize="10" fontWeight="700" fill={scoreColor(p.avg)}>
                  {p.avg}
                </text>
              )}
            </g>
          ))}
        </>
      )}
      {/* abscisses */}
      {points.map((p, i) =>
        i % every === 0 || i === n - 1 ? (
          <text key={`x${p.day}`} x={x(i)} y={H - 6} textAnchor="middle" fontSize="9" fill="currentColor" opacity="0.6">
            {p.label}
          </text>
        ) : null,
      )}
    </svg>
  );
};

export default DietChart;
