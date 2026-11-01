// SPDX-License-Identifier: AGPL-3.0-or-later

// Measuring-only shim for the stage 3 probe: filesystem discovery has no WebView equivalent.
const unavailable = (name: string) => () => {
  throw new Error(`${name} is not available in a WebView`);
};
export const readFile = unavailable('fs.readFile');
export const join = unavailable('path.join');
export const resolve = unavailable('path.resolve');
export const glob = unavailable('tinyglobby.glob');
