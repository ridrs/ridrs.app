// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MediaFiles, RouteOffer, VideoInterpolator, VideoRefinement } from '@ridrs/contracts';
import {
  besideControl,
  entryNamed,
  findControl,
  parseRefinement,
  parseTimedTrack,
  planRefinement,
  plausibleTrack,
  REFINE_FILE,
  REFINE_FOLDER,
  type RefinedSegment,
  type RefinedStretch,
} from '@ridrs/ride';

/** What the refiner works with; each is optional where the app may lack it. */
export interface RefinerDeps {
  readonly media: MediaFiles | undefined;
  readonly interpolator: VideoInterpolator | undefined;
  /** Says how far a route's refinement is, or that it has none (`undefined`). */
  readonly publish: (key: string, state: VideoRefinement | undefined) => void;
  /** Asks the route's source to offer its files anew (`route.refresh`). */
  readonly refresh: (key: string) => Promise<void>;
  readonly warn: (message: string, error: unknown) => void;
}

/** Why a refinement stopped without failing: the rider cancelled it, or a ride began. */
class Stop extends Error {
  constructor(readonly by: 'rider' | 'ride') {
    super(by === 'rider' ? 'The refinement was cancelled' : 'A ride began');
  }
}

/** A refinement that cannot be made, with the reason: skipped, not failed. */
class Skip extends Error {}

const CANCELLED = 'The refinement was cancelled';
const NO_INTERPOLATOR = 'This device cannot compute in-between frames';
const NO_WEBM =
  "WebM and Matroska videos get no in-between frames yet: the Mac's media frameworks cannot read them";

/** A stretch's file by its planned time and factor: the same plan finds the same file. */
export const stretchFile = (stretch: RefinedStretch) =>
  `${stretch.from.toFixed(3).padStart(10, '0')}-${stretch.to.toFixed(3).padStart(10, '0')}x${stretch.factor}.mp4`;

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * Refines the downloaded video routes one at a time and one stretch at a time (ADR 0110): plans
 * them from their track, has the interpolator compute each stretch not yet done, writes
 * `refine/refine.json` after each and asks the source to offer the new files. It waits while a
 * ride runs and goes on after it.
 */
export class Refiner {
  private readonly queue: string[] = [];
  private readonly states = new Map<string, VideoRefinement>();
  private running: { key: string; controller: AbortController } | undefined;
  private riding = false;
  private disposed = false;
  private pumping = false;

  constructor(private readonly deps: RefinerDeps) {}

  /** The routes on offer: those downloaded and new to the refiner join the queue; those gone leave it. */
  offers(entries: ReadonlyMap<string, RouteOffer>): void {
    for (const [key, offer] of entries) {
      const ready = offer.kind === 'video' && offer.availability.state === 'ready' && offer.availability.files !== undefined;
      if (ready && !this.states.has(key)) this.enqueue(key);
      if (!ready && this.states.has(key)) this.forget(key);
    }
    for (const key of [...this.states.keys()]) if (!entries.has(key)) this.forget(key);
    void this.pump();
  }

  /** Starts a route's refinement again, at the end of the queue. */
  start(key: string): void {
    if (this.running?.key === key || this.queue.includes(key)) return;
    this.enqueue(key);
    void this.pump();
  }

  /** Cancels a route's refinement until it is started again; the stretches done stay. */
  cancel(key: string): void {
    const at = this.queue.indexOf(key);
    if (at >= 0) {
      this.queue.splice(at, 1);
      this.set(key, { status: 'skipped', reason: CANCELLED });
    }
    if (this.running?.key === key) this.running.controller.abort(new Stop('rider'));
  }

  /** Stops for good: the running stretch is cancelled, nothing more is said. */
  dispose(): void {
    this.disposed = true;
    this.queue.splice(0);
    this.running?.controller.abort(new Stop('rider'));
  }

  /** Whether a ride runs or is paused: the refinement waits for its end. */
  ride(active: boolean): void {
    this.riding = active;
    if (active) this.running?.controller.abort(new Stop('ride'));
    else void this.pump();
  }

  private enqueue(key: string): void {
    this.queue.push(key);
    this.set(key, { status: 'waiting' });
  }

  private forget(key: string): void {
    const at = this.queue.indexOf(key);
    if (at >= 0) this.queue.splice(at, 1);
    if (this.running?.key === key) this.running.controller.abort(new Stop('rider'));
    this.states.delete(key);
    if (!this.disposed) this.deps.publish(key, undefined);
  }

  private set(key: string, state: VideoRefinement): void {
    if (this.disposed) return;
    this.states.set(key, state);
    this.deps.publish(key, state);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.riding && this.queue.length > 0) {
        const key = this.queue.shift() as string;
        const controller = new AbortController();
        this.running = { key, controller };
        try {
          const stretches = await this.refine(key, controller.signal);
          this.set(key, { status: 'done', stretches });
        } catch (error) {
          const reason = controller.signal.reason ?? error;
          if (reason instanceof Stop && reason.by === 'ride') {
            this.queue.unshift(key);
            this.set(key, { status: 'waiting' });
          } else if (reason instanceof Stop) {
            this.set(key, { status: 'skipped', reason: CANCELLED });
          } else if (error instanceof Skip || (error instanceof Error && error.message.startsWith(NO_INTERPOLATOR))) {
            this.set(key, { status: 'skipped', reason: error.message });
          } else {
            this.deps.warn(`video-refine: "${key}" could not be refined`, error);
            this.set(key, { status: 'failed', reason: error instanceof Error ? error.message : String(error) });
          }
        } finally {
          this.running = undefined;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Refines one route; resolves with how many stretches it has. */
  private async refine(key: string, signal: AbortSignal): Promise<number> {
    const { media, interpolator } = this.deps;
    if (!media) throw new Skip('This app has no media storage');
    if (!interpolator) throw new Skip(NO_INTERPOLATOR);
    const folder = `videos/${key}`;
    const read = (path: string) => media.read(`${folder}/${path}`);
    const entries = await media.entries(folder);
    const paths = entries.map((entry) => entry.path);
    const found = await findControl(paths, read);
    if (!found) throw new Skip('The route has no control file that names its video and track');
    const { control } = found;
    const videoPath = entryNamed(paths, besideControl(found.path, control.video));
    const video = entries.find((entry) => entry.path === videoPath);
    if (!video || videoPath === undefined) throw new Skip('The route has no video');
    if (video.stored !== undefined) throw new Skip('Its video lies in route.ride');
    if (/\.(webm|mkv)$/i.test(videoPath)) throw new Skip(NO_WEBM);
    const gpxPath = entryNamed(paths, besideControl(found.path, control.gpx)) as string;

    const { track, repairs } = plausibleTrack(parseTimedTrack(decode(await read(gpxPath))));
    const offset = (control.startFrame - 1) / control.framerate;
    // A jump of the track is a cut of the video or of the GPS: no stretch crosses it.
    const cuts = repairs.filter((repair) => repair.kind === 'jump').map((repair) => offset + repair.time);
    const plan = planRefinement({ track, frameRate: control.framerate, offset, cuts });

    // The stretches done before, by their file: kept where the plan still has them.
    let before: readonly RefinedSegment[] = [];
    if (paths.some((path) => path === REFINE_FILE)) {
      try {
        const refinement = parseRefinement(decode(await read(REFINE_FILE)));
        if (refinement.video === control.video) before = refinement.segments;
      } catch {
        // A refinement that does not parse is computed anew.
      }
    }
    const done: RefinedSegment[] = [];
    const total = plan.stretches.reduce((sum, s) => sum + s.to - s.from, 0);
    let finished = 0;
    let shown = -1;
    const progress = (share: number) => {
      const now = total > 0 ? Math.floor(((finished + share) / total) * 100) / 100 : 1;
      if (now !== shown) {
        shown = now;
        this.set(key, { status: 'refining', progress: Math.min(1, now) });
      }
    };
    progress(0);
    /** Why the stretches that could not be computed failed; they are left out, the video plays there. */
    const failures: unknown[] = [];
    for (const stretch of plan.stretches) {
      const file = stretchFile(stretch);
      const kept = before.find((segment) => segment.file === file && paths.includes(`${REFINE_FOLDER}/${file}`));
      if (kept) {
        done.push(kept);
      } else {
        const target = `${folder}/${REFINE_FOLDER}/${file}`;
        const part = `${target}.part`;
        let made: { from: number; to: number } | undefined;
        try {
          made = await interpolator.interpolate(
            { video: `${folder}/${videoPath}`, from: stretch.from, to: stretch.to, factor: stretch.factor, target: part },
            (share) => progress(share * (stretch.to - stretch.from)),
            signal,
          );
          signal.throwIfAborted();
          await media.move(part, target);
          done.push({ from: made.from, to: made.to, factor: stretch.factor, file });
        } catch (error) {
          // Cancelled or a ride began: the whole refinement stops. Any other failure leaves this
          // stretch out, and the next one is computed.
          signal.throwIfAborted();
          if (error instanceof Error && error.message.startsWith(NO_INTERPOLATOR)) throw error;
          failures.push(error);
          this.deps.warn(`video-refine: "${key}" ${stretch.from}–${stretch.to} s left out`, error);
        } finally {
          await media.remove(part);
        }
        if (!made) {
          finished += stretch.to - stretch.from;
          progress(0);
          continue;
        }
        await this.write(folder, control.video, done);
        await this.deps.refresh(key).catch((error: unknown) => this.deps.warn(`video-refine: "${key}" not offered anew`, error));
      }
      finished += stretch.to - stretch.from;
      progress(0);
    }
    // Not one stretch could be computed: the refinement failed, for the reason of the first.
    if (done.length === 0 && failures.length > 0) throw failures[0];
    // The stretches the plan no longer has go.
    for (const segment of before) {
      if (!done.some((kept) => kept.file === segment.file)) await media.remove(`${folder}/${REFINE_FOLDER}/${segment.file}`);
    }
    if (done.length !== before.length || done.some((segment, i) => segment.file !== before[i]?.file)) {
      await this.write(folder, control.video, done);
      await this.deps.refresh(key).catch((error: unknown) => this.deps.warn(`video-refine: "${key}" not offered anew`, error));
    }
    return done.length;
  }

  private async write(folder: string, video: string, segments: readonly RefinedSegment[]): Promise<void> {
    const sorted = [...segments].sort((a, b) => a.from - b.from);
    const text = `${JSON.stringify({ version: 1, video, segments: sorted }, null, 2)}\n`;
    const media = this.deps.media as MediaFiles;
    // Written beside and moved over: a reader never finds half a file.
    await media.write(`${folder}/${REFINE_FILE}.part`, new TextEncoder().encode(text));
    await media.move(`${folder}/${REFINE_FILE}.part`, `${folder}/${REFINE_FILE}`);
  }
}
