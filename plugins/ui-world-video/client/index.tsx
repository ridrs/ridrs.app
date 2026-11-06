// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type ActivityState,
  activityStartRequestedEvent,
  activityStateChangedEvent,
  uiPositionObservedEvent,
  uiTerrainObservedEvent,
} from '@ridrs/contracts';
import { createPhysicsPresentation } from '@ridrs/presentation';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type FrameDecoder, FramePlayer } from './frame-player.ts';
import { loadLibrary, parseGpx, type VideoRoute } from './library.ts';
import { buildVideoTime, type VideoTime, videoTimeAt } from './playback.ts';
import { plausibleTrack, type Repair } from './plausible-track.ts';
import type { Track } from './track.ts';
import { httpRangeReader, readVideoIndex, type VideoIndex } from './video-index.ts';
import { WorldPublisher } from './world-publisher.ts';

/** The contribution id of the landscape in the manifest: a ride's world names it. */
const LANDSCAPE = 'landscape';

/** The route of a running, paused or finished ride in this world; none for any other ride. */
function routeOf(ctx: UiContext, state: ActivityState): string | undefined {
  return 'world' in state && state.world?.landscape === `${ctx.pluginId}/${LANDSCAPE}`
    ? state.world.route
    : undefined;
}

type Loaded =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly route: VideoRoute;
      readonly track: Track;
      readonly videoTime: VideoTime;
      readonly video: VideoIndex;
    };

/** The WebCodecs decoder configuration of a video. */
const decoderConfig = (video: VideoIndex): VideoDecoderConfig => ({
  codec: video.codec,
  codedWidth: video.width,
  codedHeight: video.height,
  ...(video.description ? { description: video.description } : {}),
  optimizeForLatency: true,
});

/** A WebCodecs `VideoDecoder` for the frame player. */
function webCodecsDecoder(video: VideoIndex) {
  return (output: (frame: VideoFrame) => void, error: (error: unknown) => void): FrameDecoder => {
    const decoder = new VideoDecoder({ output, error });
    const open = () => decoder.state !== 'closed';
    return {
      get decodeQueueSize() {
        return decoder.decodeQueueSize;
      },
      configure: () => open() && decoder.configure(decoderConfig(video)),
      decode: ({ data, timestamp, key }) =>
        open() && decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data })),
      flush: () => (decoder.state === 'configured' ? decoder.flush() : Promise.resolve()),
      reset: () => open() && decoder.reset(),
      close: () => open() && decoder.close(),
    };
  };
}

async function loadRoute(
  id: string,
): Promise<{ route: VideoRoute; track: Track; repairs: readonly Repair[]; videoTime: VideoTime; video: VideoIndex }> {
  const route = (await loadLibrary()).find((candidate) => candidate.id === id);
  if (!route) {
    throw new Error(`The video library has no route "${id}"`);
  }
  const [{ track, repairs }, video] = await Promise.all([
    fetch(route.gpxUrl).then(async (response) => plausibleTrack(parseGpx(await response.text()))),
    readVideoIndex(httpRangeReader(route.videoUrl)),
  ]);
  if (typeof VideoDecoder === 'undefined' || !(await VideoDecoder.isConfigSupported(decoderConfig(video))).supported) {
    throw new Error(`This system cannot decode ${video.codec} video`);
  }
  return { route, track, repairs, videoTime: buildVideoTime(track), video };
}

/** The ride's route, once the activity state names one, its track and its video time. */
function useRoute(ctx: UiContext): { readonly id: string | undefined; readonly loaded: Loaded } {
  const [id, setId] = useState<string>();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  useEffect(
    () => ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => setId(routeOf(ctx, payload))),
    [ctx],
  );
  useEffect(() => {
    if (id === undefined) {
      return undefined;
    }
    let current = true;
    setLoaded({ status: 'loading' });
    loadRoute(id).then(
      ({ repairs, ...route }) => {
        if (repairs.length > 0) {
          ctx.logger.info(`Video route "${id}": ${repairs.length} implausible GPS points repaired`, repairs);
        }
        if (current) {
          setLoaded({ status: 'ready', ...route });
        }
      },
      (error: unknown) => {
        ctx.logger.error(`Video route "${id}" could not be loaded`, error);
        if (current) {
          setLoaded({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [ctx, id]);
  return { id, loaded };
}

/**
 * The video world is a sensor like the demo landscape (ADR 0044): every frame of the shell's
 * render clock it shows the video frame at the presented distance (ADR 0061) and tells the host
 * the terrain ahead and where the rider is, all from the route's GPX track.
 */
function useVideoWorld(ctx: UiContext, route: VideoRoute, track: Track, videoTime: VideoTime, video: VideoIndex) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const presentation = createPhysicsPresentation(ctx.events);
    const publisher = new WorldPublisher(track, {
      terrain: ({ samples, ...window }) =>
        ctx.events.publish(uiTerrainObservedEvent, { ...window, samples: [...samples] }),
      position: (position) => ctx.events.publish(uiPositionObservedEvent, position),
    });
    const player = new FramePlayer(video, httpRangeReader(route.videoUrl), webCodecsDecoder(video));
    const offset = (route.startFrame - 1) / route.framerate;
    let ride: string | undefined;
    let distance = 0;
    let drawn: VideoFrame | undefined;
    const stopWatching = ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      publisher.rideState(payload);
      ride = 'sessionId' in payload ? payload.sessionId : undefined;
    });
    publisher.mount();

    const stopFrames = ctx.frames.onFrame((frame) => {
      const shown = presentation.at(frame.time);
      publisher.frame(shown);
      // Before the ride's first state, and while none is presented, the last distance holds.
      if (shown.status === 'available' && shown.sessionId === ride) {
        distance = shown.distance;
      }
      const time = videoTimeAt(videoTime, distance, offset);
      const picture = player.frameAt(time);
      const element = canvas.current;
      if (picture && picture !== drawn && element) {
        element.getContext('2d')?.drawImage(picture, 0, 0, element.width, element.height);
        drawn = picture;
        element.dataset.frameTime = (picture.timestamp / 1e6).toFixed(3);
      }
      if (element) {
        element.dataset.distance = distance.toFixed(2);
        element.dataset.time = time.toFixed(3);
        element.dataset.restarts = String(player.restarts);
      }
      if (player.error !== undefined && element?.dataset.failed === undefined && element) {
        element.dataset.failed = String(player.error);
        ctx.logger.error(`The video of "${route.id}" stopped`, player.error);
      }
      setFinished(distance >= track.length);
    });
    return () => {
      stopFrames();
      stopWatching();
      presentation.dispose();
      player.close();
    };
  }, [ctx, route, track, videoTime, video]);

  return { canvas, finished };
}

const OVERLAY = {
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '8px 16px',
  borderRadius: 10,
  background: 'rgba(11, 18, 32, 0.7)',
  color: '#f2f5fa',
  font: '600 16px system-ui, sans-serif',
  pointerEvents: 'none',
} as const;

function VideoWorld({
  ctx,
  route,
  track,
  videoTime,
  video,
}: {
  readonly ctx: UiContext;
  readonly route: VideoRoute;
  readonly track: Track;
  readonly videoTime: VideoTime;
  readonly video: VideoIndex;
}) {
  const { canvas, finished } = useVideoWorld(ctx, route, track, videoTime, video);
  return (
    <div data-testid="video-world" data-route={route.id} style={{ position: 'absolute', inset: 0, background: '#000' }}>
      <canvas
        ref={canvas}
        data-testid="route-video"
        width={video.width}
        height={video.height}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
      <div style={{ ...OVERLAY, top: 16 }}>
        {route.title} · {(track.length / 1000).toFixed(1)} km
      </div>
      {finished ? (
        <div data-testid="route-finished" style={{ ...OVERLAY, top: '40%', fontSize: 32 }}>
          Route complete
        </div>
      ) : null}
    </div>
  );
}

function VideoLandscapeView({ ctx }: { readonly ctx: UiContext }) {
  const { id, loaded } = useRoute(ctx);
  // Another world's ride, or a free ride: this landscape shows and tells nothing.
  if (id === undefined) {
    return null;
  }
  if (loaded.status !== 'ready') {
    return (
      <div
        data-testid="video-world"
        data-status={loaded.status}
        style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: '#0b1220', color: '#93a1b8' }}
      >
        {loaded.status === 'loading' ? 'Loading the video…' : `The video cannot be shown: ${loaded.message}`}
      </div>
    );
  }
  return (
    <VideoWorld ctx={ctx} route={loaded.route} track={loaded.track} videoTime={loaded.videoTime} video={loaded.video} />
  );
}

export const VideoLandscape: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<VideoLandscapeView ctx={ctx} />);
  return () => root.unmount();
};

/** Drawn with the main screen's tokens (ADR 0058); the fallbacks keep it readable without them. */
const TILE_CSS = `
.vr-tile { display: flex; flex-direction: column; gap: 16px; height: 100%; padding: 24px 28px;
  border: 1px solid var(--ridrs-line, #24324d); border-radius: var(--ridrs-radius, 16px);
  background: var(--ridrs-surface, #131c2e); color: var(--ridrs-text, #f2f5fa); }
.vr-eyebrow { margin: 0; color: var(--ridrs-text-muted, #93a1b8); font-size: 14px; font-weight: 600;
  letter-spacing: .08em; text-transform: uppercase; }
.vr-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px;
  margin: 0; padding: 0; list-style: none; }
.vr-route { display: flex; flex-direction: column; gap: 6px; width: 100%; height: 100%; padding: 16px;
  border: 1px solid var(--ridrs-line, #24324d); border-radius: 12px; cursor: pointer; text-align: left;
  background: var(--ridrs-surface-raised, #1a2540); color: inherit; font: inherit; }
.vr-route:hover { border-color: var(--ridrs-accent, #b8f53b); }
.vr-route:focus-visible { outline: 3px solid var(--ridrs-focus, #fff); outline-offset: 2px; }
.vr-title { font-size: 18px; font-weight: 700; }
.vr-summary { color: var(--ridrs-text-muted, #93a1b8); font-size: 14px; }
.vr-go { margin-top: auto; color: var(--ridrs-accent, #b8f53b); font-weight: 700; }
`;

/** The routes of the video library, each a button that starts a ride along it. */
function VideoRidesView({ ctx }: { readonly ctx: UiContext }) {
  const [routes, setRoutes] = useState<readonly VideoRoute[]>([]);
  useEffect(() => {
    let current = true;
    loadLibrary().then(
      (loaded) => current && setRoutes(loaded),
      (error: unknown) => ctx.logger.warn('The video library could not be read', error),
    );
    return () => {
      current = false;
    };
  }, [ctx]);
  // Without videos the tile shows nothing, and the main screen leaves no gap for it.
  if (routes.length === 0) {
    return null;
  }
  return (
    <section className="vr-tile" aria-label="Video rides" data-testid="video-rides">
      <style>{TILE_CSS}</style>
      <p className="vr-eyebrow">Video rides</p>
      <ul className="vr-list">
        {routes.map((route) => (
          <li key={route.id}>
            <button
              type="button"
              className="vr-route"
              data-testid={`ride-video-${route.id}`}
              onClick={() =>
                ctx.events.publish(activityStartRequestedEvent, {
                  world: { landscape: `${ctx.pluginId}/${LANDSCAPE}`, route: route.id },
                })
              }
            >
              <span className="vr-title">{route.title}</span>
              {route.summary ? <span className="vr-summary">{route.summary}</span> : null}
              <span className="vr-go">Ride this video</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export const VideoRidesTile: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<VideoRidesView ctx={ctx} />);
  return () => root.unmount();
};
