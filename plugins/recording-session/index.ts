// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type ActivityState,
  type AppFiles,
  activityStartRequestedEvent,
  activityStateChangedEvent,
  configSnapshotCapability,
  type DeviceConnectionChangedPayload,
  type Diagnostic,
  definePlugin,
  deviceConnectionChangedEvent,
  type EventEnvelope,
  type PhysicsState,
  type PluginContext,
  physicsStateEvent,
  recordingCompletedEvent,
  recordingFailedEvent,
  storageAppFilesCapability,
} from '@ridrs/contracts';
import {
  buildConfigSnapshot,
  fileNameOf,
  gzip,
  lastRecordTime,
  OPEN_RECORDING_EXTENSION,
  openRecordingPath,
  RECORDINGS_DIRECTORY,
  type Recording,
  RecordingWriter,
  readRecording,
  recordingName,
  recordingPath,
  recoverRecording,
  type SerializedEnvelope,
  serializeEnvelope,
} from '@ridrs/recording';

export const RECORDING_DEFAULTS = Object.freeze({
  /** Events before the ride start that go into the recording: the temporal layer's history. */
  prerollMs: 60_000,
  /** The open recording is appended to about this often. */
  flushIntervalMs: 1000,
  /** ... and flushed to the disk this often, and right after a lifecycle event (ADR 0055). */
  syncIntervalMs: 5000,
});

interface Buffered {
  /** Observation order, to merge the kept connection states back in. */
  readonly index: number;
  readonly envelope: SerializedEnvelope;
}

interface Ride {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly openPath: string;
  readonly path: string;
  readonly writer: RecordingWriter;
  /** Lines not yet handed to storage. */
  pending: string[];
  /** Every line written, for the read-back check. */
  lines: number;
  /** Storage writes run one after another, in order. */
  writes: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  syncTimer?: ReturnType<typeof setInterval>;
  /** A lifecycle event waits for its line to be on the disk. */
  syncSoon: boolean;
  /** The `finished` state was observed; the rest of its run-to-completion cascade still belongs to the ride. */
  finishing: boolean;
  endedAt?: number;
  closed: boolean;
  failed: boolean;
  distance?: number;
}

interface Recorder {
  readonly storage: AppFiles;
  observed: number;
  /** The rolling pre-roll: every event of the last 60 s. */
  buffer: Buffered[];
  /** The latest connection state per device that fell out of the pre-roll window. */
  readonly connections: Map<string, Buffered>;
  ride?: Ride;
}

const recorders = new WeakMap<PluginContext, Recorder>();

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Drops buffered events older than `from`, keeping the latest connection state per device. */
function prune(recorder: Recorder, from: number): void {
  let drop = 0;
  for (const item of recorder.buffer) {
    if (item.envelope.timestamp >= from) {
      break;
    }
    if (item.envelope.type === deviceConnectionChangedEvent.id) {
      const payload = (JSON.parse(item.envelope.json) as { payload: DeviceConnectionChangedPayload })
        .payload;
      recorder.connections.set(payload.deviceId, item);
    }
    drop += 1;
  }
  if (drop > 0) {
    recorder.buffer = recorder.buffer.slice(drop);
  }
}

function fail(ctx: PluginContext, ride: Ride, error: unknown): void {
  if (ride.failed) {
    return;
  }
  ride.failed = true;
  ride.pending = [];
  clearInterval(ride.timer);
  clearInterval(ride.syncTimer);
  ctx.reportDiagnostic(
    'recording-failed',
    `The recording of ride ${ride.sessionId} failed: ${reason(error)}`,
    { sessionId: ride.sessionId, file: ride.openPath },
  );
  if (!ctx.signal.aborted) {
    ctx.events.publish(recordingFailedEvent, { sessionId: ride.sessionId, reason: reason(error) });
  }
}

/** Hands the pending lines to storage; never blocks the bus. */
function flush(ctx: PluginContext, recorder: Recorder, ride: Ride): void {
  if (ride.failed || ride.pending.length === 0) {
    return;
  }
  const text = ride.pending.join('');
  ride.lines += ride.pending.length;
  ride.pending = [];
  ride.writes = ride.writes
    .then(() => (ride.failed ? undefined : recorder.storage.append(ride.openPath, text)))
    .catch((error: unknown) => fail(ctx, ride, error));
}

/** Flushes what storage was handed to the disk, in the write chain: never on the turn queue. */
function sync(ctx: PluginContext, recorder: Recorder, ride: Ride): void {
  if (ride.failed) {
    return;
  }
  ride.writes = ride.writes
    .then(() => (ride.failed ? undefined : recorder.storage.sync(ride.openPath)))
    .catch((error: unknown) => fail(ctx, ride, error));
}

/** Appends and syncs at once: after the turn's cascade, so the batch ends at a turn boundary. */
function syncSoon(ctx: PluginContext, recorder: Recorder, ride: Ride): void {
  if (ride.syncSoon) {
    return;
  }
  ride.syncSoon = true;
  queueMicrotask(() => {
    ride.syncSoon = false;
    if (!ride.closed) {
      flush(ctx, recorder, ride);
      sync(ctx, recorder, ride);
    }
  });
}

function startRide(
  ctx: PluginContext,
  recorder: Recorder,
  running: SerializedEnvelope,
  state: Extract<ActivityState, { state: 'running' }>,
): void {
  const { sessionId, startedAt } = state;
  prune(recorder, startedAt - RECORDING_DEFAULTS.prerollMs);
  // The request that started this ride is the first event of the ride, not of the pre-roll.
  let split = recorder.buffer.length;
  for (let i = recorder.buffer.length - 1; i >= 0; i -= 1) {
    if (recorder.buffer[i]?.envelope.type === activityStartRequestedEvent.id) {
      split = i;
      break;
    }
  }
  const preroll = [
    ...[...recorder.connections.values()].sort((a, b) => a.index - b.index),
    ...recorder.buffer.slice(0, split),
  ];
  const live = recorder.buffer.slice(split);

  const description = ctx.host.describe();
  const failedSections: Array<{ section: string; message: string }> = [];
  const snapshot = buildConfigSnapshot(
    description,
    ctx.capabilities.getAll(configSnapshotCapability),
    (section, message) => failedSections.push({ section, message }),
  );
  const writer = new RecordingWriter();
  const { ridrsVersion, runtime, os, appVersion } = description.platform;
  const name = recordingName(startedAt, sessionId);
  const ride: Ride = {
    sessionId,
    startedAt,
    openPath: openRecordingPath(name),
    path: recordingPath(name),
    writer,
    pending: [
      writer.header({
        format: 'ridrs.recording',
        formatVersion: 1,
        ridrsVersion,
        sessionId,
        runId: description.runId,
        startedAt,
        timeZoneOffsetMinutes: -new Date(startedAt).getTimezoneOffset(),
        platform: { runtime, os, appVersion },
        prerollMs: RECORDING_DEFAULTS.prerollMs,
      }),
      writer.snapshot(snapshot),
      ...preroll.map((item) => writer.event(item.envelope, true)),
      ...live.map((item) => writer.event(item.envelope, false)),
      writer.event(running, false),
    ],
    lines: 0,
    writes: Promise.resolve(),
    finishing: false,
    closed: false,
    failed: false,
    syncSoon: false,
  };
  recorder.ride = ride;
  for (const { section, message } of failedSections) {
    ctx.reportDiagnostic(
      'config-snapshot-failed',
      `The configuration section "${section}" failed: ${message}`,
      { section },
    );
  }
  flush(ctx, recorder, ride);
  sync(ctx, recorder, ride);
  ride.timer = setInterval(() => flush(ctx, recorder, ride), RECORDING_DEFAULTS.flushIntervalMs);
  ride.syncTimer = setInterval(() => sync(ctx, recorder, ride), RECORDING_DEFAULTS.syncIntervalMs);
}

/** The physics distance of the last `physics.state` of a recording. */
function distanceOf(recording: Recording): number | undefined {
  const last = recording.events.findLast((e) => e.envelope.type === physicsStateEvent.id);
  return last ? (last.envelope.payload as PhysicsState).distance : undefined;
}

/**
 * Compresses an open recording to `.ridrs`, reads it back, checks it and only then removes the
 * open file. Returns the verified recording and its size.
 */
async function seal(
  storage: AppFiles,
  openPath: string,
  path: string,
  text: string,
): Promise<{ recording: Recording; bytes: number }> {
  const expectedLines = text.split('\n').length - 1;
  const compressed = await gzip(new TextEncoder().encode(text));
  await storage.write(path, compressed);
  const recording = await readRecording(await storage.read(path));
  if (recording.lines !== expectedLines || !recording.footer) {
    throw new Error(`"${path}" read back ${recording.lines} of ${expectedLines} lines`);
  }
  await storage.remove(openPath);
  return { recording, bytes: compressed.length };
}

async function closeRide(ctx: PluginContext, recorder: Recorder, ride: Ride): Promise<void> {
  ride.closed = true;
  clearInterval(ride.timer);
  clearInterval(ride.syncTimer);
  ride.pending.push(ride.writer.footer('complete', ride.endedAt ?? ctx.clock.now()));
  flush(ctx, recorder, ride);
  await ride.writes;
  if (ride.failed) {
    return;
  }
  try {
    const open = new TextDecoder().decode(await recorder.storage.read(ride.openPath));
    const { bytes } = await seal(recorder.storage, ride.openPath, ride.path, open);
    if (ctx.signal.aborted) {
      return;
    }
    ctx.events.publish(recordingCompletedEvent, {
      sessionId: ride.sessionId,
      file: ride.path,
      bytes,
      events: ride.writer.eventCount(),
      ...(ride.distance !== undefined ? { distance: ride.distance } : {}),
      durationMs: (ride.endedAt ?? ride.startedAt) - ride.startedAt,
    });
  } catch (error) {
    fail(ctx, ride, error);
  }
}

/** Completes every open recording a crash left behind. */
async function recoverOrphans(ctx: PluginContext, recorder: Recorder): Promise<void> {
  const entries = await recorder.storage.list(RECORDINGS_DIRECTORY);
  for (const { path: openPath } of entries) {
    if (!openPath.endsWith(OPEN_RECORDING_EXTENSION) || openPath === recorder.ride?.openPath) {
      continue;
    }
    const path = openPath.slice(0, -'.jsonl'.length);
    try {
      const { text } = recoverRecording(
        new TextDecoder().decode(await recorder.storage.read(openPath)),
      );
      const { recording, bytes } = await seal(recorder.storage, openPath, path, text);
      ctx.reportDiagnostic('recording-recovered', `Recovered the interrupted recording "${path}"`, {
        file: path,
        status: recording.footer?.status,
      });
      if (ctx.signal.aborted) {
        return;
      }
      const distance = distanceOf(recording);
      ctx.events.publish(recordingCompletedEvent, {
        sessionId: recording.header.sessionId,
        file: path,
        bytes,
        events: recording.events.length,
        ...(distance !== undefined ? { distance } : {}),
        durationMs: lastRecordTime(recording) - recording.header.startedAt,
      });
    } catch (error) {
      ctx.reportDiagnostic(
        'recording-failed',
        `The interrupted recording "${fileNameOf(openPath)}" could not be recovered: ${reason(error)}`,
        { file: openPath },
      );
    }
  }
}

function onEvent(ctx: PluginContext, recorder: Recorder, envelope: EventEnvelope): void {
  const serialized = serializeEnvelope(envelope);
  const ride = recorder.ride;
  const recording = ride !== undefined && !ride.closed;
  if (!recording && envelope.type === activityStateChangedEvent.id) {
    const state = envelope.payload as ActivityState;
    if (state.state === 'running') {
      // Before buffering: the running state is the ride's event, not the pre-roll's.
      startRide(ctx, recorder, serialized, state);
    }
  }
  recorder.buffer.push({ index: recorder.observed, envelope: serialized });
  recorder.observed += 1;
  prune(recorder, envelope.timestamp - RECORDING_DEFAULTS.prerollMs);

  if (ride && recording) {
    if (!ride.failed) {
      ride.pending.push(ride.writer.event(serialized, false));
    }
    if (envelope.type === activityStateChangedEvent.id && !ride.finishing) {
      syncSoon(ctx, recorder, ride);
    }
    if (envelope.type === physicsStateEvent.id) {
      const state = envelope.payload as PhysicsState;
      if (state.sessionId === ride.sessionId) {
        ride.distance = state.distance;
      }
    }
    const state = envelope.type === activityStateChangedEvent.id && (envelope.payload as ActivityState);
    if (state && state.state === 'finished' && state.sessionId === ride.sessionId && !ride.finishing) {
      ride.finishing = true;
      ride.endedAt = state.endedAt;
      // Events published while the bus delivers `finished` (the final physics state) still belong
      // to the ride: close once that run-to-completion cascade is over.
      queueMicrotask(() => void closeRide(ctx, recorder, ride));
    }
  }
}

function onDiagnostic(ctx: PluginContext, recorder: Recorder, diagnostic: Diagnostic): void {
  const ride = recorder.ride;
  if (ride && !ride.closed && !ride.failed) {
    ride.pending.push(ride.writer.diagnostic(diagnostic, ctx.clock.now()));
  }
}

/**
 * Records every ride, from "Start ride" to "Finish ride": every event and diagnostic of the host in
 * publish order, a minute of pre-roll, the configuration snapshot, then compresses and verifies the
 * file. Knows no device, metric or physics plugin: only events, `config.snapshot` and storage.
 */
/** The rolling pre-roll and the tap on the host; one per plugin context. */
function observeHost(ctx: PluginContext): Recorder {
  const existing = recorders.get(ctx);
  if (existing) {
    return existing;
  }
  const recorder: Recorder = {
    storage: ctx.capabilities.get(storageAppFilesCapability),
    observed: 0,
    buffer: [],
    connections: new Map(),
  };
  recorders.set(ctx, recorder);
  ctx.host.observe({
    onEvent: (envelope) => onEvent(ctx, recorder, envelope),
    onDiagnostic: (diagnostic) => onDiagnostic(ctx, recorder, diagnostic),
  });
  return recorder;
}

export default definePlugin({
  // Observes from initialize: events published while other plugins start belong to the pre-roll.
  initialize(ctx) {
    observeHost(ctx);
  },

  start(ctx) {
    // A restarted plugin has a fresh context (and no initialize): it observes from here.
    const recorder = observeHost(ctx);
    void recoverOrphans(ctx, recorder).catch((error: unknown) =>
      ctx.reportDiagnostic(
        'recording-failed',
        `Interrupted recordings could not be listed: ${reason(error)}`,
      ),
    );
  },

  stop(ctx) {
    const recorder = recorders.get(ctx);
    const ride = recorder?.ride;
    if (recorder && ride && !ride.closed) {
      // The host stops mid-ride: what was observed goes to the open file, recovered next start.
      ride.closed = true;
      clearInterval(ride.timer);
      clearInterval(ride.syncTimer);
      flush(ctx, recorder, ride);
      sync(ctx, recorder, ride);
    }
    recorders.delete(ctx);
  },
});
