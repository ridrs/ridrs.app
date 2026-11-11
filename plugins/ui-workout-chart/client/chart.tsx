// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UiCapabilityInput, WorkoutInterval, workoutChartCapability } from '@ridrs/contracts';
import {
  type ChartPoint,
  type ChartShape,
  defaultPowerZones,
  layoutWorkout,
  type WorkoutLayout,
} from '@ridrs/workout';
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { describeSummary, durationText } from './describe.ts';
import type { Messages } from './i18n/index.ts';
import { draggedPower, draggedSeconds, findInterval, type HandleKind, handlesOf, powerOf } from './handles.ts';
import { PALETTE_CSS, zoneColour } from './palette.ts';
import { type StepInfo, stepInfos } from './steps.ts';

export type ChartInput = UiCapabilityInput<typeof workoutChartCapability>;

/** The drawing area of each variant, in SVG units; the SVG scales with its container. */
const SIZES = {
  micro: { width: 72, height: 18 },
  mini: { width: 240, height: 56 },
  full: { width: 720, height: 180 },
  edit: { width: 720, height: 220 },
} as const;
const DEFAULT_ZONE_COUNT = 7;
/** Room around the full chart: left for the axis, right edge, a row per bracket depth, the time axis and the zone bar. */
const MARGIN = { left: 58, right: 14, bracketRow: 16, bottom: 30, zoneBar: 24 } as const;
const SYMBOLS: Readonly<Record<string, string>> = {
  free: '~',
  'max-effort': '!',
  'heart-rate': '♥',
  open: '…',
  other: '?',
};

const CACHE_LIMIT = 400;
const layouts = new Map<string, WorkoutLayout>();

/**
 * The layout of a workout, remembered by its content: the shell hands over a fresh copy of the
 * input every time, so the package's own memory by object would never hit (50 calendar entries
 * must stay smooth).
 */
export function cachedLayout(
  input: Pick<ChartInput, 'workout' | 'athlete'>,
  variant: 'micro' | 'mini' | 'full' | 'edit',
): WorkoutLayout {
  const { width, height } = SIZES[variant];
  const key = JSON.stringify([input.workout, input.athlete, variant]);
  const known = layouts.get(key);
  if (known) return known;
  const layout = layoutWorkout(input.workout, {
    width,
    height,
    ...(input.athlete ? { athlete: input.athlete } : {}),
    variant,
  });
  if (layouts.size >= CACHE_LIMIT) layouts.delete(layouts.keys().next().value as string);
  layouts.set(key, layout);
  return layout;
}

const path = (points: readonly ChartPoint[]) =>
  `${points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')} Z`;

/** The variant drawn: `hud` comes with its phase and draws as `full` until then. */
export const variantOf = (variant: ChartInput['variant']): 'micro' | 'mini' | 'full' | 'edit' =>
  variant === 'micro' || variant === 'mini' || variant === 'edit' ? variant : 'full';

export const CHART_CSS = `${PALETTE_CSS}
.wc { position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0; color: var(--wc-text);
  font: 500 12px system-ui, sans-serif; }
.wc svg { display: block; width: 100%; overflow: visible; }
.wc[data-variant="micro"] svg { height: 18px; }
.wc[data-variant="mini"] svg { height: 56px; }
.wc [data-shape] { stroke: none; }
.wc [data-selected] path[data-fill] { stroke: var(--wc-text); stroke-width: 2; }
.wc [data-focused] path[data-fill] { stroke: var(--wc-focus); stroke-width: 3; }
.wc [data-step] { outline: none; cursor: default; }
.wc-ftp { stroke: var(--wc-line); stroke-width: 1; stroke-dasharray: 5 4; vector-effect: non-scaling-stroke; fill: none; }
.wc-grid { stroke: var(--wc-line); stroke-width: 1; opacity: .25; }
.wc-axis, .wc-bracket { fill: var(--wc-muted); font-size: 11px; }
.wc-bracket-line { stroke: var(--wc-muted); stroke-width: 1.25; fill: none; }
.wc-facts { color: var(--wc-muted); font-size: 12px; }
.wc-hint { color: var(--wc-muted); font-size: 11px; font-style: italic; }
.wc-handle { fill: var(--wc-text); stroke: var(--wc-surface); stroke-width: 1.5; touch-action: none; }
.wc-handle[data-handle="duration"] { cursor: ew-resize; }
.wc-handle:not([data-handle="duration"]) { cursor: ns-resize; }
.wc-handle-hit { fill: transparent; touch-action: none; }
.wc[data-variant="edit"] [data-step] { cursor: pointer; }
.wc-tooltip { position: absolute; top: 0; z-index: 2; min-width: 9em; padding: 6px 10px; border: 1px solid var(--wc-line);
  border-radius: 8px; background: var(--wc-surface); color: var(--wc-text); font-size: 12px; line-height: 1.35;
  pointer-events: none; transform: translate(-50%, -100%); white-space: nowrap; }
.wc-tooltip b { display: block; font-weight: 700; }
.wc-tooltip span { display: block; color: var(--wc-muted); }
`;

interface Props {
  readonly input: ChartInput;
  readonly text: Messages;
  readonly onStepFocused: (stepId: string) => void;
  readonly onStepChanged?: (change: StepChange) => void;
}

/** What a drag of a handle reports (`step-changed`). */
export interface StepChange {
  readonly stepId: string;
  readonly durationSeconds?: number;
  readonly power?: { readonly start?: number; readonly end?: number };
  /** The drag is over. */
  readonly done: boolean;
}

/** The chart: an SVG drawn from `layoutWorkout`; all maths is in `@ridrs/workout`. */
export function Chart({ input, text, onStepFocused, onStepChanged }: Props): ReactNode {
  const variant = variantOf(input.variant);
  const layout = cachedLayout(input, variant);
  const patternId = `wc-hatch-${useId().replace(/\W/g, '')}`;
  const zones = input.athlete?.powerZones ?? defaultPowerZones();
  const zoneCount = zones.length || DEFAULT_ZONE_COUNT;
  const description = describeSummary(layout.summary, layout.axis.unit, text);
  const hint = layout.zoned ? undefined : text.neutralHint;

  if (variant === 'full' || variant === 'edit') {
    return (
      <FullChart
        variant={variant}
        input={input}
        layout={layout}
        text={text}
        description={description}
        patternId={patternId}
        zoneCount={zoneCount}
        hint={hint}
        onStepFocused={onStepFocused}
        {...(onStepChanged ? { onStepChanged } : {})}
      />
    );
  }

  const { width, height } = SIZES[variant];
  const load = layout.summary.trainingLoad;
  return (
    <div className="wc" data-testid="workout-chart" data-variant={variant} data-zoned={layout.zoned}>
      <svg
        role="img"
        aria-label={description}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        focusable="false"
      >
        <Hatch id={patternId} />
        {layout.shapes.map((shape) => (
          <g key={shape.segmentIndex} data-shape data-step-id={shape.stepId}>
            <ShapeFill shape={shape} patternId={patternId} zoneCount={zoneCount} />
          </g>
        ))}
        {layout.ftpLine ? (
          <line className="wc-ftp" data-testid="workout-chart-ftp-line" x1={0} x2={width} y1={layout.ftpLine.y} y2={layout.ftpLine.y} />
        ) : null}
      </svg>
      {variant === 'mini' ? (
        <>
          <div className="wc-facts" data-testid="workout-chart-facts">
            {`${layout.summary.durationEstimated ? '≈ ' : ''}${durationText(layout.durationSeconds)}${load === undefined ? '' : ` · TSS ${Math.round(load)}`}`}
          </div>
          {hint ? (
            <div className="wc-hint" data-testid="workout-chart-hint">
              {hint}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Hatch({ id }: { readonly id: string }) {
  return (
    <defs>
      <pattern id={id} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
        <line x1={0} y1={0} x2={0} y2={6} stroke="var(--wc-surface)" strokeWidth={2.5} opacity={0.6} />
      </pattern>
    </defs>
  );
}

/** One step's body: filled in its zone colour, a range as a band, a hatched overlay where the height is assumed. */
function ShapeFill({
  shape,
  patternId,
  zoneCount,
}: {
  readonly shape: ChartShape;
  readonly patternId: string;
  readonly zoneCount: number;
}) {
  const colour = zoneColour(shape.zone, zoneCount);
  return (
    <>
      <path data-fill d={path(shape.polygon)} fill={colour} opacity={shape.band ? 0.5 : 1} />
      {shape.band ? <path d={path(shape.band)} fill={colour} /> : null}
      {shape.marker ? <path data-marker={shape.marker} d={path(shape.polygon)} fill={`url(#${patternId})`} /> : null}
      {shape.clipped ? <rect data-clipped x={shape.x0} y={0} width={Math.max(shape.x1 - shape.x0, 0.5)} height={2} fill="var(--wc-text)" /> : null}
    </>
  );
}

function FullChart({
  input,
  layout,
  text,
  description,
  patternId,
  zoneCount,
  hint,
  onStepFocused,
  onStepChanged,
  variant,
}: Props & {
  readonly variant: 'full' | 'edit';
  readonly layout: WorkoutLayout;
  readonly description: string;
  readonly patternId: string;
  readonly zoneCount: number;
  readonly hint: string | undefined;
}) {
  const { width, height } = SIZES[variant];
  const editing = variant === 'edit';
  const athlete = input.athlete;
  const zones = athlete?.powerZones ?? defaultPowerZones();
  const [focused, setFocused] = useState<number>();
  const [hovered, setHovered] = useState<number>();
  const svg = useRef<SVGSVGElement>(null);
  const dragging = useRef<() => void>(undefined);
  // A drag in progress ends with the chart.
  useEffect(() => () => dragging.current?.(), []);
  const infos = useMemo<StepInfo[]>(
    () => stepInfos(input.workout, athlete ?? {}, layout.shapes, zones.map((zone) => zone.name), text),
    [input.workout, athlete, layout.shapes, zones, text],
  );
  const depth = layout.brackets.reduce((most, bracket) => Math.max(most, bracket.depth + 1), 0);
  const top = depth > 0 ? depth * MARGIN.bracketRow + 6 : 8;
  const zoneBar = layout.zoned && layout.shapes.length > 0;
  const total = MARGIN.left + width + MARGIN.right;
  const totalHeight = top + height + MARGIN.bottom + (zoneBar ? MARGIN.zoneBar : 0);
  const active = hovered ?? focused;
  const info = active === undefined ? undefined : infos[active];
  const activeShape = active === undefined ? undefined : layout.shapes[active];
  const step = (event: KeyboardEvent<SVGGElement>, direction: -1 | 1) => {
    const steps = [...(event.currentTarget.parentElement?.querySelectorAll<SVGGElement>('[data-step]') ?? [])];
    const at = steps.indexOf(event.currentTarget);
    // The ends hold the focus: Left and Right never leave the chart, Up, Down, Enter and Back do their usual.
    steps[Math.min(Math.max(at + direction, 0), steps.length - 1)]?.focus();
  };

  /**
   * Drags a handle: the pointer's movement in SVG units gives the new duration or power, snapped,
   * reported as it changes (`done: false`) and once more when the pointer is released.
   */
  const beginDrag = (
    event: ReactPointerEvent<SVGElement>,
    handle: HandleKind,
    shape: ChartShape,
    step: WorkoutInterval,
  ) => {
    if (!onStepChanged || !svg.current || (event.button ?? 0) !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragging.current?.();
    const rect = svg.current.getBoundingClientRect();
    const scale = rect.width > 0 ? total / rect.width : 1;
    const startX = event.clientX;
    const startY = event.clientY;
    const seconds = step.duration.kind === 'time' ? step.duration.seconds : 0;
    const power = powerOf(step, handle) ?? 0;
    const target = step.effort.kind === 'target' ? step.effort.primary.unit : undefined;
    let last: StepChange | undefined;
    const report = (at: { clientX: number; clientY: number }, done: boolean) => {
      let change: StepChange;
      if (handle === 'duration') {
        const delta = ((at.clientX - startX) * scale * layout.durationSeconds) / width;
        change = { stepId: shape.stepId, durationSeconds: draggedSeconds(seconds, delta), done };
      } else {
        if (target !== 'percent-ftp' && target !== 'watts') return;
        const delta = (-(at.clientY - startY) * scale * layout.axis.max) / height;
        const value = draggedPower(power, delta, {
          axis: layout.axis.unit,
          target,
          ...(athlete?.ftp ? { ftp: athlete.ftp } : {}),
        });
        change = { stepId: shape.stepId, power: { [handle === 'power-end' ? 'end' : 'start']: value }, done };
      }
      const same = last && JSON.stringify({ ...last, done: 0 }) === JSON.stringify({ ...change, done: 0 });
      if (!done && same) return;
      if (done && !last && !hasChanged(change, seconds, power)) return;
      last = change;
      onStepChanged(change);
    };
    const move = (e: PointerEvent) => report(e, false);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragging.current = undefined;
    };
    const up = (e: PointerEvent) => {
      stop();
      if (last) onStepChanged({ ...last, done: true });
      else report(e, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    dragging.current = stop;
  };

  const zoneTime = new Map<number, number>();
  for (const shape of layout.shapes) {
    if (shape.zone !== undefined) zoneTime.set(shape.zone, (zoneTime.get(shape.zone) ?? 0) + shape.x1 - shape.x0);
  }
  let barX = 0;

  return (
    <div className="wc" data-testid="workout-chart" data-variant={variant} data-zoned={layout.zoned}>
      <svg
        ref={svg}
        role="group"
        aria-label={description}
        viewBox={`0 0 ${total} ${totalHeight}`}
        focusable="false"
        style={{ aspectRatio: `${total} / ${totalHeight}` }}
      >
        <Hatch id={patternId} />
        <g transform={`translate(${MARGIN.left} ${top})`}>
          {layout.axis.ticks.map((tick) => (
            <g key={tick.value}>
              <line className="wc-grid" x1={0} x2={width} y1={tick.at} y2={tick.at} />
              <text className="wc-axis" x={-8} y={tick.at + 4} textAnchor="end">
                {`${tick.value} ${layout.axis.unit === 'watts' ? 'W' : '%'}`}
              </text>
              {tick.watts !== undefined && tick.value > 0 ? (
                <text className="wc-axis" x={-8} y={tick.at + 16} textAnchor="end" opacity={0.7}>
                  {`${tick.watts} W`}
                </text>
              ) : null}
            </g>
          ))}
          {layout.timeTicks.map((tick) => (
            <text key={tick.value} className="wc-axis" x={tick.at} y={height + 16} textAnchor="middle">
              {durationText(tick.value)}
            </text>
          ))}
          {layout.shapes.map((shape, index) => (
            <g
              key={shape.segmentIndex}
              data-shape
              data-step
              data-testid="workout-chart-step"
              data-step-id={shape.stepId}
              data-zone={shape.zone}
              data-focused={focused === index || undefined}
              data-selected={input.selectedStep === shape.stepId || undefined}
              role="img"
              aria-label={infos[index] ? `${infos[index].title}, ${infos[index].duration}, ${infos[index].target}` : undefined}
              tabIndex={focused === index || (focused === undefined && index === 0) ? 0 : -1}
              onClick={editing ? () => onStepFocused(shape.stepId) : undefined}
              onFocus={() => {
                setFocused(index);
                onStepFocused(shape.stepId);
              }}
              onBlur={() => setFocused((was) => (was === index ? undefined : was))}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered((was) => (was === index ? undefined : was))}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  event.stopPropagation();
                  step(event, event.key === 'ArrowLeft' ? -1 : 1);
                }
              }}
            >
              <ShapeFill shape={shape} patternId={patternId} zoneCount={zoneCount} />
              {shape.marker && shape.x1 - shape.x0 > 18 ? (
                <text className="wc-axis" x={(shape.x0 + shape.x1) / 2} y={height - 6} textAnchor="middle" fill="var(--wc-text)">
                  {SYMBOLS[shape.marker]}
                </text>
              ) : null}
            </g>
          ))}
          {editing && onStepChanged
            ? layout.shapes.map((shape) => {
                if (shape.stepId !== input.selectedStep) return null;
                const step = findInterval(input.workout.steps, shape.stepId);
                if (!step) return null;
                return handlesOf(step).map((handle) => (
                  <Handle
                    key={`${shape.segmentIndex}-${handle}`}
                    handle={handle}
                    shape={shape}
                    height={height}
                    onPointerDown={(event) => beginDrag(event, handle, shape, step)}
                  />
                ));
              })
            : null}
          {layout.ftpLine ? (
            <>
              <line className="wc-ftp" data-testid="workout-chart-ftp-line" x1={0} x2={width} y1={layout.ftpLine.y} y2={layout.ftpLine.y} />
              {athlete?.ftp ? (
                <text className="wc-axis" x={width} y={layout.ftpLine.y - 4} textAnchor="end">
                  {`${text.ftp} ${Math.round(athlete.ftp)} W`}
                </text>
              ) : null}
            </>
          ) : null}
          {layout.brackets.map((bracket) => {
            const y = -(depth - bracket.depth) * MARGIN.bracketRow + MARGIN.bracketRow - 8;
            return (
              <g key={`${bracket.repeatId}-${bracket.depth}-${bracket.x0}`} data-testid="workout-chart-bracket">
                <path className="wc-bracket-line" d={`M${bracket.x0 + 1},${y + 5} V${y} H${bracket.x1 - 1} V${y + 5}`} />
                {bracket.count === undefined ? null : (
                  <text className="wc-bracket" x={(bracket.x0 + bracket.x1) / 2} y={y - 3} textAnchor="middle">
                    {text.repeat(bracket.count)}
                  </text>
                )}
              </g>
            );
          })}
          {zoneBar ? (
            <g data-testid="workout-chart-zone-bar" role="img" aria-label={text.zoneBar} transform={`translate(0 ${height + MARGIN.bottom - 4})`}>
              {[...zoneTime.entries()]
                .sort(([a], [b]) => a - b)
                .map(([zone, span]) => {
                  const x = barX;
                  barX += span;
                  return (
                    <g key={zone}>
                      <rect x={x} y={0} width={span} height={8} fill={zoneColour(zone, zoneCount)}>
                        <title>{`${text.zone(zone, zones[zone - 1]?.name)} · ${durationText((span / width) * layout.durationSeconds)}`}</title>
                      </rect>
                      {span > 30 ? (
                        <text className="wc-axis" x={x + span / 2} y={19} textAnchor="middle">{`Z${zone}`}</text>
                      ) : null}
                    </g>
                  );
                })}
            </g>
          ) : null}
        </g>
      </svg>
      {info && activeShape ? (
        <div
          className="wc-tooltip"
          role="status"
          data-testid="workout-chart-tooltip"
          style={{ left: `${((MARGIN.left + (activeShape.x0 + activeShape.x1) / 2) / total) * 100}%`, top: `${((top + height * 0.1) / totalHeight) * 100}%` }}
        >
          <b>{info.title}</b>
          <span data-field="duration">{info.duration}</span>
          <span data-field="target">{info.target}</span>
          {info.zone ? <span data-field="zone">{info.zone}</span> : null}
        </div>
      ) : null}
      {hint ? (
        <div className="wc-hint" data-testid="workout-chart-hint">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/** Whether a reported change differs from what the step had: a click on a handle changes nothing. */
function hasChanged(change: StepChange, seconds: number, power: number): boolean {
  if (change.durationSeconds !== undefined) return change.durationSeconds !== seconds;
  const value = change.power?.start ?? change.power?.end;
  return value !== undefined && value !== power;
}

/** One handle on a selected step: a grip on its right edge, or on the top of a steady step or either end of a ramp. */
function Handle({
  handle,
  shape,
  height,
  onPointerDown,
}: {
  readonly handle: HandleKind;
  readonly shape: ChartShape;
  readonly height: number;
  readonly onPointerDown: (event: ReactPointerEvent<SVGElement>) => void;
}) {
  const left = shape.polygon[1] ?? [shape.x0, height];
  const right = shape.polygon[2] ?? [shape.x1, height];
  const common = {
    'data-testid': 'workout-chart-handle',
    'data-handle': handle,
    'data-step-id': shape.stepId,
    onPointerDown,
  } as const;
  if (handle === 'duration') {
    return (
      <g {...common}>
        <rect className="wc-handle-hit" x={shape.x1 - 9} y={height * 0.15} width={18} height={height * 0.7} />
        <rect className="wc-handle" x={shape.x1 - 3} y={height * 0.3} width={6} height={height * 0.4} rx={3} />
      </g>
    );
  }
  const at = handle === 'power-start' ? left : handle === 'power-end' ? right : [(shape.x0 + shape.x1) / 2, left[1]];
  const [x, y] = at as [number, number];
  return (
    <g {...common}>
      <circle className="wc-handle-hit" cx={x} cy={y} r={14} />
      {handle === 'power' ? (
        <rect className="wc-handle" x={x - 14} y={y - 3} width={28} height={6} rx={3} />
      ) : (
        <circle className="wc-handle" cx={x} cy={y} r={6} />
      )}
    </g>
  );
}
