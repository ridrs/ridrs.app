// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  athleteProfileState,
  DEFAULT_PROVIDER,
  dataSourceState,
  FILE_DROP_KEY,
  type FileDrop,
  fileDropCancelService,
  fileDropImportService,
  fileDropState,
  routeProfileCapability,
  type UiCapabilityInput,
  type Workout,
  workoutChartCapability,
} from '@ridrs/contracts';
import { Card, iconStyle, PREVIEW_CSS } from '@ridrs/ui-preview';
import { type UiContext, type UiComponent, localizeNumber } from '@ridrs/ui-sdk';
import { useLanguage, useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Messages, messages } from './i18n/index.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as masks in the text colour, as the library's cards. */
const VIDEO = new URL('./assets/icons/video.svg', import.meta.url).href;
const DISTANCE = new URL('./assets/icons/route.svg', import.meta.url).href;
const ASCENT = new URL('./assets/icons/trending-up.svg', import.meta.url).href;
const STAR = new URL('./assets/icons/star.svg', import.meta.url).href;

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
function sayWhat(drop: FileDrop, text: Messages, moving: boolean): string {
  const reading = drop.files.find((file) => file.verdict.kind === 'reading');
  if (drop.phase === 'over' && reading) return text.reading(reading.name);
  if (drop.phase === 'importing') return moving ? text.moving : text.adding;
  if (drop.phase === 'done') {
    const said = [
      drop.saved > 0 ? (drop.moved ? text.moved(drop.saved) : text.added(drop.saved)) : '',
      drop.routes > 0 ? text.importingRoutes(drop.routes) : '',
      drop.failed > 0 ? text.failed(drop.failed) : '',
    ].filter(Boolean);
    return said.length > 0 ? said.join('. ') : text.alreadyThere;
  }
  const { workouts, duplicates, routes } = addable(drop.files);
  const parts = [workouts > 0 ? text.letGoWorkouts(workouts) : '', routes > 0 ? text.letGoRoutes(routes) : ''].filter(
    Boolean,
  );
  if (parts.length > 0) return moving ? text.letGoMove(parts) : text.letGo(parts);
  return duplicates > 0 ? text.alreadyThere : '';
}

/** macOS moves with ⌘ held, as the Finder does; Windows and Linux with Shift, as their file managers do. */
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The platform's move key as the rider reads it. */
export const MOVE_KEY = MAC ? '⌘' : 'Shift';

/**
 * Whether letting go moves the files: the rider holds the platform's move key, or the source of
 * the drag allows nothing but a move (the Finder with ⌘ held offers only that).
 */
function moves(event: {
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly dataTransfer: DataTransfer | null;
}): boolean {
  return (MAC ? event.metaKey : event.shiftKey) || event.dataTransfer?.effectAllowed === 'move';
}

/** A UI capability drawn into a place of this layer, as long as it is shown; new input updates it. */
function useDrawing<I>(
  draw: (container: HTMLElement, input: I) => { update(input: I): void; release(): void },
  input: I,
) {
  const place = useRef<HTMLDivElement>(null);
  const drawing = useRef<{ update(input: I): void; release(): void }>(undefined);
  const latest = useRef(input);
  latest.current = input;
  const drawn = useRef(draw);
  useEffect(() => {
    const container = place.current;
    if (!container) return undefined;
    const made = drawn.current(container, latest.current);
    drawing.current = made;
    // The drawing is a React root of its own: released right after this root commits, not during.
    return () => {
      drawing.current = undefined;
      queueMicrotask(() => made.release());
    };
  }, []);
  useEffect(() => drawing.current?.update(input), [input]);
  return place;
}

/** What colours the workout chart, as in the library: the athlete of the chosen source (ADR 0075). */
type ChartAthlete = NonNullable<UiCapabilityInput<typeof workoutChartCapability>['athlete']>;

function useChartAthlete(ctx: UiContext): ChartAthlete | undefined {
  const profiles = useStateEntries(ctx, athleteProfileState);
  const chosen = useStateEntries(ctx, dataSourceState).get('athlete.profile')?.provider ?? DEFAULT_PROVIDER;
  const profile = profiles.get(chosen)?.data;
  return useMemo(() => {
    if (!profile) return undefined;
    const { ftp, lthr, maxHeartRate, powerZones, heartRateZones } = profile;
    const athlete = {
      ...(ftp === undefined ? {} : { ftp }),
      ...(lthr === undefined ? {} : { lthr }),
      ...(maxHeartRate === undefined ? {} : { maxHeartRate }),
      ...(powerZones === undefined ? {} : { powerZones }),
      ...(heartRateZones === undefined ? {} : { heartRateZones }),
    };
    return Object.keys(athlete).length === 0 ? undefined : athlete;
  }, [profile]);
}

/** The star of a card, as the library shows it; the tile is no card yet, so it does nothing. */
function Star() {
  return (
    <span className="pv-icon fd-inert" aria-hidden="true">
      <span className="pv-glyph" style={iconStyle(STAR)} />
    </span>
  );
}

/** A workout as the own workouts of the library will show it: its name, its chart and its star. */
function WorkoutTile({
  ctx,
  tile,
  text,
  athlete,
  width,
}: {
  readonly ctx: UiContext;
  readonly tile: Extract<Tile, { kind: 'workout' }>;
  readonly text: Messages;
  readonly athlete: ChartAthlete | undefined;
  readonly width: number;
}) {
  const input = useMemo(
    () => ({ workout: tile.workout, variant: 'mini' as const, ...(athlete ? { athlete } : {}) }),
    [tile.workout, athlete],
  );
  const chart = useDrawing((container, first) => ctx.render(workoutChartCapability, container, first), input);
  return (
    <article
      className="pv-card fd-tile"
      style={{ width }}
      aria-label={tile.workout.name}
      data-duplicate={tile.duplicate || undefined}
    >
      <div className="pv-open fd-open">
        <h4>{tile.workout.name}</h4>
        <div ref={chart} className="fd-chart" />
      </div>
      <div className="pv-row">
        <Star />
        {tile.duplicate ? <span className="fd-mark">{text.alreadyThere}</span> : null}
      </div>
    </article>
  );
}

/** A video route as the ride page will show it: its picture, its profile, distance and climb, and its star. */
function RouteTile({
  ctx,
  tile,
  text,
  width,
}: {
  readonly ctx: UiContext;
  readonly tile: Extract<Tile, { kind: 'route' }>;
  readonly text: Messages;
  readonly width: number;
}) {
  const language = useLanguage(ctx);
  const { verdict } = tile.file;
  const preview = verdict.kind === 'route' ? verdict.preview : undefined;
  const input = useMemo(
    () => ({
      route: `preview/${tile.file.id}`,
      variant: 'card' as const,
      ...(preview?.sparkline ? { preview: { title: preview.title, sparkline: preview.sparkline } } : {}),
    }),
    [tile.file.id, preview],
  );
  const profile = useDrawing((container, first) => ctx.render(routeProfileCapability, container, first), input);
  if (!preview) return null;
  return (
    <div className="fd-route" style={{ width }}>
      <Card
        label={preview.title}
        classifier={text.video}
        icon={VIDEO}
        title={preview.title}
        details={[
          { icon: DISTANCE, text: `${localizeNumber((preview.distance / 1000).toFixed(1), language)} km` },
          { icon: ASCENT, text: `${Math.round(preview.ascent)} m` },
        ]}
        image={preview.thumbnail}
        backdrop={<div ref={profile} className="fd-profile" />}
        tools={<Star />}
      />
    </div>
  );
}

/** The library's grids: cards of at least 230 px, routes of at least 300 px (`.pv-cards`). */
const CARD_MIN = 230;
const ROUTE_MIN = 300;

/** How wide `auto-fill, minmax(min, 1fr)` makes a column in `width` with `gap` between. */
function columnWidth(width: number, min: number, gap: number): number {
  const count = Math.max(1, Math.floor((width + gap) / (min + gap)));
  return (width - (count - 1) * gap) / count;
}

/** The side padding of a page of an area (`.pv-page`): wide, and at a compact width. */
const PAGE_PADDING = { wide: 40, compact: 16 };

/**
 * How wide the cards are on the page under the layer: the tiles take the columns of its grids, so
 * a tile is as large as the card it becomes. Without a grid, from the page's width; on a screen
 * without a page (Today), from the main screen's column as a page in it would be.
 */
function measure(document: Document): { readonly card: number; readonly route: number } {
  const view = document.defaultView;
  const grid = document.querySelector<HTMLElement>('.pv-cards');
  const page = document.querySelector<HTMLElement>('.pv-page');
  const column = document.querySelector<HTMLElement>('[data-testid="main-layout"] .ms-column');
  let width = 0;
  let gap = 16;
  let compact = false;
  if (view && grid) {
    width = grid.getBoundingClientRect().width;
    gap = Number.parseFloat(view.getComputedStyle(grid).columnGap) || gap;
    compact = grid.closest('[data-breakpoint="compact"]') !== null;
  } else if (view && page) {
    const style = view.getComputedStyle(page);
    width = page.clientWidth - Number.parseFloat(style.paddingLeft || '0') - Number.parseFloat(style.paddingRight || '0');
    compact = page.closest('[data-breakpoint="compact"]') !== null;
  } else if (column) {
    compact = column.closest('[data-breakpoint="compact"]') !== null;
    width = column.clientWidth - 2 * (compact ? PAGE_PADDING.compact : PAGE_PADDING.wide);
  }
  // Nothing to measure (the headless DOM of the scenarios has no layout): the grids' least widths.
  if (!(width > 0)) return { card: CARD_MIN, route: ROUTE_MIN };
  return { card: columnWidth(width, CARD_MIN, gap), route: compact ? width : columnWidth(width, ROUTE_MIN, gap) };
}

function useCardWidths(place: RefObject<HTMLElement | null>, shown: boolean) {
  const [widths, setWidths] = useState({ card: CARD_MIN, route: ROUTE_MIN });
  // Before the layer is painted: the tiles never show at another size first.
  useLayoutEffect(() => {
    const document = place.current?.ownerDocument;
    if (!shown || !document) return undefined;
    const update = () => setWidths(measure(document));
    update();
    document.defaultView?.addEventListener('resize', update);
    return () => document.defaultView?.removeEventListener('resize', update);
  }, [place, shown]);
  return widths;
}

function Layer({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const athlete = useChartAthlete(ctx);
  const drop = useStateEntries(ctx, fileDropState).get(FILE_DROP_KEY);
  const [hidden, setHidden] = useState<FileDrop>();
  const [moving, setMoving] = useState(false);
  const place = useRef<HTMLDivElement>(null);
  // What letting go did is said for a moment; the next drag shows the layer again.
  useEffect(() => {
    if (drop?.phase !== 'done') return undefined;
    const timer = setTimeout(() => setHidden(drop), DONE_SHOWN);
    return () => clearTimeout(timer);
  }, [drop]);
  const shown = drop !== undefined && hidden !== drop;
  // Files ridrs cannot import are ignored: no layer for them, and no tile beside others. While
  // nothing is known yet the layer waits, so a file that turns out to be one does not flash it.
  const known = drop?.files.some((file) => file.verdict.kind === 'workouts' || file.verdict.kind === 'route') ?? false;
  const visible = shown && !(drop.phase === 'over' && !known);
  const widths = useCardWidths(place, visible);

  // Escape takes the layer away: a hovering drag is forgotten, so letting go adds nothing.
  useEffect(() => {
    const document = place.current?.ownerDocument;
    if (!visible || !document || !drop) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setHidden(drop);
      if (drop.phase === 'over') {
        ctx.call(fileDropCancelService, {}).catch((error: unknown) => {
          ctx.logger.warn(`The drag could not be cancelled: ${String(error)}`);
        });
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [ctx, drop, visible]);

  if (!visible || !drop) return <div ref={place} hidden />;

  const { workouts, routes } = addable(drop.files);
  // Let go while a file is still read, it is added once it is read, if it can be.
  const reading = drop.files.some((file) => file.verdict.kind === 'reading');
  const takes = drop.phase === 'over' && (reading || workouts + routes > 0);
  const tiles = tilesOf(drop.files);
  const shownTiles = tiles.slice(0, MAX_TILES);
  return (
    <div
      ref={place}
      className="fd-layer"
      data-testid="file-drop-layer"
      data-phase={drop.phase}
      data-takes={takes || undefined}
      data-moving={moving || undefined}
      role="dialog"
      aria-label={text.layerLabel}
      onDragOver={(event) => {
        event.preventDefault();
        const now = moves(event);
        if (now !== moving) setMoving(now);
        if (event.dataTransfer) event.dataTransfer.dropEffect = takes ? (now ? 'move' : 'copy') : 'none';
      }}
      onDrop={(event) => {
        event.preventDefault();
        // Nothing new to add (the library has it, or ridrs cannot import it): the layer goes.
        if (!takes) {
          setHidden(drop);
          return;
        }
        const move = moves(event);
        setMoving(move);
        ctx.call(fileDropImportService, move ? { move } : {}).catch((error: unknown) => {
          ctx.logger.warn(`The dropped files could not be added: ${String(error)}`);
        });
      }}
      onClick={() => drop.phase === 'done' && setHidden(drop)}
    >
      <style>{PREVIEW_CSS}</style>
      <style>{CSS}</style>
      <div className="fd-frame">
        <header className="fd-head">
          <p className="fd-caption">{text.caption}</p>
          <p className="fd-hint">{text.moveHint(MOVE_KEY)}</p>
        </header>
        <div className="fd-tiles">
          {shownTiles.map((tile) =>
            tile.kind === 'workout' ? (
              <WorkoutTile key={tile.key} ctx={ctx} tile={tile} text={text} athlete={athlete} width={widths.card} />
            ) : (
              <RouteTile key={tile.key} ctx={ctx} tile={tile} text={text} width={widths.route} />
            ),
          )}
        </div>
        <footer className="fd-foot">
          {tiles.length > shownTiles.length ? <p className="fd-more">{text.more(tiles.length - shownTiles.length)}</p> : null}
          <p className="fd-say" role="status">
            {sayWhat(drop, text, moving)}
          </p>
        </footer>
      </div>
    </div>
  );
}

const CSS = `
.fd-layer { position: fixed; inset: 0; z-index: 1000;
  background: rgb(5 9 16 / .82); backdrop-filter: blur(10px) saturate(.6);
  font: 15px/1.4 var(--ridrs-font-text); color: var(--ridrs-text); }
/* The place to let go: the whole window, a little inside its edge. */
.fd-frame { position: absolute; inset: 16px; display: flex; flex-direction: column; align-items: center;
  gap: 16px; padding: 24px; border: 2px dashed var(--ridrs-line);
  border-radius: var(--ridrs-radius-lg); transition: border-color .15s; }
.fd-layer[data-takes] .fd-frame { border-color: var(--ridrs-accent); }
.fd-layer:not([data-phase="over"]) .fd-frame { border-color: transparent; }
/* The caption is pressed into the backdrop: grey, a light edge below, a dark one above. */
.fd-head { display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; }
.fd-caption, .fd-hint { margin: 0; color: var(--ridrs-text-muted);
  text-shadow: 0 1px 0 rgb(255 255 255 / .08), 0 -1px 0 rgb(0 0 0 / .75); }
.fd-caption { font: 500 14px/1.3 var(--ridrs-font-text); letter-spacing: .08em; text-transform: uppercase; }
.fd-hint { font-size: var(--ridrs-size-small); }
.fd-tiles { flex: 1; display: flex; flex-wrap: wrap; justify-content: center; align-content: center;
  align-items: center; gap: var(--ridrs-gap); width: 100%; min-height: 0; overflow: auto; }
.fd-open { width: 100%; cursor: inherit; }
.fd-open h4 { margin: 0; font-size: 16px; font-weight: 400; }
.fd-chart { pointer-events: none; }
.fd-chart:empty { display: none; }
.fd-inert { pointer-events: none; cursor: inherit; }
/* The card keeps its 16:10 from its width, not from the height of the row. */
.fd-route .pv-teaser { width: 100%; height: auto; }
.fd-profile { position: absolute; inset: 0; }
.fd-mark { font-size: 12px; color: var(--ridrs-text-muted); }
.fd-tile[data-duplicate] { opacity: .6; }
.fd-foot { display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; }
.fd-say, .fd-more { margin: 0; font-size: 14px; color: var(--ridrs-text-muted); }
.fd-layer[data-takes] .fd-say { color: var(--ridrs-text); }
`;

/** The layer over the main screen while files are dragged onto the window (ADR 0093). */
export const DropLayer: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<Layer ctx={ctx} />);
  return () => root.unmount();
};
