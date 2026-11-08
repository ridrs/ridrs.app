// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RouteOffer } from '@ridrs/contracts';
import { useEffect, useRef, useState } from 'react';
import type { Messages } from './i18n/index.ts';
import { type Climb, GRADES, gradeOf, stretchesOf } from './routes.ts';

/** px of the profile's own height, and of its margins for the scales. */
const PLOT = 200;
const LEFT = 52;
const RIGHT = 20;
const BOTTOM = 30;
/** px above the profile that one row of summit labels takes. */
const LABEL_ROW = 50;
/** px two summits need between them for their labels to share a row. */
const LABEL_WIDTH = 190;
/** The width the profile is drawn at until it is measured, e.g. in a test without layout. */
const FALLBACK_WIDTH = 960;

/**
 * The climb that fills the profile's height at least: 1.2 % over the whole route, so a mountain
 * pass fills it and a river path stays low. Gentler than the cards' 3 %: the details have the
 * room to show a long route's climbs.
 */
const FULL_HEIGHT_GRADE = 0.012;

const RED = '#d4202c';
const INK = 'var(--ridrs-text, #f2f5fa)';
const MUTED = 'var(--ridrs-text-muted, #93a1b8)';
const GRID = 'var(--ridrs-line, #24324d)';

/** The width of an element as it is laid out, following it. */
function useWidth() {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const measured = entry?.contentRect.width ?? 0;
      if (measured > 0) setWidth(Math.round(measured));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { box, width };
}

/** The m between two altitude lines: at most about 4 of them. */
const altitudeStep = (span: number) => [50, 100, 200, 250, 500, 1000].find((step) => span / step <= 4) ?? 1000;

/** The km between two labelled km ticks, for about one label per 90 px. */
const kmStep = (length: number, width: number) =>
  [1, 2, 5, 10, 20, 50].find((step) => length / 1000 / step <= width / 90) ?? 50;

/**
 * Which row each summit's label takes, from the top: the first row, unless the summit before it is
 * too close; then the next row, and so on.
 */
function labelRows(xs: readonly number[]): number[] {
  const lastInRow: number[] = [];
  return xs.map((x) => {
    let row = lastInRow.findIndex((last) => x - last >= LABEL_WIDTH);
    if (row < 0) row = lastInRow.length;
    lastInRow[row] = x;
    return row;
  });
}

/**
 * A summit: a line up from the profile to a red disc with the climb's category, beside it the
 * summit's name, or its altitude where it has none, and where it is. Near the right edge the
 * words stand left of the disc.
 */
function Summit({
  text,
  climb,
  x,
  y,
  labelY,
  flip,
}: {
  readonly text: Messages;
  readonly climb: Climb;
  readonly x: number;
  readonly y: number;
  readonly labelY: number;
  readonly flip: boolean;
}) {
  const altitude = text.metres(climb.summit);
  const textX = flip ? x - 20 : x + 20;
  const anchor = flip ? 'end' : 'start';
  return (
    <g className="summit">
      <line x1={x} x2={x} y1={y - 4} y2={labelY + 14} stroke={INK} strokeOpacity={0.55} strokeDasharray="2 3" />
      <circle cx={x} cy={y} r={3.5} fill={INK} />
      <circle cx={x} cy={labelY} r={13} fill={RED} stroke="#fff" strokeWidth={2} />
      <text
        className="badge"
        x={x}
        y={labelY + 4.5}
        textAnchor="middle"
        fontSize={climb.category === 'HC' ? 10 : 13}
        fontWeight={800}
        fill="#fff"
      >
        {climb.category}
      </text>
      <text x={textX} y={labelY - 2} textAnchor={anchor} fontSize={14} fontWeight={700} fill={INK}>
        {climb.name ?? altitude}
      </text>
      <text x={textX} y={labelY + 14} textAnchor={anchor} fontSize={12} fill={MUTED}>
        {climb.name ? `${altitude} · ${text.kmAt(text.km(climb.end))}` : text.kmAt(text.km(climb.end))}
      </text>
    </g>
  );
}

/**
 * The route's elevation profile, large: each stretch coloured by its gradient, each categorised
 * summit marked with its category and its name or altitude, an altitude and a km scale, and a
 * legend of the colours below. Drawn in px at the width it gets, so its words keep their size.
 */
export function RouteProfile({ offer, text }: { readonly offer: RouteOffer; readonly text: Messages }) {
  const { box, width } = useWidth();
  const stretches = stretchesOf(offer);
  if (stretches.length === 0) return null;
  const climbs = offer.climbs ?? [];
  const elevations = stretches.flatMap((stretch) => [stretch.low, stretch.high]);
  const low = Math.min(...elevations);
  const high = Math.max(...elevations);
  const floor = Math.floor((low - 20) / 50) * 50;
  const span = Math.max(high - floor, offer.distance * FULL_HEIGHT_GRADE, 60) * 1.06;

  const right = width - RIGHT;
  const x = (distance: number) => LEFT + (distance / Math.max(offer.distance, 1)) * (right - LEFT);
  const summitXs = climbs.map((climb) => x(climb.end));
  const rows = labelRows(summitXs);
  // The rows of summit labels above the profile, then the profile, then the km scale.
  const top = 16 + (rows.length ? Math.max(...rows) + 1 : 0) * LABEL_ROW;
  const base = top + PLOT;
  const height = base + BOTTOM;
  const y = (elevation: number) => base - ((elevation - floor) / span) * (base - top);

  const line = [
    `${x(0)},${y(stretches[0]?.low ?? 0)}`,
    ...stretches.map((stretch) => `${x(stretch.to)},${y(stretch.high)}`),
  ].join(' ');
  const step = altitudeStep(span);
  const altitudes = [];
  for (let altitude = Math.ceil(floor / step) * step; altitude <= floor + span; altitude += step) {
    altitudes.push(altitude);
  }
  const every = kmStep(offer.distance, right - LEFT);
  const kms = [];
  for (let mark = 0; mark * 1000 <= offer.distance - every * 400; mark += every) kms.push(mark);
  const shade = `shade-${offer.id.replace(/[^A-Za-z0-9-]/g, '-')}`;

  return (
    // The box takes the page's width and the drawing follows it, never the other way round: an SVG
    // of a fixed height would otherwise widen the box to its viewBox.
    <div ref={box} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, minWidth: 0 }}>
      <svg
        role="img"
        aria-label={text.profileOf(offer.title)}
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: 'block', maxWidth: '100%', overflow: 'visible', font: '12px system-ui, sans-serif' }}
      >
        <defs>
          <linearGradient id={shade} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0b1220" stopOpacity={0} />
            <stop offset="1" stopColor="#0b1220" stopOpacity={0.55} />
          </linearGradient>
        </defs>
        {altitudes.map((altitude) => (
          <g key={altitude}>
            <line x1={LEFT} x2={right} y1={y(altitude)} y2={y(altitude)} stroke={GRID} strokeDasharray="3 5" />
            <text x={LEFT - 8} y={y(altitude) + 4} textAnchor="end" fill={MUTED}>
              {altitude} m
            </text>
          </g>
        ))}
        {stretches.map((stretch) => {
          const band = gradeOf(stretch.trend);
          return (
            <polygon
              key={stretch.from}
              className="stretch"
              data-grade={band.label}
              points={`${x(stretch.from)},${base} ${x(stretch.from)},${y(stretch.low)} ${x(stretch.to)},${y(stretch.high)} ${x(stretch.to)},${base}`}
              fill={band.colour}
              stroke={band.colour}
              strokeWidth={0.6}
            />
          );
        })}
        <polygon points={`${x(0)},${base} ${line} ${right},${base}`} fill={`url(#${shade})`} />
        <polyline points={line} fill="none" stroke="#fff" strokeOpacity={0.9} strokeWidth={2} strokeLinejoin="round" />
        <line x1={LEFT} x2={right} y1={base} y2={base} stroke={MUTED} />
        {kms.map((mark) => (
          <g key={mark}>
            <line x1={x(mark * 1000)} x2={x(mark * 1000)} y1={base} y2={base + 5} stroke={MUTED} />
            <text x={x(mark * 1000)} y={base + 19} textAnchor="middle" fill={MUTED}>
              {mark}
            </text>
          </g>
        ))}
        <text x={right} y={base + 19} textAnchor="end" fontWeight={700} fill={INK}>
          {text.km(offer.distance)} km
        </text>
        {climbs.map((climb, i) => {
          const sx = summitXs[i] ?? 0;
          return (
            <Summit
              text={text}
              key={climb.end}
              climb={climb}
              x={sx}
              y={y(climb.summit)}
              labelY={24 + (rows[i] ?? 0) * LABEL_ROW}
              flip={sx > right - LABEL_WIDTH + 20}
            />
          );
        })}
      </svg>
      <ul className="legend" aria-label={text.gradients} style={LEGEND}>
        {GRADES.map((grade, index) => (
          <li key={grade.label} data-grade={grade.label} data-colour={grade.colour} style={LEGEND_ENTRY}>
            <span aria-hidden="true" style={{ ...SWATCH, background: grade.colour }} />
            {text.grades[index]}
          </li>
        ))}
      </ul>
    </div>
  );
}

const LEGEND = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px 16px',
  margin: 0,
  paddingLeft: LEFT,
  listStyle: 'none',
  color: MUTED,
  fontSize: 12,
} as const;
const LEGEND_ENTRY = { display: 'inline-flex', alignItems: 'center', gap: 6 } as const;
const SWATCH = { width: 14, height: 10, borderRadius: 2 } as const;
