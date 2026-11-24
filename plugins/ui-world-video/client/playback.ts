// SPDX-License-Identifier: AGPL-3.0-or-later

import { TIME_STEP, type VideoTime, videoTimeAt } from '@ridrs/ride';

/** The video time moved to `@ridrs/ride` (plan video-zwischenframes, phase 1): kept here for its users. */
export { buildVideoTime, SMOOTHING, TIME_STEP, type VideoTime, videoTimeAt } from '@ridrs/ride';

/**
 * The video time the video world shows, asked every render frame (video-lead-in.feature). A route
 * that starts later in its video than at its first frame gets a lead-in: from the first frame
 * with the rider at the start, the video plays in render time from its first frame and holds at
 * the route's start. Once the rider rolled (a distance beyond 0), the picture follows the
 * distance from the route's start, wherever the lead-in was, and stays on the route. Before the
 * ride's first state it shows the first frame; a continued ride, beyond 0 from the start, has no
 * lead-in. While the lead-in plays (`intro`), "Skip intro" (`skip`) jumps it to the route's start,
 * where it holds until the rider rolls.
 */
export class VideoClock {
  /** Render time (ms) of the lead-in's first frame; undefined before it began. */
  private leadInFrom: number | undefined;
  private rolled = false;
  private skipped = false;
  private playing = false;

  constructor(
    private readonly table: VideoTime,
    private readonly offset: number,
  ) {}

  /** The video time (s) at render time `time` (ms) for the presented `distance` (m). */
  at(time: number, distance: number | undefined): number {
    this.rolled ||= distance !== undefined && distance > 0;
    this.playing = false;
    if (this.rolled) {
      return videoTimeAt(this.table, distance ?? 0, this.offset);
    }
    if (distance === undefined) {
      return 0;
    }
    this.leadInFrom ??= time;
    if (this.skipped) {
      return this.offset;
    }
    const lead = Math.max(0, (time - this.leadInFrom) / 1000);
    this.playing = lead < this.offset;
    return Math.min(this.offset, lead);
  }

  /** Whether the lead-in played up to the route's start at the last `at`: the intro. */
  get intro(): boolean {
    return this.playing;
  }

  /** "Skip intro": the lead-in jumps to the route's start and holds there until the rider rolls. */
  skip(): void {
    this.skipped = true;
    this.playing = false;
  }
}
