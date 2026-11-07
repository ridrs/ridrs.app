// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  exportFitState,
  type RecordingRide,
  recordingRideState,
  storageAppFilesCapability,
} from '@ridrs/contracts';
import { buildActivity, encodeActivity } from '@ridrs/fit';
import { fitPathFor, readRecording } from '@ridrs/recording';

/**
 * Exports every saved recording as a FIT activity file next to it. Knows no device, metric or
 * physics plugin: it reads the recording's events. A failure leaves the recording untouched.
 * A deleted ride takes its FIT file with it, also one still being written.
 *
 * It reconciles instead of reacting (ADR 0069): whenever the app state `recording.ride` changes,
 * a saved ride whose FIT file is not in the app files is exported, and a deleted ride's FIT file
 * is removed. So the first delivery (every ride of the run) or a restart writes nothing again.
 */
export default definePlugin({
  start(ctx) {
    const storage = ctx.capabilities.get(storageAppFilesCapability);
    /** Sessions being exported now, and those deleted by the rider meanwhile. */
    const exporting = new Set<string>();
    const deleted = new Set<string>();

    const failed = (file: string, error: unknown) =>
      ctx.reportDiagnostic(
        'fit-export-failed',
        `The FIT export of "${file}" failed: ${error instanceof Error ? error.message : String(error)}`,
        { file },
      );

    const exportRide = async (sessionId: string, recordingFile: string): Promise<void> => {
      const file = fitPathFor(recordingFile);
      const directory = file.slice(0, file.lastIndexOf('/'));
      const there = (await storage.list(directory)).find((entry) => entry.path === file);
      if (there) {
        if (!ctx.signal.aborted) {
          ctx.state.set(exportFitState, sessionId, { sessionId, file, bytes: there.bytes });
        }
        return;
      }
      // The CLI's `recording export-fit` runs the same three calls: same recording, same bytes.
      const activity = buildActivity(await readRecording(await storage.read(recordingFile)));
      const bytes = encodeActivity(activity);
      await storage.write(file, bytes);
      if (deleted.has(sessionId)) {
        await storage.remove(file);
        return;
      }
      if (!ctx.signal.aborted) {
        ctx.state.set(exportFitState, sessionId, {
          sessionId,
          file,
          bytes: bytes.length,
          records: activity.records.length,
        });
      }
    };

    const reconcile = (ride: RecordingRide): void => {
      const { sessionId, file } = ride;
      if (!file) {
        return;
      }
      if (ride.state === 'deleted') {
        deleted.add(sessionId);
        ctx.state.remove(exportFitState, sessionId);
        // Not written yet, there is nothing to remove: the export above removes it once it is.
        void storage
          .remove(fitPathFor(file))
          .catch((error: unknown) => ctx.logger.warn({ error }, 'export-fit: the FIT file could not be deleted'));
        return;
      }
      if (ride.state !== 'saved' || exporting.has(sessionId) || ctx.state.get(exportFitState, sessionId)) {
        return;
      }
      exporting.add(sessionId);
      exportRide(sessionId, file)
        .catch((error: unknown) => failed(file, error))
        .finally(() => exporting.delete(sessionId));
    };

    ctx.state.watch(recordingRideState, ({ entries, changed }) => {
      for (const key of changed) {
        const ride = entries.get(key);
        if (ride) {
          reconcile(ride);
        }
      }
    });
  },
});
