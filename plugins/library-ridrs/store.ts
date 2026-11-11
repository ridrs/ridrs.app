// SPDX-License-Identifier: AGPL-3.0-or-later

import { type AppFiles, RidrsError, type Workout, workoutSchema } from '@ridrs/contracts';

/**
 * The rider's own and imported workouts as app files (ADR 0052, domain data; the planner's cache
 * lives in `training/` the same way): one canonical JSON file per workout, so a save or a removal
 * replaces or deletes one file atomically and the library needs no index to keep in step. The
 * original bytes of an import are a file named by their hash (ADR 0081, layer 3); copies of one
 * import share it, and it goes with the last workout that names it.
 */
export const WORKOUTS_DIRECTORY = 'training/workouts';
export const ORIGINALS_DIRECTORY = 'training/originals';

const workoutPath = (id: string) => `${WORKOUTS_DIRECTORY}/${encodeURIComponent(id)}.json`;
const originalPath = (hash: string) => `${ORIGINALS_DIRECTORY}/${hash}`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** SHA-256 of the bytes as lower-case hex: what `source.originalHash` holds. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export class WorkoutStore {
  /** The kept workouts by id. */
  readonly workouts = new Map<string, Workout>();

  constructor(
    private readonly files: AppFiles,
    private readonly warn: (message: string, error: unknown) => void,
  ) {}

  /** Reads every kept workout; a file that is not a valid workout is skipped and logged. */
  async load(): Promise<void> {
    for (const { path } of await this.files.list(WORKOUTS_DIRECTORY)) {
      if (!path.endsWith('.json')) continue;
      try {
        const parsed = workoutSchema.parse(JSON.parse(decoder.decode(await this.files.read(path))));
        this.workouts.set(parsed.id, parsed);
      } catch (error) {
        this.warn(`Skipped the workout file ${path}`, error);
      }
    }
  }

  /**
   * Keeps a workout, and its original when given. The original must match the hash the workout
   * names (or the workout gets the hash). Throws `invalid-request` on a mismatch.
   */
  async save(
    workout: Workout,
    original: { readonly fileName: string; readonly data: string } | undefined,
  ): Promise<Workout> {
    let kept = workout;
    let previousHash: string | undefined;
    previousHash = this.workouts.get(workout.id)?.source.originalHash;
    if (original) {
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(original.data);
      } catch {
        throw new RidrsError('invalid-request', 'The original file is not valid base64');
      }
      const hash = await sha256Hex(bytes);
      if (workout.source.originalHash !== undefined && workout.source.originalHash !== hash) {
        throw new RidrsError('invalid-request', 'The original file does not match source.originalHash');
      }
      kept = { ...workout, source: { ...workout.source, originalHash: hash } };
      await this.files.write(originalPath(hash), bytes);
    }
    await this.files.replace(workoutPath(kept.id), encoder.encode(`${JSON.stringify(kept, null, 2)}\n`));
    this.workouts.set(kept.id, kept);
    if (previousHash && previousHash !== kept.source.originalHash) {
      await this.dropOriginalIfUnused(previousHash);
    }
    return kept;
  }

  /** Removes a workout; its original stays while another workout names it. */
  async remove(id: string): Promise<boolean> {
    const workout = this.workouts.get(id);
    if (!workout) return false;
    await this.files.remove(workoutPath(id)).catch(() => undefined);
    this.workouts.delete(id);
    if (workout.source.originalHash) {
      await this.dropOriginalIfUnused(workout.source.originalHash);
    }
    return true;
  }

  private async dropOriginalIfUnused(hash: string): Promise<void> {
    for (const workout of this.workouts.values()) {
      if (workout.source.originalHash === hash) return;
    }
    await this.files.remove(originalPath(hash)).catch(() => undefined);
  }
}
