// SPDX-License-Identifier: AGPL-3.0-or-later

const common = {
  paths: ['tests/features/**/*.feature'],
  import: ['tests/support/**/*.ts', 'tests/steps/**/*.ts'],
  strict: true,
  format: ['progress-bar', 'summary'],
  publishQuiet: true,
};

export default { ...common, tags: 'not @ui' };

/** UI scenarios register a headless DOM globally, so they run in a process of their own. */
export const ui = { ...common, tags: '@ui' };
