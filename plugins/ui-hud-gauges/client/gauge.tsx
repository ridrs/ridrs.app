// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MetricReading } from '@ridrs/contracts';
import { describeMetricReading, formatDecimal } from '@ridrs/ui-sdk';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createHdrLayer, HDR_MARGIN, type HdrLayer } from './hdr-layer.ts';
import {
  angleOf,
  bandNear,
  dimmed,
  drawsOnHdrCanvas,
  type GaugeTarget,
  lit,
  type Scale,
  targetWindow,
  ticksOf,
} from './model.ts';

/** The dial is drawn on 200 × 200 units, its centre at (C, C). */
const C = 100;
const ARC_RADIUS = 90.7;
const ARC_WIDTH = 7.3;
/** The part of the scale not lit yet: a thinner track along the middle of the lit one. */
const TRACK_WIDTH = 3.3;
const TICK_OUTER = 85.3;
const TICK_INNER_MAJOR = 77.3;
const TICK_INNER_MINOR = 80.7;
const TICK_LABEL = 64;
/** The scale's colour without zones (no FTP, say). */
const NEUTRAL = '#38bdf8';
/** The track while the metric has no value: no zone colours, so a glance tells it is not live. */
const IDLE_TRACK = 'rgb(51 65 85)';
/** Half the lit arc's width as an angle: its round caps end exactly at the value, not beyond it. */
const CAP_ANGLE = ((ARC_WIDTH / 2 / ARC_RADIUS) * 180) / Math.PI;
/** Where the average's mark ends: just across the outer edge of the scale. */
const AVERAGE_TIP = C - ARC_RADIUS + 3.3;

/**
 * Text sizes in units of the 200-unit dial; the dial is at least 168 px wide, so a unit is at
 * least 0.84 px. Read from the trainer, about 1.5 m away, nothing is below 10 px.
 */
const SIZE = { value: 54, valueLong: 44, unit: 13, label: 11, secondary: 22, tick: 12, tickLong: 10.5 };
/**
 * The weights the Kinetic look bundles (`ui-main-screen/client/kinetic.tsx`): the text face in
 * 400 and 500 only, with font synthesis off. Heavier weights would fall back to 500 anyway.
 */
const WEIGHT = { regular: 400, medium: 500 };

/** Red and white beyond sRGB, for the FTP, the average and the value. */
const FTP_RED = 'color(display-p3 1 0.1 0.1)';
const WHITE = 'color(display-p3 1 1 1)';
/** Solid greys for what is read less often: minor ticks, captions, the unit. */
const GREY_LIGHT = 'rgb(226 232 240)';
const GREY = 'rgb(203 213 225)';
const GREY_DARK = 'rgb(148 163 184)';
/** Why there is no value: the Kinetic look's warning amber (`--ridrs-warn`). */
const WARN = '#ffb62e';
/** The outline that keeps a mark apart from the scale under it. */
const OUTLINE = '#0b1220';
/** The workout target on the scale (Spotlight 3): an outer arc with a center triangle and a radial spotlight. */
const TARGET_ORANGE = '#ff5a1f';
const TARGET_OUTER = 96.8;
const TARGET_LINE_WIDTH = 2.3;
const TARGET_SPOTLIGHT_OUTER = TARGET_OUTER - TARGET_LINE_WIDTH / 2;
const TARGET_SPOTLIGHT_INNER = 72;
const TARGET_RAY_INNER = 74;
const TARGET_TICK_MARGIN = 1.8;
const TARGET_POINTER = `${C - 4.5},${(C - TARGET_OUTER + 0.15).toFixed(2)} ${C + 4.5},${(C - TARGET_OUTER + 0.15).toFixed(2)} ${C},7.4`;

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

/** A clockwise sector between `rOuter` and `rInner` from `from`° to `to`°. */
function sector(rOuter: number, rInner: number, from: number, to: number): string {
  const [ox0, oy0] = point(rOuter, from);
  const [ox1, oy1] = point(rOuter, to);
  const [ix1, iy1] = point(rInner, to);
  const [ix0, iy0] = point(rInner, from);
  const large = to - from > 180 ? 1 : 0;
  return `M ${ox0.toFixed(2)} ${oy0.toFixed(2)} A ${rOuter} ${rOuter} 0 ${large} 1 ${ox1.toFixed(2)} ${oy1.toFixed(2)} L ${ix1.toFixed(2)} ${iy1.toFixed(2)} A ${rInner} ${rInner} 0 ${large} 0 ${ix0.toFixed(2)} ${iy0.toFixed(2)} Z`;
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
  /** A screenshot is taken: the SVG shows, not the HDR canvas (ADR 0102). */
  readonly capturing?: boolean;
  /** The ride's average; absent: the gauge shows none. */
  readonly average?: { readonly label: string; readonly value: number | undefined };
  /** The FTP, marked on the scale; absent: no mark. */
  readonly ftp?: number | undefined;
  /** The workout target on the scale; while present, the FTP and average marks on the scale hide. */
  readonly target?: GaugeTarget | undefined;
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
 * a white triangle on its outer edge, a red line across it with a red triangle inside. The glass lets the
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
  capturing = false,
  average,
  ftp,
  target,
  gear,
  zoneName,
}: GaugeProps) {
  const [gearFocused, setGearFocused] = useState(false);
  const shownZone = useRef<number | undefined>(undefined);
  const svg = useRef<SVGSVGElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hdr, setHdr] = useState<HdrLayer>();
  const onHdr = drawsOnHdrCanvas(hdr !== undefined, capturing);
  const display = describeMetricReading(reading, language);
  const value = reading?.status === 'available' ? reading.value : undefined;
  const band = value === undefined ? undefined : bandNear(scale, value, shownZone.current);
  shownZone.current = band?.zone;
  const start = angleOf(scale, scale.min);
  const angle = angleOf(scale, value ?? scale.min);
  const accent = lit(band?.colour ?? NEUTRAL);
  const live = value !== undefined;
  const averageValue = average?.value === undefined ? undefined : Math.round(average.value);
  const averageText = averageValue === undefined ? '–' : formatDecimal(averageValue, 0);
  const lights = live && angle - start > 0.5;
  const targetSpan = target ? targetWindow(scale, target) : undefined;
  const targetAngles = targetSpan
    ? {
        low: angleOf(scale, targetSpan.low),
        high: angleOf(scale, targetSpan.high),
        center: angleOf(scale, targetSpan.center),
      }
    : undefined;
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
        width: 'clamp(168px, 14vw, 240px)',
        aspectRatio: '1',
        borderRadius: '50%',
        boxSizing: 'border-box',
        // Square by the aspect ratio alone: its automatic minimum height (the content's) would let
        // the dial grow taller than wide, an ellipse with the scale off its centre.
        minHeight: 0,
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
        // A block: inline, it would sit on a text line and add the line's descent below it.
        style={{ display: 'block', overflow: 'visible', opacity: onHdr ? 0 : 1 }}
      >
        {targetAngles && target && targetSpan ? (
          <>
            <defs>
              <radialGradient
                id={`target-glow-${kind}`}
                cx={C}
                cy={C}
                r={TARGET_SPOTLIGHT_OUTER}
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="75%" stopColor={TARGET_ORANGE} stopOpacity={0} />
                <stop offset="81%" stopColor={TARGET_ORANGE} stopOpacity={0.12} />
                <stop offset="87%" stopColor={TARGET_ORANGE} stopOpacity={0.28} />
                <stop offset="94%" stopColor={TARGET_ORANGE} stopOpacity={0.5} />
                <stop offset="100%" stopColor={TARGET_ORANGE} stopOpacity={0.72} />
              </radialGradient>
              <radialGradient
                id={`target-edge-${kind}`}
                cx={C}
                cy={C}
                r={TARGET_SPOTLIGHT_OUTER}
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="77%" stopColor={TARGET_ORANGE} stopOpacity={0} />
                <stop offset="86%" stopColor={TARGET_ORANGE} stopOpacity={0.45} />
                <stop offset="100%" stopColor={TARGET_ORANGE} stopOpacity={0.85} />
              </radialGradient>
            </defs>
            <g
              data-testid="target-spotlight"
              data-low={String(Math.round(target.low))}
              data-high={String(Math.round(target.high))}
              data-center={String(Math.round(targetSpan.center))}
            >
              <path
                d={sector(
                  TARGET_SPOTLIGHT_OUTER,
                  TARGET_SPOTLIGHT_INNER,
                  targetAngles.low,
                  targetAngles.high,
                )}
                fill={`url(#target-glow-${kind})`}
              />
              {([targetAngles.low, targetAngles.high] as const).map((rayAngle) => {
                const [x0, y0] = point(TARGET_SPOTLIGHT_OUTER, rayAngle);
                const [x1, y1] = point(TARGET_RAY_INNER, rayAngle);
                return (
                  <line
                    key={rayAngle}
                    x1={x0}
                    y1={y0}
                    x2={x1}
                    y2={y1}
                    stroke={`url(#target-edge-${kind})`}
                    strokeWidth={1.3}
                  />
                );
              })}
            </g>
          </>
        ) : null}

        {/* The zones, dimmed; the scale lights up from its start to the value. */}
        {scale.bands.length === 0 ? (
          <path
            d={arc(ARC_RADIUS, start, angleOf(scale, scale.max))}
            fill="none"
            stroke={live ? dimmed(NEUTRAL) : IDLE_TRACK}
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
            stroke={live ? dimmed(item.colour) : IDLE_TRACK}
            strokeWidth={TRACK_WIDTH}
          >
            <title>{`${zoneName(item.zone)}${item.name ? ` · ${item.name}` : ''}`}</title>
          </path>
        ))}
        {lights ? (
          <path
            data-testid="active-arc"
            data-value={display.text}
            d={arc(ARC_RADIUS, start + CAP_ANGLE, Math.max(angle - CAP_ANGLE, start + CAP_ANGLE + 0.01))}
            fill="none"
            stroke={accent}
            strokeWidth={ARC_WIDTH}
            strokeLinecap="round"
          />
        ) : null}

        {/* The ticks inside the scale and their numbers. */}
        {ticksOf(scale)
          .filter((tick) => {
            if (!targetAngles) return true;
            const at = angleOf(scale, tick.value);
            return (
              at < targetAngles.low - TARGET_TICK_MARGIN ||
              at > targetAngles.high + TARGET_TICK_MARGIN
            );
          })
          .map((tick) => {
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
                fontSize={tick.value >= 1000 ? SIZE.tickLong : SIZE.tick}
                fontWeight={WEIGHT.medium}
                fill={GREY_LIGHT}
              >
                {tick.value}
              </text>
            );
          })}

        {/* The workout target (Spotlight 3): an outer arc and a center triangle; the other triangles hide. */}
        {targetAngles && target && targetSpan ? (
          <g
            data-testid="target-marker"
            data-low={String(Math.round(target.low))}
            data-high={String(Math.round(target.high))}
            data-center={String(Math.round(targetSpan.center))}
          >
            <path
              d={arc(TARGET_OUTER, targetAngles.low, targetAngles.high)}
              fill="none"
              stroke={OUTLINE}
              strokeWidth={3.8}
              strokeLinecap="round"
            />
            <g transform={towards(targetAngles.center)}>
              <polygon
                points={TARGET_POINTER}
                fill={OUTLINE}
                stroke={OUTLINE}
                strokeWidth={1.4}
                strokeLinejoin="round"
              />
            </g>
            <path
              data-testid="target-line"
              d={arc(TARGET_OUTER, targetAngles.low, targetAngles.high)}
              fill="none"
              stroke={TARGET_ORANGE}
              strokeWidth={TARGET_LINE_WIDTH}
              strokeLinecap="round"
            />
            <g data-testid="target-pointer" transform={towards(targetAngles.center)}>
              <polygon
                points={TARGET_POINTER}
                fill={TARGET_ORANGE}
                stroke={TARGET_ORANGE}
                strokeWidth={0.4}
                strokeLinejoin="round"
              />
            </g>
          </g>
        ) : null}

        {/* The FTP: a red line across the scale and a red triangle inside it. */}
        {ftp !== undefined && !target ? (
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

        {/* The average: a white triangle on the rim, pointing into the scale. */}
        {averageValue !== undefined && !target ? (
          <g data-testid="average-marker" data-value={String(averageValue)} transform={towards(angleOf(scale, averageValue))}>
            <polygon
              points={`${C - 5.5},0.8 ${C + 5.5},0.8 ${C},${AVERAGE_TIP}`}
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
          fontSize={display.text.length > 3 ? SIZE.valueLong : SIZE.value}
          fontWeight={WEIGHT.medium}
          letterSpacing={-1.5}
          fill={live ? WHITE : GREY_DARK}
        >
          {display.text}
        </text>
        {display.reason === undefined ? (
          <text
            data-testid="unit"
            x={C}
            y={134}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={SIZE.unit}
            fontWeight={WEIGHT.medium}
            fill={GREY}
          >
            {unit}
          </text>
        ) : (
          // Why there is no value, in the unit's place: the dash above says the rest.
          <text
            data-testid="reason"
            x={C}
            y={134}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={SIZE.unit}
            fontWeight={WEIGHT.medium}
            fill={WARN}
          >
            {display.reason}
          </text>
        )}

        {/* At the bottom, in the opening of the scale: the gear, else the average. */}
        {gear ?? average ? (
          <>
            <text
              x={C}
              y={157}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={SIZE.label}
              fontWeight={WEIGHT.medium}
              letterSpacing={1.1}
              fill={GREY_DARK}
            >
              {(gear ?? average)?.label.toUpperCase()}
            </text>
            <text
              data-testid={gear ? 'gear' : 'average'}
              x={C}
              y={175}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={SIZE.secondary}
              fontWeight={WEIGHT.medium}
              letterSpacing={-0.5}
              fill={GREY_LIGHT}
            >
              {gear ? gear.text : averageText}
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
          display: onHdr ? 'block' : 'none',
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
            top: '73%',
            width: '40%',
            height: '21%',
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
