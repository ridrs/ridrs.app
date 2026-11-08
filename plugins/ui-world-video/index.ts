// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin } from '@ridrs/contracts';

// All of this plugin lives in its client module (see `ui` in the manifest): the route's track,
// the playback and the terrain and position it publishes. The host side only takes part in the
// lifecycle, so starting and stopping the plugin adds and removes its UI.
export default definePlugin({});
