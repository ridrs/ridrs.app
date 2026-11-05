// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type ActivityState,
  type AppFiles,
  activityInterruptedEvent,
  activityStartRequestedEvent,
  activityStateChangedEvent,
  configSnapshotCapability,
  type DeviceConnectionChangedPayload,
  type Diagnostic,
  definePlugin,
  deviceConnectionChangedEvent,
  type EventEnvelope,
  type HostDescription,
  type PhysicsState,
  type PluginContext,
  physicsStateEvent,
  recordingCompletedEvent,
  recordingFailedEvent,
  recordingFinishRequestedEvent,
  recordingRecoverableChangedEvent,
  storageAppFilesCapability,
} from '@ridrs/contracts';
import {
  buildConfigSnapshot,
  type CommittedJournal,
  committedJournal,
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
  /** The interrupted ride on offer (ADR 0057): continued by the composition root or finished. */
  offered?: { readonly openPath: string };
  /**
   * A continuing host (ADR 0057): the journal to go on with. Until its `activity.interrupted`
   * input everything is the rebuilt past; from it on, envelopes wait here while the file is
   * cut back to its committed part, then go to it.
   */
  continuing?: { readonly file: string; waiting?: EventEnvelope[]; attached: boolean };
}

/** Plugin types a replay or a continuation does not run on recorded data: they may differ. */
const INPUT_SIDE_TYPES = new Set(['transport', 'storage', 'recording', 'export', 'ui']);

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

/** Completes an open recording a crash left behind, as `recovered`. */
async function sealOrphan(
  ctx: PluginContext,
  recorder: Recorder,
  openPath: string,
  why?: string,
): Promise<void> {
  const path = openPath.slice(0, -'.jsonl'.length);
  try {
    const { text } = recoverRecording(
      new TextDecoder().decode(await recorder.storage.read(openPath)),
    );
    const { recording, bytes } = await seal(recorder.storage, openPath, path, text);
    ctx.reportDiagnostic('recording-recovered', `Recovered the interrupted recording "${path}"`, {
      file: path,
      status: recording.footer?.status,
      ...(why ? { notContinued: why } : {}),
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

/**
 * Whether the ride can go on with the plugins as they are now: the simulation plugins of the
 * recording must all run, each in its recorded version; different code could compute a different
 * state. Input-side plugins may differ (ADR 0057).
 */
function whyNotContinuable(journal: CommittedJournal, current: HostDescription): string | undefined {
  if (!journal.ride) {
    return 'no-ride';
  }
  if (!journal.recording.header.runId) {
    return 'no-run-id';
  }
  const recorded = ((journal.recording.snapshot.host as unknown as HostDescription).plugins ?? [])
    .filter((p) => p.state === 'started' && !p.types.some((t) => INPUT_SIDE_TYPES.has(t)));
  // At start-up the plugins after this one are still starting: present and not failed counts.
  const now = new Map(
    current.plugins
      .filter((p) => p.state !== 'failed' && p.state !== 'blocked')
      .map((p) => [p.id, p.version] as const),
  );
  if (recorded.some((p) => !now.has(p.id))) {
    return 'plugin-missing';
  }
  if (recorded.some((p) => now.get(p.id) !== p.version)) {
    return 'plugin-version-changed';
  }
  return undefined;
}

/**
 * At start: the newest open recording whose ride can go on is offered to be continued or
 * finished (ADR 0057); every other open recording a crash left behind is completed as
 * `recovered`, as before.
 */
async function recoverOrphans(ctx: PluginContext, recorder: Recorder): Promise<void> {
  const entries = await recorder.storage.list(RECORDINGS_DIRECTORY);
  const rides: Array<{ readonly openPath: string; readonly journal: CommittedJournal }> = [];
  for (const { path: openPath } of entries) {
    if (
      !openPath.endsWith(OPEN_RECORDING_EXTENSION) ||
      openPath === recorder.ride?.openPath ||
      openPath === recorder.continuing?.file
    ) {
      continue;
    }
    let journal: CommittedJournal | undefined;
    try {
      journal = committedJournal(new TextDecoder().decode(await recorder.storage.read(openPath)));
    } catch {
      journal = undefined;
    }
    const why = journal ? whyNotContinuable(journal, ctx.host.describe()) : 'unreadable';
    if (journal && why === undefined) {
      rides.push({ openPath, journal });
    } else {
      await sealOrphan(ctx, recorder, openPath, why);
    }
  }
  rides.sort((a, b) => b.journal.recording.header.startedAt - a.journal.recording.header.startedAt);
  const [newest, ...older] = rides;
  for (const { openPath } of older) {
    await sealOrphan(ctx, recorder, openPath, 'older');
  }
  if (!newest || ctx.signal.aborted) {
    return;
  }
  const { openPath, journal } = newest;
  const distance = distanceOf(journal.recording);
  recorder.offered = { openPath };
  ctx.events.publish(recordingRecoverableChangedEvent, {
    ride: {
      sessionId: journal.recording.header.sessionId,
      file: openPath,
      startedAt: journal.recording.header.startedAt,
      lastRecordAt: journal.lastRecordAt,
      ...(distance !== undefined ? { distance } : {}),
    },
  });
}

/** The rider finishes the interrupted ride on offer: it is completed as `recovered`. */
async function finishOffered(ctx: PluginContext, recorder: Recorder, file: string): Promise<void> {
  if (recorder.offered?.openPath !== file) {
    return;
  }
  recorder.offered = undefined;
  await sealOrphan(ctx, recorder, file);
  if (!ctx.signal.aborted) {
    ctx.events.publish(recordingRecoverableChangedEvent, {});
  }
}

/**
 * A continuing host reached the interruption: cuts the journal back to its committed part, then
 * records on in it, numbering lines on from its last `seq` (ADR 0057).
 */
async function attach(ctx: PluginContext, recorder: Recorder, file: string): Promise<void> {
  const continuing = recorder.continuing;
  if (!continuing) {
    return;
  }
  let journal: CommittedJournal | undefined;
  try {
    journal = committedJournal(new TextDecoder().decode(await recorder.storage.read(file)));
    if (!journal?.ride) {
      throw new Error('it holds no ride');
    }
    await recorder.storage.replace(file, new TextEncoder().encode(journal.text));
  } catch (error) {
    continuing.waiting = undefined;
    ctx.reportDiagnostic(
      'recording-failed',
      `The interrupted recording "${fileNameOf(file)}" could not be continued: ${reason(error)}`,
      { file },
    );
    return;
  }
  const { header } = journal.recording;
  const ride: Ride = {
    sessionId: header.sessionId,
    startedAt: header.startedAt,
    openPath: file,
    path: file.slice(0, -'.jsonl'.length),
    writer: RecordingWriter.continuing(journal.recording),
    pending: [],
    lines: journal.recording.lines,
    writes: Promise.resolve(),
    finishing: false,
    closed: false,
    failed: false,
    syncSoon: false,
    distance: distanceOf(journal.recording),
  };
  recorder.ride = ride;
  const waiting = continuing.waiting ?? [];
  continuing.waiting = undefined;
  continuing.attached = true;
  for (const envelope of waiting) {
    record(ctx, recorder, ride, envelope);
  }
  flush(ctx, recorder, ride);
  sync(ctx, recorder, ride);
  ride.timer = setInterval(() => flush(ctx, recorder, ride), RECORDING_DEFAULTS.flushIntervalMs);
  ride.syncTimer = setInterval(() => sync(ctx, recorder, ride), RECORDING_DEFAULTS.syncIntervalMs);
}

/** One envelope of a running ride goes to its recording. */
function record(ctx: PluginContext, recorder: Recorder, ride: Ride, envelope: EventEnvelope): void {
  if (ride.closed) {
    return;
  }
  if (!ride.failed) {
    ride.pending.push(ride.writer.event(serializeEnvelope(envelope), false));
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

function onEvent(ctx: PluginContext, recorder: Recorder, envelope: EventEnvelope): void {
  const continuing = recorder.continuing;
  if (continuing && !continuing.attached) {
    if (continuing.waiting) {
      continuing.waiting.push(envelope);
    } else if (envelope.type === activityInterruptedEvent.id && envelope.input) {
      // What the continuing host published before was the rebuilt past: it is in the file.
      continuing.waiting = [envelope];
      void attach(ctx, recorder, continuing.file);
    }
    return;
  }
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
    record(ctx, recorder, ride, envelope);
  }
}

function onDiagnostic(ctx: PluginContext, recorder: Recorder, diagnostic: Diagnostic): void {
  if (recorder.continuing && !recorder.continuing.attached) {
    return;
  }
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
  const continuing = ctx.host.describe().continuing;
  const recorder: Recorder = {
    storage: ctx.capabilities.get(storageAppFilesCapability),
    observed: 0,
    buffer: [],
    connections: new Map(),
    ...(continuing ? { continuing: { file: continuing.file, attached: false } } : {}),
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
    ctx.events.subscribe(recordingFinishRequestedEvent, ({ payload }) => {
      void finishOffered(ctx, recorder, payload.file);
    });
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
