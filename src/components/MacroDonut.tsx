import React from 'react';

/**
 * Donut des macros (part des calories) : protéines / glucides / lipides.
 * Pur SVG, sans dépendance. kcal : P×4, G×4, L×9.
 */
const SEGS = [
  { key: 'protein', label: 'Protéines', color: '#428cff' },
  { key: 'carbs', label: 'Glucides', color: '#ffb340' },
  { key: 'fat', label: 'Lipides', color: '#ff6473' },
] as const;

const MacroDonut: React.FC<{
  protein: number;
  carbs: number;
  fat: number;
  kcal?: number;
  size?: number;
}> = ({ protein, carbs, fat, kcal, size = 120 }) => {
  const vals = { protein: Math.max(0, protein), carbs: Math.max(0, carbs), fat: Math.max(0, fat) };
  const kcalVals = { protein: vals.protein * 4, carbs: vals.carbs * 4, fat: vals.fat * 9 };
  const total = kcalVals.protein + kcalVals.carbs + kcalVals.fat;
  const R = 44;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const shownKcal = kcal !== undefined ? Math.round(kcal) : Math.round(total);

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <svg width={size} height={size} viewBox="0 0 120 120" style={{ flexShrink: 0 }}>
        <circle cx="60" cy="60" r={R} fill="none" strokeWidth="16" stroke="var(--app-border, #e5e7eb)" />
        {total > 0 &&
          SEGS.map((s) => {
            const frac = kcalVals[s.key] / total;
            if (frac <= 0) return null;
            const startDeg = acc * 360 - 90;
            acc += frac;
            return (
              <circle
                key={s.key}
                cx="60"
                cy="60"
                r={R}
                fill="none"
                stroke={s.color}
                strokeWidth="16"
                strokeDasharray={`${Math.max(0, frac * C - 2)} ${C}`}
                transform={`rotate(${startDeg} 60 60)`}
              />
            );
          })}
        <text x="60" y="58" textAnchor="middle" fontSize="17" fontWeight="800" fill="currentColor">
          {shownKcal}
        </text>
        <text x="60" y="74" textAnchor="middle" fontSize="11" fill="currentColor" opacity="0.65">
          kcal
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
        {SEGS.map((s) => {
          const g = Math.round(vals[s.key]);
          const k = Math.round(kcalVals[s.key]);
          const pct = total > 0 ? Math.round((kcalVals[s.key] / total) * 100) : 0;
          return (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
              <span>
                {s.label} : <b>{g} g</b> <span style={{ opacity: 0.65 }}>· {k} kcal ({pct} %)</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MacroDonut;
