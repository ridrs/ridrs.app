// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  type ActivityState,
  type EventEnvelope,
  type PhysicsState,
  type PhysicsStateBatch,
  physicsStateBatchEvent,
  physicsStateEvent,
  type RecoverableRide,
  recordingFinishRequestedEvent,
  recordingRecoverableChangedEvent,
} from '@ridrs/contracts';
import {
  OPEN_RECORDING_EXTENSION,
  parseRecording,
  type Recording,
  readRecording,
} from '@ridrs/recording';
import { continueRecording } from '@ridrs/replay';
import type { RidrsWorld } from '../support/world.ts';
import { currentSessionId, formatOffset, parseOffset } from './physics.steps.ts';
import { memoryFile } from './recording.steps.ts';

/** The text of the one open recording in the memory storage. */
export function openRecordingText(world: RidrsWorld): { path: string; text: string } {
  assert.ok(world.memoryFiles, 'Expected the memory storage');
  const open = [...world.memoryFiles.files].filter(([path]) =>
    path.endsWith(OPEN_RECORDING_EXTENSION),
  );
  assert.equal(open.length, 1, `Open recordings: ${open.map(([p]) => p).join(', ')}`);
  const [path, bytes] = open[0] as [string, Uint8Array];
  return { path, text: new TextDecoder().decode(bytes) };
}

function openRecording(world: RidrsWorld): Recording {
  return parseRecording(openRecordingText(world).text, {
    allowTornLastLine: true,
    requireFooter: false,
  });
}

When('the machine loses power', async function (this: RidrsWorld) {
  assert.ok(this.memoryFiles, 'Expected the memory storage');
  this.memoryFiles.losePower();
  // The host is gone with the power; what it still tries to write fails.
  await this.disposeHost();
  this.memoryFiles.powerRestored();
});

Then(
  'the open recording on the disk holds the {string} state of the ride',
  function (this: RidrsWorld, state: string) {
    const states = openRecording(this)
      .events.filter((e) => e.envelope.type === 'activity.state-changed')
      .map((e) => (e.envelope.payload as ActivityState).state);
    assert.ok(states.includes(state as ActivityState['state']), `States: ${states.join(', ')}`);
  },
);

Then(
  'the open recording on the disk holds the ride up to at least {string}',
  function (this: RidrsWorld, offset: string) {
    const last = openRecording(this).events.at(-1)?.envelope.timestamp ?? 0;
    assert.ok(last >= parseOffset(offset), `The disk holds the ride up to ${formatOffset(last)}`);
  },
);

Then('every line of the open recording on the disk is complete', function (this: RidrsWorld) {
  const { text } = openRecordingText(this);
  assert.ok(text.endsWith('\n'), 'The last line is torn');
  for (const line of text.split('\n').filter(Boolean)) {
    JSON.parse(line);
  }
});

// ---- Continuing an interrupted ride (ADR 0057) -------------------------------------------

Given('the machine lost power', async function (this: RidrsWorld) {
  this.interruptedSessionId = currentSessionId(this);
  this.interruptedFile = openRecordingText(this).path;
  assert.ok(this.memoryFiles, 'Expected the memory storage');
  this.memoryFiles.losePower();
  await this.disposeHost();
  this.memoryFiles.powerRestored();
});

Given('ridrs started again', async function (this: RidrsWorld) {
  await this.ensureHost().start();
  await this.waitForIo(() => offered(this) !== undefined || closedOffer(this), 'the start-up');
});

function offers(world: RidrsWorld): EventEnvelope[] {
  return world.tapped.filter((e) => e.type === recordingRecoverableChangedEvent.id);
}

function offered(world: RidrsWorld): RecoverableRide | undefined {
  return (offers(world).at(-1)?.payload as { ride?: RecoverableRide } | undefined)?.ride;
}

function closedOffer(world: RidrsWorld): boolean {
  return world
    .ensureHost()
    .getDiagnostics()
    .some((d) => d.code === 'recording-recovered');
}

Then('ridrs offers to continue the interrupted ride', function (this: RidrsWorld) {
  const ride = offered(this);
  const recorded = this.ensureHost()
    .getDiagnostics()
    .filter((d) => d.code.startsWith('recording'));
  assert.ok(ride, `ridrs offers no interrupted ride: ${JSON.stringify(recorded)}`);
  assert.equal(ride.sessionId, this.interruptedSessionId);
  assert.equal(ride.file, this.interruptedFile);
});

Then('ridrs offers no interrupted ride any more', function (this: RidrsWorld) {
  assert.ok(offers(this).length > 0, 'ridrs never offered a ride');
  assert.equal(offered(this), undefined);
});

Then('the memory storage still holds its open recording', function (this: RidrsWorld) {
  assert.ok(this.interruptedFile && this.memoryFiles?.files.has(this.interruptedFile));
});

/** What the composition root does on `recording.continue-requested`. */
async function continueInterruptedRide(world: RidrsWorld): Promise<void> {
  const file = offered(world)?.file;
  assert.ok(file && world.memoryFiles, 'Expected an interrupted ride on offer');
  const text = new TextDecoder().decode(await world.memoryFiles.read(file));
  await world.disposeHost();
  world.interruptionMark = world.hostObserved.length;
  await continueRecording(text, {
    ...world.hostOptions(),
    file,
    beforeStart: (host) => world.attachHost(host),
  });
  world.continuedMark = world.hostObserved.length;
  await world.settle();
}

for (const verb of ['continues', 'continued']) {
  When(`the rider ${verb} the interrupted ride`, async function (this: RidrsWorld) {
    await continueInterruptedRide(this);
  });
}

When('the rider finishes the interrupted ride', async function (this: RidrsWorld) {
  const file = offered(this)?.file;
  assert.ok(file, 'Expected an interrupted ride on offer');
  this.ensureHost().publishEvent('ui-bridge', recordingFinishRequestedEvent, { file });
  await this.waitForIo(() => offered(this) === undefined, 'the ride to be sealed');
});

Then('it carries the session of the interrupted ride', function (this: RidrsWorld) {
  assert.equal(currentSessionId(this), this.interruptedSessionId);
});

function physicsSince(world: RidrsWorld, mark: number): PhysicsState[] {
  return world.hostObserved
    .slice(mark)
    .filter((e) => e.type === physicsStateEvent.id)
    .map((e) => e.payload as PhysicsState);
}

Then(
  "the continued ride's latest {string} is from before the interruption",
  function (this: RidrsWorld, eventId: string) {
    assert.equal(eventId, physicsStateEvent.id);
    const rebuilt = physicsSince(this, this.interruptionMark ?? 0);
    const last = rebuilt.at(-1);
    assert.ok(last, 'The continued ride rebuilt no physics state');
    assert.equal(last.sessionId, this.interruptedSessionId);
    assert.ok(last.step > 0, 'The rebuilt ride is at step 0');
    this.interruptedStep = last.step;
  },
);

Then('no physics step ran since the interruption', function (this: RidrsWorld) {
  assert.deepEqual(physicsSince(this, this.continuedMark ?? 0), []);
});

/**
 * The `.ridrs` the interrupted ride ends up in, once sealing is over: the sealed file is read back
 * and checked before the journal is removed, so it exists a moment before sealing ends.
 */
async function sealedRideOf(world: RidrsWorld): Promise<Recording> {
  const journal = world.interruptedFile;
  const file = journal?.replace(/\.jsonl$/, '');
  assert.ok(journal && file && world.memoryFiles, 'Expected an interrupted ride');
  const files = world.memoryFiles.files;
  await world.waitForIo(() => files.has(file) && !files.has(journal), 'the sealed ride');
  world.lastRecordingFile = file;
  return readRecording(memoryFile(world, file));
}

Then('the recording of the interrupted ride is complete', async function (this: RidrsWorld) {
  const recording = await sealedRideOf(this);
  assert.equal(recording.footer?.status, 'complete');
  assert.equal(this.memoryFiles?.files.has(this.interruptedFile ?? ''), false);
});

Then(
  'the recording of the interrupted ride is sealed with the status {string}',
  async function (this: RidrsWorld, status: string) {
    assert.equal((await sealedRideOf(this)).footer?.status, status);
  },
);

Then('its activity states are {string}', async function (this: RidrsWorld, csv: string) {
  const recording = await sealedRideOf(this);
  const states = recording.events
    .filter((e) => !e.preroll && e.envelope.type === 'activity.state-changed')
    .map((e) => (e.envelope.payload as ActivityState).state);
  assert.deepEqual(
    states,
    csv.split(',').map((s) => s.trim()),
  );
});

Then('its physics steps go on without a gap in their numbers', async function (this: RidrsWorld) {
  const recording = await sealedRideOf(this);
  const steps = recording.events
    .filter((e) => e.envelope.type === physicsStateBatchEvent.id)
    .flatMap((e) => (e.envelope.payload as PhysicsStateBatch).samples.map((s) => s.step));
  assert.ok(steps.length > 0);
  assert.deepEqual(
    steps,
    steps.map((_, i) => i),
  );
});
