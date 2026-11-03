// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  ConfigSnapshotProvider,
  HostDescription,
  JsonValue,
  RecordingSnapshot,
} from '@ridrs/contracts';

/**
 * The configuration snapshot: the host's description and every provider's section, sorted by
 * section. A provider that throws is recorded as `{ error }` and reported through `onError`.
 */
export function buildConfigSnapshot(
  host: HostDescription,
  providers: readonly ConfigSnapshotProvider[],
  onError: (section: string, message: string) => void = () => undefined,
): Omit<RecordingSnapshot, 'kind'> & {
  readonly host: JsonValue;
  readonly sections: Readonly<Record<string, JsonValue>>;
} {
  const sections: Record<string, JsonValue> = {};
  for (const provider of [...providers].sort((a, b) => a.section.localeCompare(b.section))) {
    try {
      // Through JSON, so the snapshot is exactly what a reader will see.
      sections[provider.section] = JSON.parse(JSON.stringify(provider.snapshot())) as JsonValue;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sections[provider.section] = { error: message };
      onError(provider.section, message);
    }
  }
  return { host: JSON.parse(JSON.stringify(host)) as JsonValue, sections };
}
