// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  exportFitWrittenEvent,
  recordingCompletedEvent,
  storageAppFilesCapability,
} from '@ridrs/contracts';
import { buildActivity, encodeActivity } from '@ridrs/fit';
import { fitPathFor, readRecording } from '@ridrs/recording';

/**
 * Exports every completed recording as a FIT activity file next to it. Knows no device, metric or
 * physics plugin: it reads the recording's events. A failure leaves the recording untouched.
 */
export default definePlugin({
  start(ctx) {
    const storage = ctx.capabilities.get(storageAppFilesCapability);
    ctx.events.subscribe(recordingCompletedEvent, ({ payload }) => {
      const file = fitPathFor(payload.file);
      void (async () => {
        // The CLI's `recording export-fit` runs the same three calls: same recording, same bytes.
        const activity = buildActivity(await readRecording(await storage.read(payload.file)));
        const bytes = encodeActivity(activity);
        const records = activity.records.length;
        await storage.write(file, bytes);
        if (!ctx.signal.aborted) {
          ctx.events.publish(exportFitWrittenEvent, {
            sessionId: payload.sessionId,
            file,
            bytes: bytes.length,
            records,
          });
        }
      })().catch((error: unknown) =>
        ctx.reportDiagnostic(
          'fit-export-failed',
          `The FIT export of "${payload.file}" failed: ${error instanceof Error ? error.message : String(error)}`,
          { file: payload.file },
        ),
      );
    });
  },
});
