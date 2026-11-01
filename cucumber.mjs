// SPDX-License-Identifier: AGPL-3.0-or-later

export default {
  paths: ['tests/features/**/*.feature'],
  import: ['tests/support/**/*.ts', 'tests/steps/**/*.ts'],
  strict: true,
  format: ['progress-bar', 'summary'],
  publishQuiet: true,
};
