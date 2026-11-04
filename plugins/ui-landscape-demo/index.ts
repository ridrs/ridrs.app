// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin } from '@ridrs/contracts';

// All of this plugin lives in its client module (see `ui` in the manifest): the landscape model,
// the drawing and the terrain it publishes. The host side only takes part in the lifecycle, so
// starting and stopping the plugin adds and removes its UI.
export default definePlugin({});
