// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  FILE_DROP_KEY,
  type FileDrop,
  fileDropImportService,
  fileDropState,
  routeProfileCapability,
  type Workout,
  workoutChartCapability,
} from '@ridrs/contracts';
import { Card, PREVIEW_CSS } from '@ridrs/ui-preview';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Messages, messages } from './i18n/index.ts';

/** Tiles shown at most; more are counted. */
const MAX_TILES = 4;
/** How long the layer says what letting go did, in ms. */
const DONE_SHOWN = 2500;

type DroppedFile = FileDrop['files'][number];

/** One tile: a workout of a file, or a video route. A file ridrs cannot import has none. */
type Tile =
  | { readonly kind: 'workout'; readonly key: string; readonly workout: Workout; readonly duplicate: boolean }
  | { readonly kind: 'route'; readonly key: string; readonly file: DroppedFile };

function tilesOf(files: readonly DroppedFile[]): Tile[] {
  return files.flatMap((file): Tile[] => {
    const { verdict } = file;
    if (verdict.kind === 'workouts') {
      return verdict.workouts.map((found, index) => ({
        kind: 'workout',
        key: `${file.id}/${index}`,
        workout: found.workout,
        duplicate: found.state === 'duplicate',
      }));
    }
    if (verdict.kind === 'route') return [{ kind: 'route', key: file.id, file }];
    return [];
  });
}

/** What can be added: workouts the library has not got, and video routes. */
function addable(files: readonly DroppedFile[]) {
  let workouts = 0;
  let duplicates = 0;
  let routes = 0;
  for (const { verdict } of files) {
    if (verdict.kind === 'route') routes += 1;
    if (verdict.kind === 'workouts') {
      for (const found of verdict.workouts) {
        if (found.state === 'duplicate') duplicates += 1;
        else workouts += 1;
      }
    }
  }
  return { workouts, duplicates, routes };
}

/** The sentence of the layer: what letting go does, or did. */
function sayWhat(drop: FileDrop, text: Messages): string {
  const reading = drop.files.find((file) => file.verdict.kind === 'reading');
  if (drop.phase === 'over' && reading) return text.reading(reading.name);
  if (drop.phase === 'importing') return text.adding;
  if (drop.phase === 'done') {
    const said = [
      drop.saved > 0 ? text.added(drop.saved) : '',
      drop.routes > 0 ? text.importingRoutes(drop.routes) : '',
      drop.failed > 0 ? text.failed(drop.failed) : '',
    ].filter(Boolean);
    return said.length > 0 ? said.join('. ') : text.alreadyThere;
  }
  const { workouts, duplicates, routes } = addable(drop.files);
  const parts = [workouts > 0 ? text.letGoWorkouts(workouts) : '', routes > 0 ? text.letGoRoutes(routes) : ''].filter(
    Boolean,
  );
  if (parts.length > 0) return text.letGo(parts);
  return duplicates > 0 ? text.alreadyThere : '';
}

/** A UI capability drawn into a place of this layer, as long as it is shown. */
function useDrawing(draw: (container: HTMLElement) => { release(): void }, input: unknown) {
  const place = useRef<HTMLDivElement>(null);
  const drawn = useRef(draw);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a tile draws once; its input never changes.
  useEffect(() => {
    const container = place.current;
    if (!container) return undefined;
    const drawing = drawn.current(container);
    // The drawing is a React root of its own: released right after this root commits, not during.
    return () => queueMicrotask(() => drawing.release());
  }, [input]);
  return place;
}

function WorkoutTile({ ctx, tile, text }: { readonly ctx: UiContext; readonly tile: Extract<Tile, { kind: 'workout' }>; readonly text: Messages }) {
  const chart = useDrawing(
    (container) => ctx.render(workoutChartCapability, container, { workout: tile.workout, variant: 'mini' }),
    tile.workout,
  );
  return (
    <article className="pv-card fd-tile" aria-label={tile.workout.name} data-duplicate={tile.duplicate || undefined}>
      <span className="fd-classifier">{text.workout}</span>
      <h4>{tile.workout.name}</h4>
      <div ref={chart} className="fd-chart" />
      {tile.duplicate ? <span className="fd-mark">{text.alreadyThere}</span> : null}
    </article>
  );
}

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const duration = (s: number) => `${Math.floor(s / 3600)}:${String(Math.round((s % 3600) / 60)).padStart(2, '0')} h`;

function RouteTile({ ctx, tile, text }: { readonly ctx: UiContext; readonly tile: Extract<Tile, { kind: 'route' }>; readonly text: Messages }) {
  const { verdict } = tile.file;
  const preview = verdict.kind === 'route' ? verdict.preview : undefined;
  const profile = useDrawing(
    (container) =>
      ctx.render(routeProfileCapability, container, {
        route: `preview/${tile.file.id}`,
        variant: 'card',
        ...(preview?.sparkline ? { preview: { title: preview.title, sparkline: preview.sparkline } } : {}),
      }),
    tile.file.id,
  );
  if (!preview) return null;
  return (
    <div className="fd-route">
      <Card
        label={preview.title}
        classifier={text.videoRoute}
        title={preview.title}
        details={[
          km(preview.distance),
          `${Math.round(preview.ascent)} m`,
          preview.duration === undefined ? undefined : duration(preview.duration),
        ]}
        backdrop={<div ref={profile} className="fd-profile" />}
      />
    </div>
  );
}

function Layer({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const drop = useStateEntries(ctx, fileDropState).get(FILE_DROP_KEY);
  const [hidden, setHidden] = useState<FileDrop>();
  // What letting go did is said for a moment; the next drag shows the layer again.
  useEffect(() => {
    if (drop?.phase !== 'done') return undefined;
    const timer = setTimeout(() => setHidden(drop), DONE_SHOWN);
    return () => clearTimeout(timer);
  }, [drop]);
  if (!drop || hidden === drop) return null;
  // Files ridrs cannot import are ignored: no layer for them, and no tile beside others. While
  // nothing is known yet the layer waits, so a file that turns out to be one does not flash it.
  const known = drop.files.some((file) => file.verdict.kind === 'workouts' || file.verdict.kind === 'route');
  if (drop.phase === 'over' && !known) return null;

  const { workouts, routes } = addable(drop.files);
  // Let go while a file is still read, it is added once it is read, if it can be.
  const reading = drop.files.some((file) => file.verdict.kind === 'reading');
  const takes = drop.phase === 'over' && (reading || workouts + routes > 0);
  const tiles = tilesOf(drop.files);
  const shown = tiles.slice(0, MAX_TILES);
  return (
    <div
      className="fd-layer"
      data-testid="file-drop-layer"
      data-phase={drop.phase}
      data-takes={takes || undefined}
      role="dialog"
      aria-label={text.layerLabel}
      onDragOver={(event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = takes ? 'copy' : 'none';
      }}
      onDrop={(event) => {
        event.preventDefault();
        // Nothing new to add (the library has it, or ridrs cannot import it): the layer goes.
        if (!takes) {
          setHidden(drop);
          return;
        }
        ctx.call(fileDropImportService, {}).catch((error: unknown) => {
          ctx.logger.warn(`The dropped files could not be added: ${String(error)}`);
        });
      }}
      onClick={() => drop.phase === 'done' && setHidden(drop)}
    >
      <style>{PREVIEW_CSS}</style>
      <style>{CSS}</style>
      <div className="fd-panel">
        <p className="fd-say" role="status">
          {sayWhat(drop, text)}
        </p>
        <div className="fd-tiles">
          {shown.map((tile) =>
            tile.kind === 'workout' ? (
              <WorkoutTile key={tile.key} ctx={ctx} tile={tile} text={text} />
            ) : (
              <RouteTile key={tile.key} ctx={ctx} tile={tile} text={text} />
            ),
          )}
        </div>
        {tiles.length > shown.length ? <p className="fd-more">{text.more(tiles.length - shown.length)}</p> : null}
      </div>
    </div>
  );
}

const CSS = `
.fd-layer { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 24px;
  background: rgb(5 9 16 / .82); backdrop-filter: blur(10px) saturate(.6);
  font: 14px system-ui, sans-serif; color: var(--ridrs-text, #f2f5fa); }
.fd-layer[data-phase="over"] .fd-panel { outline: 2px dashed var(--ridrs-line, #24324d); }
.fd-layer[data-takes] .fd-panel { outline-color: var(--ridrs-accent, #4f8cff); }
.fd-panel { display: flex; flex-direction: column; align-items: center; gap: 16px; max-width: min(1000px, 100%);
  padding: 28px; border-radius: calc(var(--ridrs-radius, 16px) + 8px); outline-offset: 10px;
  background: var(--ridrs-bg, #0b111d); box-shadow: 0 24px 80px rgb(0 0 0 / .5); }
.fd-say { margin: 0; font-size: 18px; font-weight: 600; text-align: center; }
.fd-tiles { display: flex; flex-wrap: wrap; justify-content: center; gap: 16px; }
.fd-tile, .fd-route { width: 220px; }
.fd-tile h4 { margin: 0; font-size: 15px; }
/* The card keeps its 16:10 from its width, not from the height of the row. */
.fd-route { align-self: center; }
.fd-route .pv-teaser { width: 100%; height: auto; }
.fd-classifier { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--ridrs-muted, #9aa7bd); }
.fd-chart { min-height: 56px; }
.fd-profile { position: absolute; inset: 0; }
.fd-mark { font-size: 12px; color: var(--ridrs-muted, #9aa7bd); }
.fd-tile[data-duplicate] { opacity: .6; }
.fd-more { margin: 0; color: var(--ridrs-muted, #9aa7bd); }
`;

/** The layer over the main screen while files are dragged onto the window (ADR 0093). */
export const DropLayer: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<Layer ctx={ctx} />);
  return () => root.unmount();
};
