// SPDX-License-Identifier: AGPL-3.0-or-later

import { dataPictureCapability, definePlugin } from '@ridrs/contracts';
import { createCanvasPicture } from './picture.ts';

/** `data.picture` in the native app: pictures made smaller on the WebView's canvas (ADR 0094). */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(dataPictureCapability, createCanvasPicture());
  },
});
