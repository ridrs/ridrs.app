// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AppFiles,
  type CompletedWorkout,
  DEFAULT_PROVIDER,
  definePlugin,
  linkIdOf,
  type PluginContext,
  recordingRideState,
  storageAppFilesCapability,
  trainingHistoryRemoveService,
  trainingHistoryState,
} from '@ridrs/contracts';
import {
  fitPathFor,
  gunzip,
  isGzip,
  parseRideName,
  RECORDING_EXTENSION,
  RECORDINGS_DIRECTORY,
  type RideSummary,
  ridePath,
  summaryOfText,
} from '@ridrs/recording';

/**
 * The rider's local date of a start, from the offset of the host the ride was recorded on: days
 * since 1970-01-01 to a civil date (Howard Hinnant's algorithm), as simulation code has no `Date`.
 */
function localDateOf(startedAt: number, offsetMinutes: number): string {
  const days = Math.floor((startedAt + offsetMinutes * 60_000) / 86_400_000) + 719_468;
  const era = Math.floor(days / 146_097);
  const dayOfEra = days - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shifted = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shifted + 2) / 5) + 1;
  const month = shifted < 10 ? shifted + 3 : shifted - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The history's entry of a ride, from the summary in its file name (ADR 0111). */
export function rideOf(summary: RideSummary): CompletedWorkout {
  return {
    id: summary.sessionId,
    date: localDateOf(summary.startedAt, summary.timeZoneOffsetMinutes),
    startedAt: summary.startedAt,
    name: summary.name,
    sport: 'virtual-ride',
    ...(summary.durationSeconds !== undefined ? { durationSeconds: summary.durationSeconds } : {}),
    externalId: linkIdOf(summary.sessionId),
    ...(summary.planned ? { planned: summary.planned } : {}),
  };
}

/**
 * Renames a recording named before ADR 0111 after its summary, with its FIT file: written whole
 * under the new name, then the old one removed. Reads the recording's header, footer and workout.
 */
async function rename(storage: AppFiles, file: string, present: ReadonlySet<string>): Promise<string> {
  const bytes = await storage.read(file);
  const text = new TextDecoder().decode(isGzip(bytes) ? await gunzip(bytes) : bytes);
  const path = ridePath(summaryOfText(text));
  if (path !== file) {
    await storage.write(path, bytes);
    await storage.remove(file);
  }
  const fit = fitPathFor(file);
  if (present.has(fit) && fitPathFor(path) !== fit) {
    await storage.write(fitPathFor(path), await storage.read(fit));
    await storage.remove(fit);
  }
  return path;
}

/**
 * The rides saved on this device as `training.history` of the provider `ridrs` (ADR 0076): one
 * entry per sealed recording, from its file name (ADR 0111), so the start reads no recording.
 * Rides are indoor rides, named after their workout, else "Ride"; a ride of a planned workout
 * names its planned entry, so the calendar can match it with its plan. A ride saved later joins
 * the list at once, and one deleted leaves it. A ride removed (`training.history.remove`) is
 * deleted with its recording. Recordings named before ADR 0111 are renamed once, after the start:
 * the history is `loading` until they are.
 */
export default definePlugin({
  async start(ctx) {
    const storage = ctx.capabilities.get(storageAppFilesCapability);
    const rides = new Map<string, CompletedWorkout>();
    // The recording each ride is in, by its session.
    const files = new Map<string, string>();
    let renaming = true;

    const publish = () =>
      ctx.state.set(trainingHistoryState, DEFAULT_PROVIDER, {
        provider: DEFAULT_PROVIDER,
        label: 'ridrs (this device)',
        status: renaming ? 'loading' : 'ready',
        writable: true,
        fetchedAt: ctx.clock.now(),
        data: { workouts: [...rides.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)) },
      });

    /** Adds the ride a sealed recording's name sums up; false for a name of no summary. */
    const add = (file: string): boolean => {
      const summary = parseRideName(file);
      if (!summary) {
        return false;
      }
      files.set(summary.sessionId, file);
      rides.set(summary.sessionId, rideOf(summary));
      return true;
    };

    ctx.services.provide(trainingHistoryRemoveService, async ({ id }) => {
      const file = files.get(id);
      if (file === undefined) {
        throw new Error(`No ride "${id}" is saved on this device`);
      }
      await storage.remove(file);
      files.delete(id);
      rides.delete(id);
      publish();
      return { ok: true };
    });

    const entries = await storage.list(RECORDINGS_DIRECTORY);
    const present = new Set(entries.map((entry) => entry.path));
    const unnamed = entries
      .map((entry) => entry.path)
      .filter((path) => path.endsWith(RECORDING_EXTENSION) && !add(path));
    renaming = unnamed.length > 0;
    publish();
    watchRides(ctx, rides, add, publish);

    // In the background: the start does not wait for the old recordings, one at a time.
    void (async () => {
      for (const file of unnamed) {
        if (ctx.signal.aborted) {
          return;
        }
        try {
          add(await rename(storage, file, present));
        } catch (error) {
          ctx.logger.warn({ error, file }, 'history-ridrs: a recording could not be read');
        }
        if (!ctx.signal.aborted) {
          publish();
        }
      }
      renaming = false;
      if (!ctx.signal.aborted) {
        publish();
      }
    })();
  },
});

function watchRides(
  ctx: PluginContext,
  rides: Map<string, CompletedWorkout>,
  add: (file: string) => boolean,
  publish: () => void,
): void {
  ctx.state.watch(recordingRideState, ({ entries, changed }) => {
    for (const key of changed) {
      const ride = entries.get(key);
      if (ride?.state === 'deleted') {
        if (rides.delete(key)) {
          publish();
        }
      } else if (ride?.state === 'saved' && ride.file && !rides.has(key)) {
        if (add(ride.file)) {
          publish();
        } else {
          ctx.logger.warn({ file: ride.file }, 'history-ridrs: a saved ride has no summary in its name');
        }
      }
    }
  });
}
