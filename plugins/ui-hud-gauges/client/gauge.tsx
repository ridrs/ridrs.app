// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MetricReading } from '@ridrs/contracts';
import { describeMetricReading, formatDecimal } from '@ridrs/ui-sdk';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createHdrLayer, HDR_MARGIN, type HdrLayer } from './hdr-layer.ts';
import { angleOf, bandAt, dimmed, type Scale, ticksOf, vivid } from './model.ts';

/** The dial is drawn on 200 × 200 units, its centre at (C, C). */
const C = 100;
const ARC_RADIUS = 90.7;
const ARC_WIDTH = 7.3;
/** The part of the scale not lit yet: a thinner track along the middle of the lit one. */
const TRACK_WIDTH = 3.3;
const TICK_OUTER = 85.3;
const TICK_INNER_MAJOR = 77.3;
const TICK_INNER_MINOR = 80.7;
const TICK_LABEL = 66.7;
/** The scale's colour without zones (no FTP, say). */
const NEUTRAL = '#38bdf8';

/** Red and white beyond sRGB, for the FTP, the average and the value. */
const FTP_RED = 'color(display-p3 1 0.1 0.1)';
const WHITE = 'color(display-p3 1 1 1)';
/** Solid greys for what is read less often: minor ticks, captions, the unit. */
const GREY_LIGHT = 'rgb(226 232 240)';
const GREY = 'rgb(203 213 225)';
const GREY_DARK = 'rgb(148 163 184)';
/** The outline that keeps a mark apart from the scale under it. */
const OUTLINE = '#0b1220';

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

/** Turns what is drawn pointing up from the centre to `angle`° on the scale. */
function towards(angle: number): string {
  return `rotate(${(angle + 90).toFixed(2)} ${C} ${C})`;
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
  /** The FTP, marked on the scale; absent: no mark. */
  readonly ftp?: number | undefined;
  /**
   * The virtual gear, shown at the bottom in place of an average and focusable: Up and Down on it
   * shift. Absent: no gear.
   */
  readonly gear?: {
    readonly label: string;
    readonly text: string;
    readonly index: number;
    readonly count: number;
    readonly onShift: (change: 'up' | 'down') => void;
  };
  readonly zoneName: (zone: number) => string;
}

/**
 * One round dial of translucent glass, without a needle: the zones as a thin dimmed track around a
 * 250° sweep, lit up to the current value, the value large at the centre with the unit below it
 * and, for some, the average at the bottom. The average and the FTP are also marked on the scale:
 * a white triangle outside it, a red line across it with a red triangle inside. The glass lets the
 * scenery through; nothing drawn on it does. The lit colours are Display P3 at full brightness and,
 * on an HDR screen, the whole drawing goes beyond SDR white (`hdr-layer.ts`). The metric's name is spoken, not drawn. A gauge
 * without an average may show the virtual gear in its place, a control of its own.
 */
export function Gauge({
  kind,
  label,
  reading,
  unit,
  scale,
  language,
  average,
  ftp,
  gear,
  zoneName,
}: GaugeProps) {
  const [gearFocused, setGearFocused] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hdr, setHdr] = useState<HdrLayer>();
  const display = describeMetricReading(reading, language);
  const value = reading?.status === 'available' ? reading.value : undefined;
  const band = value === undefined ? undefined : bandAt(scale, value);
  const start = angleOf(scale, scale.min);
  const angle = angleOf(scale, value ?? scale.min);
  const accent = vivid(band?.colour ?? NEUTRAL);
  const averageValue = average?.value === undefined ? undefined : Math.round(average.value);
  const averageText = averageValue === undefined ? '–' : formatDecimal(averageValue, 0);
  const lit = value !== undefined && angle - start > 0.5;
  const spoken = [
    `${label} ${display.text} ${unit}`,
    band ? `${zoneName(band.zone)}${band.name ? ` ${band.name}` : ''}` : undefined,
    average ? `${average.label} ${averageText} ${unit}` : undefined,
  ]
    .filter(Boolean)
    .join(', ');

  useEffect(() => {
    const element = canvas.current;
    if (!element) {
      return undefined;
    }
    let layer: HdrLayer | undefined;
    let gone = false;
    void createHdrLayer(element).then((created) => {
      if (gone) {
        created?.destroy();
        return;
      }
      layer = created;
      setHdr(created);
    });
    return () => {
      gone = true;
      layer?.destroy();
    };
  }, []);

  // Every render the HDR canvas draws the dial again; the latest drawing wins.
  useLayoutEffect(() => {
    if (hdr && svg.current) {
      hdr.draw(svg.current);
    }
  });

  // And when the dial changes size: the canvas draws in the screen's pixels.
  useEffect(() => {
    const element = svg.current;
    if (!hdr || !element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => hdr.draw(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [hdr]);

  return (
    <section
      data-testid={`gauge-${kind}`}
      data-status={display.status}
      data-max={String(scale.max)}
      {...(band ? { 'data-zone': String(band.zone) } : {})}
      aria-label={spoken}
      style={{
        position: 'relative',
        pointerEvents: 'auto',
        width: 'clamp(120px, 13vw, 210px)',
        aspectRatio: '1',
        borderRadius: '50%',
        boxSizing: 'border-box',
        border: '1px solid rgb(255 255 255 / .16)',
        // Glass: the scenery shows through, blurred, darker towards the rim.
        backgroundColor: 'rgb(11 18 32 / .58)',
        backgroundImage:
          'radial-gradient(circle at 50% 40%, rgb(30 44 70 / .35) 0%, rgb(11 18 32 / .1) 60%, rgb(4 8 16 / .35) 100%)',
        backdropFilter: 'blur(14px) saturate(140%)',
        WebkitBackdropFilter: 'blur(14px) saturate(140%)',
        boxShadow:
          '0 20px 45px -12px rgb(0 0 0 / .55), inset 0 1px 1px rgb(255 255 255 / .18), inset 0 -2px 8px rgb(0 0 0 / .35)',
        fontFamily: 'var(--ridrs-font-text)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <svg
        ref={svg}
        viewBox="0 0 200 200"
        width="100%"
        height="100%"
        role="img"
        aria-hidden="true"
        overflow="visible"
        // On an HDR screen the canvas over it shows the same drawing, brighter.
        style={{ overflow: 'visible', opacity: hdr ? 0 : 1 }}
      >

        {/* The zones, dimmed; the scale lights up from its start to the value. */}
        {scale.bands.length === 0 ? (
          <path
            d={arc(ARC_RADIUS, start, angleOf(scale, scale.max))}
            fill="none"
            stroke={dimmed(NEUTRAL)}
            strokeWidth={TRACK_WIDTH}
            strokeLinecap="round"
          />
        ) : null}
        {scale.bands.map((item) => (
          <path
            key={item.zone}
            data-zone-band=""
            data-zone={String(item.zone)}
            data-from={String(item.from)}
            data-to={String(item.to)}
            d={arc(ARC_RADIUS, angleOf(scale, item.from), angleOf(scale, item.to))}
            fill="none"
            stroke={dimmed(item.colour)}
            strokeWidth={TRACK_WIDTH}
          >
            <title>{`${zoneName(item.zone)}${item.name ? ` · ${item.name}` : ''}`}</title>
          </path>
        ))}
        {lit ? (
          <path
            data-testid="active-arc"
            data-value={display.text}
            d={arc(ARC_RADIUS, start, angle)}
            fill="none"
            stroke={accent}
            strokeWidth={ARC_WIDTH}
            strokeLinecap="round"
          />
        ) : null}

        {/* The ticks inside the scale and their numbers. */}
        {ticksOf(scale).map((tick) => {
          const at = angleOf(scale, tick.value);
          const [x0, y0] = point(TICK_OUTER, at);
          const [x1, y1] = point(tick.major ? TICK_INNER_MAJOR : TICK_INNER_MINOR, at);
          return (
            <line
              key={tick.value}
              x1={x0}
              y1={y0}
              x2={x1}
              y2={y1}
              stroke={tick.major ? WHITE : GREY_DARK}
              strokeWidth={tick.major ? 1.47 : 0.87}
              strokeLinecap="round"
            />
          );
        })}
        {ticksOf(scale)
          .filter((tick) => tick.major)
          .map((tick) => {
            const [x, y] = point(TICK_LABEL, angleOf(scale, tick.value));
            return (
              <text
                key={tick.value}
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={tick.value >= 1000 ? 7.5 : 9}
                fontWeight={600}
                fill={GREY_LIGHT}
              >
                {tick.value}
              </text>
            );
          })}

        {/* The FTP: a red line across the scale and a red triangle inside it. */}
        {ftp !== undefined ? (
          <g data-testid="ftp-marker" data-value={String(Math.round(ftp))} transform={towards(angleOf(scale, ftp))}>
            <line x1={C} y1={5.7} x2={C} y2={13} stroke={OUTLINE} strokeWidth={3.5} strokeLinecap="round" />
            <line
              x1={C}
              y1={5.7}
              x2={C}
              y2={13}
              stroke={FTP_RED}
              strokeWidth={2}
              strokeLinecap="round"
            />
            <polygon
              points={`${C - 5.7},22 ${C + 5.7},22 ${C},13.3`}
              fill={FTP_RED}
              stroke={OUTLINE}
              strokeWidth={1.07}
              strokeLinejoin="round"
            />
          </g>
        ) : null}

        {/* The average: a white triangle outside the scale, pointing at it. */}
        {averageValue !== undefined ? (
          <g data-testid="average-marker" data-value={String(averageValue)} transform={towards(angleOf(scale, averageValue))}>
            <polygon
              points={`${C - 5.7},-2.7 ${C + 5.7},-2.7 ${C},6`}
              fill={WHITE}
              stroke={OUTLINE}
              strokeWidth={1.07}
              strokeLinejoin="round"
            />
          </g>
        ) : null}

        {/* The value large at the centre, the unit below it. */}
        <text
          data-testid="value"
          x={C}
          y={C}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={display.text.length > 3 ? 42 : 52}
          fontWeight={800}
          letterSpacing={-1.7}
          fill={WHITE}
        >
          {display.text}
        </text>
        <text
          data-testid="unit"
          x={C}
          y={132}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={11.3}
          fontWeight={600}
          fill={GREY}
        >
          {unit}
        </text>

        {/* At the bottom: the gear, else why there is no value, else the average. */}
        {gear ? (
          <>
            {display.reason !== undefined ? (
              // Small, between the unit and the gear: the gear does not depend on the reading.
              <text
                data-testid="reason"
                x={C}
                y={146}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={7.5}
                fill={GREY}
              >
                {display.reason}
              </text>
            ) : null}
            <text
              x={C}
              y={158}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={7.7}
              fontWeight={600}
              letterSpacing={0.53}
              fill={GREY_DARK}
            >
              {gear.label.toUpperCase()}
            </text>
            <text
              data-testid="gear"
              x={C}
              y={174}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={20.7}
              fontWeight={700}
              letterSpacing={-0.53}
              fill={GREY_LIGHT}
            >
              {gear.text}
            </text>
          </>
        ) : display.reason !== undefined ? (
          <text
            data-testid="reason"
            x={C}
            y={162}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={9}
            fill={GREY}
          >
            {display.reason}
          </text>
        ) : average ? (
          <>
            <text
              x={C}
              y={158}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={7.7}
              fontWeight={600}
              letterSpacing={0.53}
              fill={GREY_DARK}
            >
              {average.label.toUpperCase()}
            </text>
            <text
              data-testid="average"
              x={C}
              y={174}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={20.7}
              fontWeight={700}
              letterSpacing={-0.53}
              fill={GREY_LIGHT}
            >
              {averageText}
            </text>
          </>
        ) : null}
      </svg>
      <canvas
        ref={canvas}
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: `${(-HDR_MARGIN / 200) * 100}%`,
          width: `${100 + (HDR_MARGIN / 100) * 100}%`,
          height: `${100 + (HDR_MARGIN / 100) * 100}%`,
          pointerEvents: 'none',
          display: hdr ? 'block' : 'none',
        }}
      />
      {gear ? (
        // The gear as a control of its own over its numbers: Up and Down shift (AGENTS.md rule 12).
        <div
          role="spinbutton"
          tabIndex={0}
          aria-label={gear.label}
          aria-valuenow={gear.index}
          aria-valuetext={gear.text}
          aria-valuemin={1}
          aria-valuemax={gear.count}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
              return;
            }
            // The arrows shift here instead of moving the focus.
            event.preventDefault();
            gear.onShift(event.key === 'ArrowUp' ? 'up' : 'down');
          }}
          onFocus={() => setGearFocused(true)}
          onBlur={() => setGearFocused(false)}
          style={{
            position: 'absolute',
            left: '30%',
            top: '74%',
            width: '40%',
            height: '19%',
            borderRadius: 'var(--ridrs-radius-sm)',
            // The focus is always clearly visible.
            outline: gearFocused ? 'var(--ridrs-focus-ring)' : 'none',
            outlineOffset: 2,
          }}
        />
      ) : null}
    </section>
  );
}
