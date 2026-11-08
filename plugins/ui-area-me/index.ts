// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  athleteProfileState,
  athleteProfileUpdateService,
  DEFAULT_PROVIDER,
  definePlugin,
  hostStartedEvent,
  type PluginContext,
} from '@ridrs/contracts';
import { z } from 'zod';

/**
 * The area's own document as it was before the athlete profile existed (ADR 0073): FTP and
 * weight lived in it as a preview. The rest of the document is read by the client module.
 */
const previewDocument = {
  name: 'preview',
  version: 1,
  schema: z.object({
    ftp: z.number().int().min(50).max(600).optional(),
    weight: z.number().min(30).max(200).optional(),
    weeklyHours: z.number().min(0.5).max(30),
    showOnToday: z.boolean(),
  }),
};

/**
 * What the preview kept before the rider changed FTP or weight: it wrote both as soon as anything
 * in the area changed, so these values are the preview's, not the rider's.
 */
const PREVIEW_PLACEHOLDERS = { ftp: 200, weight: 72 } as const;

/**
 * Hands the old FTP and weight to the profile on this device, once: the athlete document is the
 * profile plugin's and cannot be read from here, so the values go through the update service, and
 * only then does the area's document lose them. A failed hand-over leaves them for the next start.
 * The preview's placeholders are not handed over, and a profile that already holds an FTP or a
 * weight keeps them: the old values are only dropped then.
 */
async function handOverPreviewProfile(ctx: PluginContext): Promise<void> {
  const document = ctx.settings.user(previewDocument);
  const { ftp, weight, ...rest } = (await document.read()) ?? {};
  if (ftp === undefined && weight === undefined) {
    return;
  }
  const profile = ctx.state.entries(athleteProfileState).get(DEFAULT_PROVIDER)?.data;
  const empty = profile?.ftp === undefined && profile?.weight === undefined;
  const change = {
    ...(ftp === undefined || ftp === PREVIEW_PLACEHOLDERS.ftp ? {} : { ftp }),
    ...(weight === undefined || weight === PREVIEW_PLACEHOLDERS.weight ? {} : { weight }),
  };
  if (empty && Object.keys(change).length > 0) {
    const answer = await ctx.services.call(athleteProfileUpdateService, {
      key: DEFAULT_PROVIDER,
      ...change,
    });
    if (!answer.ok) {
      return;
    }
  }
  await document.write(rest as z.infer<typeof previewDocument.schema>);
}

// Most of this plugin lives in its client module (see `ui` in the manifest); the host side hands
// over the values of the old preview once every provider has started.
export default definePlugin({
  start(ctx) {
    ctx.events.subscribe(hostStartedEvent, () => {
      handOverPreviewProfile(ctx).catch((error: unknown) =>
        ctx.logger.warn(`Could not hand over the FTP and weight: ${String(error)}`),
      );
    });
  },
});
