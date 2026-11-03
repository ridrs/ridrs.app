// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  type CapabilityContract,
  type EventDefinition,
  type HostDescription,
  type PhysicsState,
  physicsStateEvent,
} from '@ridrs/contracts';
import { createFileSystemPluginSource } from '@ridrs/core/node';
import { buildActivity, encodeActivity } from '@ridrs/fit';
import { type Recording, readRecording } from '@ridrs/recording';
import { type ReplayResult, replay } from '@ridrs/replay';

/** Exit codes of `ridrs-headless recording …`. */
const EXIT = { ok: 0, different: 1, error: 2 } as const;

export interface RecordingCliContext {
  readonly capabilities: readonly CapabilityContract[];
  readonly events: readonly EventDefinition[];
  readonly resolvePluginDir: (dir: string) => string;
  /** Resolves file arguments against the caller's directory. */
  readonly resolveFile: (file: string) => string;
  readonly out: (line: string) => void;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function distanceOf(recording: Recording): number | undefined {
  const last = recording.events.findLast((e) => e.envelope.type === physicsStateEvent.id);
  return last ? (last.envelope.payload as PhysicsState).distance : undefined;
}

async function load(file: string, context: RecordingCliContext): Promise<Recording> {
  return readRecording(new Uint8Array(await readFile(context.resolveFile(file))), {
    events: context.events,
  });
}

function inspect(recording: Recording, context: RecordingCliContext): void {
  const { header, footer, snapshot } = recording;
  const host = snapshot.host as unknown as HostDescription;
  const out = context.out;
  out(`recording  ${header.format} v${header.formatVersion} (ridrs ${header.ridrsVersion})`);
  out(`session    ${header.sessionId}`);
  out(`started    ${new Date(header.startedAt).toISOString()}`);
  out(`platform   ${header.platform.runtime} ${header.platform.os} ${header.platform.appVersion}`);
  out(`status     ${footer?.status ?? 'open'}`);
  out(`duration   ${formatDuration((footer?.endedAt ?? header.startedAt) - header.startedAt)}`);
  const distance = distanceOf(recording);
  out(`distance   ${distance === undefined ? '-' : `${(distance / 1000).toFixed(2)} km`}`);
  out('plugins');
  for (const plugin of host.plugins ?? []) {
    out(`  ${plugin.id} ${plugin.version} (${plugin.state})`);
  }
  out('events');
  const counts = new Map<string, number>();
  for (const { envelope } of recording.events) {
    counts.set(envelope.type, (counts.get(envelope.type) ?? 0) + 1);
  }
  for (const [type, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    out(`  ${type} ${count}`);
  }
  out(`diagnostics ${recording.diagnostics.length}`);
  for (const diagnostic of recording.diagnostics) {
    out(
      `  ${diagnostic.code}${diagnostic.pluginId ? ` (${diagnostic.pluginId})` : ''}: ${diagnostic.message}`,
    );
  }
}

function report(result: ReplayResult, out: (line: string) => void): void {
  const { configuration } = result;
  for (const change of configuration.versionChanges) {
    out(`version    ${change.plugin}: ${change.recorded} recorded, ${change.current} now`);
  }
  for (const plugin of configuration.missingPlugins) {
    out(`missing    plugin ${plugin}`);
  }
  for (const plugin of configuration.addedPlugins) {
    out(`added      plugin ${plugin}`);
  }
  for (const section of configuration.sections) {
    out(
      `config     ${section.section} ${section.change}${section.paths.length ? `: ${section.paths.join(', ')}` : ''}`,
    );
  }
  for (const stream of result.streams) {
    out(
      `stream     ${stream.type} (${stream.source}) ${stream.matched}/${stream.recorded} matched, ${stream.replayed} replayed`,
    );
  }
  const difference = result.firstDifference;
  if (difference) {
    out(
      `different  first in ${difference.type} (${difference.source}) #${difference.index} at ${new Date(difference.timestamp).toISOString()}, ${difference.path || 'event'}: ${JSON.stringify(difference.recorded)} recorded, ${JSON.stringify(difference.replayed)} replayed`,
    );
  } else {
    out('identical');
  }
}

/** `ridrs-headless recording inspect|replay|export-fit <file>`. Returns the exit code. */
export async function runRecordingCommand(
  args: readonly string[],
  context: RecordingCliContext,
): Promise<number> {
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      output: { type: 'string', short: 'o' },
      plugins: { type: 'string', short: 'p', multiple: true },
    },
    strict: true,
  });
  const [file] = positionals;
  if (!file || !['inspect', 'replay', 'export-fit'].includes(command ?? '')) {
    context.out(
      'usage: ridrs-headless recording inspect|replay|export-fit <file> [--json] [-o <out.fit>]',
    );
    return EXIT.error;
  }
  try {
    const recording = await load(file, context);
    if (command === 'inspect') {
      inspect(recording, context);
      return EXIT.ok;
    }
    if (command === 'export-fit') {
      const activity = buildActivity(recording);
      const output = context.resolveFile(
        values.output ?? file.replace(/\.ridrs(\.jsonl)?$/, '').concat('.fit'),
      );
      await writeFile(output, encodeActivity(activity));
      context.out(`wrote ${output} (${activity.records.length} records)`);
      return EXIT.ok;
    }
    const dirs = values.plugins && values.plugins.length > 0 ? values.plugins : ['plugins'];
    const started = performance.now();
    const result = await replay(recording, {
      sources: dirs.map(context.resolvePluginDir).map(createFileSystemPluginSource),
      capabilities: context.capabilities,
      events: context.events,
    });
    if (values.json) {
      context.out(JSON.stringify(result, null, 2));
    } else {
      report(result, context.out);
      context.out(
        `replayed   ${formatDuration(result.virtualMs)} of ride time in ${Math.round(performance.now() - started)} ms`,
      );
    }
    return result.identical ? EXIT.ok : EXIT.different;
  } catch (error) {
    context.out(`error      ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.error;
  }
}
