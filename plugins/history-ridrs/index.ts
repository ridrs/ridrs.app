// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  activityStateSchema,
  type CompletedWorkout,
  DEFAULT_PROVIDER,
  definePlugin,
  linkIdOf,
  type PluginContext,
  type RideWorkout,
  recordingRideState,
  storageAppFilesCapability,
  trainingHistoryState,
} from '@ridrs/contracts';
import {
  RECORDING_EXTENSION,
  RECORDINGS_DIRECTORY,
  type Recording,
  readRecording,
} from '@ridrs/recording';

/**
 * The workout a recorded ride rode: it is part of the ride's activity states (rule 13), so the
 * recording keeps it, with the planned entry it came from.
 */
export function workoutOf(recording: Pick<Recording, 'events'>): RideWorkout | undefined {
  for (const { envelope } of recording.events) {
    if (envelope.type !== activityStateChangedEvent.id) {
      continue;
    }
    const state = activityStateSchema.safeParse(envelope.payload);
    if (state.success && state.data.state !== 'idle' && state.data.workout) {
      return state.data.workout;
    }
  }
  return undefined;
}

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

/**
 * The rides saved on this device as `training.history` of the provider `ridrs` (ADR 0076): one
 * entry per sealed recording, read from its header and footer. Rides are indoor rides, named
 * after their workout, else "Ride"; a ride of a planned workout names its planned entry, so the
 * calendar can match it with its plan. It reconciles like the FIT export (ADR 0069): at start every recording in the app
 * files is read once, and a ride saved or deleted later changes the list at once.
 */
export default definePlugin({
  async start(ctx) {
    const storage = ctx.capabilities.get(storageAppFilesCapability);
    const rides = new Map<string, CompletedWorkout>();

    const publish = () =>
      ctx.state.set(trainingHistoryState, DEFAULT_PROVIDER, {
        provider: DEFAULT_PROVIDER,
        label: 'ridrs (this device)',
        status: 'ready',
        writable: false,
        fetchedAt: ctx.clock.now(),
        data: { workouts: [...rides.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)) },
      });

    const read = async (file: string): Promise<void> => {
      const recording = await readRecording(await storage.read(file));
      const { header, footer } = recording;
      const workout = workoutOf(recording);
      rides.set(header.sessionId, {
        id: header.sessionId,
        date: localDateOf(header.startedAt, header.timeZoneOffsetMinutes),
        startedAt: header.startedAt,
        name: workout?.workout.name ?? 'Ride',
        sport: 'virtual-ride',
        ...(footer ? { durationSeconds: Math.max(0, (footer.endedAt - header.startedAt) / 1000) } : {}),
        externalId: linkIdOf(header.sessionId),
        ...(workout?.planned ? { planned: workout.planned } : {}),
      });
    };

    const warn = (file: string, error: unknown) =>
      ctx.logger.warn({ error, file }, 'history-ridrs: a recording could not be read');

    publish();
    for (const { path } of await storage.list(RECORDINGS_DIRECTORY)) {
      if (ctx.signal.aborted) {
        return;
      }
      if (path.endsWith(RECORDING_EXTENSION)) {
        await read(path).catch((error: unknown) => warn(path, error));
      }
    }
    publish();
    watchRides(ctx, rides, read, warn, publish);
  },
});

function watchRides(
  ctx: PluginContext,
  rides: Map<string, CompletedWorkout>,
  read: (file: string) => Promise<void>,
  warn: (file: string, error: unknown) => void,
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
        const file = ride.file;
        read(file)
          .then(publish)
          .catch((error: unknown) => warn(file, error));
      }
    }
  });
}
