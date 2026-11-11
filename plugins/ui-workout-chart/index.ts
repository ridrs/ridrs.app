// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin } from '@ridrs/contracts';

// All of this plugin lives in its client module (see `ui` in the manifest); the host side only
// takes part in the lifecycle, so starting and stopping the plugin adds and removes its chart.
export default definePlugin({});
