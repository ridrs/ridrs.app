// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MetricReading } from '@ridrs/contracts';
import { describeMetricReading, formatDecimal } from '@ridrs/ui-sdk';
import { useId } from 'react';
import { angleOf, bandAt, type Scale, ticksOf } from './model.ts';

const C = 100;
const BAND_RADIUS = 84;
const BAND_WIDTH = 9;
const TICK_OUTER = 76;
const NEUTRAL = 'var(--ridrs-text)';

function point(radius: number, degrees: number): [number, number] {
  const rad = (degrees * Math.PI) / 180;
  return [C + radius * Math.cos(rad), C + radius * Math.sin(rad)];
}

/** A clockwise arc of `radius` from `from`° to `to`°. */
function arc(radius: number, from: number, to: number): string {
  const [x0, y0] = point(radius, from);
  const [x1, y1] = point(radius, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export interface GaugeProps {
  readonly kind: string;
  readonly label: string;
  readonly reading: MetricReading | undefined;
  readonly unit: string;
  readonly scale: Scale;
  readonly language: Parameters<typeof describeMetricReading>[1];
  /** The ride's average; absent: the gauge shows none. */
  readonly average?: { readonly label: string; readonly value: number | undefined };
  readonly zoneName: (zone: number) => string;
}

/**
 * One round dial, drawn like a ride card (the gradient, the light edge, the uppercase label): the
 * scale coloured by zone around a 240° sweep, a needle, the value and, for some, the average.
 */
export function Gauge({ kind, label, reading, unit, scale, language, average, zoneName }: GaugeProps) {
  const id = useId().replaceAll(':', '');
  const display = describeMetricReading(reading, language);
  const value = reading?.status === 'available' ? reading.value : undefined;
  const band = value === undefined ? undefined : bandAt(scale, value);
  const angle = angleOf(scale, value ?? scale.min);
  const accent = band?.colour ?? NEUTRAL;
  const averageText =
    average?.value === undefined ? '–' : formatDecimal(average.value, 0);
  const spoken = [
    `${label} ${display.text} ${unit}`,
    band ? `${zoneName(band.zone)}${band.name ? ` ${band.name}` : ''}` : undefined,
    average ? `${average.label} ${averageText} ${unit}` : undefined,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <section
      data-testid={`gauge-${kind}`}
      data-status={display.status}
      data-max={String(scale.max)}
      {...(band ? { 'data-zone': String(band.zone) } : {})}
      aria-label={spoken}
      style={{
        pointerEvents: 'auto',
        width: 'clamp(104px, 10vw, 160px)',
        aspectRatio: '1',
        borderRadius: '50%',
        boxShadow: '0 10px 28px rgb(0 0 0 / .38)',
        fontFamily: 'var(--ridrs-font-text)',
      }}
    >
      <svg viewBox="0 0 200 200" width="100%" height="100%" role="img" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-bg`} x1="0.25" y1="0" x2="0.75" y2="1">
            <stop offset="0" stopColor="var(--ridrs-card-top)" />
            <stop offset="1" stopColor="var(--ridrs-card-bottom)" />
          </linearGradient>
          <radialGradient id={`${id}-glow`} cx="0.85" cy="0" r="0.95">
            <stop offset="0" stopColor="var(--ridrs-card-glow)" />
            <stop offset="0.6" stopColor="var(--ridrs-card-glow)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}-shade`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="rgb(6 10 20)" stopOpacity="0.7" />
            <stop offset="0.45" stopColor="rgb(6 10 20)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* The card: gradient, glow from the top right, shade at the bottom, a light edge. */}
        <circle cx={C} cy={C} r={99} fill={`url(#${id}-bg)`} />
        <circle cx={C} cy={C} r={99} fill={`url(#${id}-glow)`} />
        <circle cx={C} cy={C} r={99} fill={`url(#${id}-shade)`} />
        <circle cx={C} cy={C} r={98.5} fill="none" stroke="var(--ridrs-line)" strokeWidth={1} />

        {/* The scale: a track, the zones on it, the ticks and their numbers. */}
        <path
          d={arc(BAND_RADIUS, angleOf(scale, scale.min), angleOf(scale, scale.max))}
          fill="none"
          stroke="rgb(255 255 255 / .1)"
          strokeWidth={BAND_WIDTH}
        />
        {scale.bands.map((item) => (
          <path
            key={item.zone}
            data-zone-band=""
            data-zone={String(item.zone)}
            data-from={String(item.from)}
            data-to={String(item.to)}
            d={arc(BAND_RADIUS, angleOf(scale, item.from), angleOf(scale, item.to))}
            fill="none"
            stroke={item.colour}
            strokeWidth={BAND_WIDTH}
            opacity={band === undefined || band.zone === item.zone ? 1 : 0.42}
          >
            <title>{`${zoneName(item.zone)}${item.name ? ` · ${item.name}` : ''}`}</title>
          </path>
        ))}
        {ticksOf(scale).map((tick) => {
          const at = angleOf(scale, tick.value);
          const [x0, y0] = point(TICK_OUTER, at);
          const [x1, y1] = point(TICK_OUTER - (tick.major ? 9 : 4), at);
          return (
            <line
              key={tick.value}
              x1={x0}
              y1={y0}
              x2={x1}
              y2={y1}
              stroke={tick.major ? 'rgb(255 255 255 / .85)' : 'rgb(255 255 255 / .38)'}
              strokeWidth={tick.major ? 2 : 1}
              strokeLinecap="round"
            />
          );
        })}
        {ticksOf(scale)
          .filter((tick) => tick.major)
          .map((tick) => {
            const [x, y] = point(56, angleOf(scale, tick.value));
            return (
              <text
                key={tick.value}
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={tick.value >= 1000 ? 9 : 11}
                fontWeight={500}
                fill="rgb(255 255 255 / .62)"
              >
                {tick.value}
              </text>
            );
          })}

        <text
          x={C}
          y={124}
          textAnchor="middle"
          fontSize={9}
          fontWeight={500}
          letterSpacing="1.4"
          fill="var(--ridrs-text)"
          opacity={0.9}
          style={{ textTransform: 'uppercase' }}
        >
          {label}
        </text>

        {/* The needle, swinging with a slight overshoot like a real one; resting while unavailable. */}
        <g
          style={{
            transform: `rotate(${angle}deg)`,
            transformOrigin: `${C}px ${C}px`,
            transition: 'transform .45s cubic-bezier(.3, 1.35, .55, 1)',
          }}
          opacity={value === undefined ? 0.35 : 1}
        >
          <polygon
            points={`${C - 14},${C - 3.2} ${C + 80},${C - 0.9} ${C + 80},${C + 0.9} ${C - 14},${C + 3.2}`}
            fill={accent}
            style={{ filter: `drop-shadow(0 0 3px ${accent})` }}
          />
        </g>
        <circle cx={C} cy={C} r={8} fill="var(--ridrs-surface)" stroke="rgb(255 255 255 / .35)" strokeWidth={1.5} />
        <circle cx={C} cy={C} r={3} fill={accent} />

        <text x={C} y={156} textAnchor="middle" fill="var(--ridrs-text)" style={{ textShadow: '0 1px 6px rgb(0 0 0 / .5)' }}>
          <tspan data-testid="value" fontSize={30} fontWeight={500}>
            {display.text}
          </tspan>
          <tspan dx={3} data-testid="unit" fontSize={12} fontWeight={500} fill="rgb(255 255 255 / .82)">
            {unit}
          </tspan>
        </text>
        {display.reason !== undefined ? (
          <text
            data-testid="reason"
            x={C}
            y={176}
            textAnchor="middle"
            fontSize={11}
            fill="rgb(255 255 255 / .7)"
          >
            {display.reason}
          </text>
        ) : average ? (
          <text x={C} y={176} textAnchor="middle" fontSize={12} fill="rgb(255 255 255 / .82)">
            <tspan fontSize={11} fontWeight={500} letterSpacing="1" fill="var(--ridrs-info)">
              {average.label.toUpperCase()}
            </tspan>
            <tspan dx={4} data-testid="average" fontWeight={500}>
              {averageText}
            </tspan>
          </text>
        ) : null}
      </svg>
    </section>
  );
}
