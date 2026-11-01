// SPDX-License-Identifier: AGPL-3.0-or-later

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'contracts-no-internal-imports',
      comment: 'packages/contracts imports no other internal package, app, plugin, or test.',
      severity: 'error',
      from: {
        path: '^packages/contracts/',
      },
      to: {
        path: '^(packages/(?!contracts/)|apps/|plugins/|tests/)',
      },
    },
    {
      name: 'core-only-imports-contracts',
      comment:
        'packages/core may import contracts; it must never import testing, plugins/, apps/, or tests/.',
      severity: 'error',
      from: {
        path: '^packages/core/',
      },
      to: {
        path: '^(packages/(?!contracts/|core/)|plugins/|apps/|tests/)',
      },
    },
    {
      name: 'runtime-neutral-core-and-contracts',
      comment:
        'packages/core and packages/contracts run in Node and in a WebView: no node:* builtins and no Node-only libraries. Only packages/core/src/node/ (the Node-only entry) may use them.',
      severity: 'error',
      from: {
        path: '^packages/(core|contracts)/',
        pathNot: '(^packages/core/src/node/|\\.test\\.ts$)',
      },
      to: {
        dependencyTypesNot: ['type-only'],
        path: '^(node:|fs$|path$|url$|crypto$|os$)|tinyglobby|pino',
      },
    },
    {
      name: 'core-builtins-forbidden',
      comment:
        'Node builtins (dependency type "core") are only allowed in the Node-only core entry.',
      severity: 'error',
      from: {
        path: '^packages/(core|contracts)/',
        pathNot: '(^packages/core/src/node/|\\.test\\.ts$)',
      },
      to: {
        dependencyTypes: ['core'],
      },
    },
    {
      name: 'core-main-entry-not-node-entry',
      comment: 'The runtime-neutral core never imports its Node-only entry.',
      severity: 'error',
      from: {
        path: '^packages/core/src/(?!node/)',
      },
      to: {
        path: '^packages/core/src/node/',
      },
    },
    {
      name: 'testing-only-in-tests',
      comment:
        'packages/testing may be imported by tests/** and tests/fixtures/** only - never by plugins/**, packages/core, packages/contracts, or apps/**.',
      severity: 'error',
      from: {
        path: '^(packages/(?!testing/)|plugins/|apps/)',
      },
      to: {
        path: '^packages/testing/',
      },
    },
    {
      name: 'plugins-no-core-or-apps',
      comment:
        'A plugin may import packages/contracts (and shared fixture contracts), never packages/core or apps.',
      severity: 'error',
      from: {
        path: '^(plugins/|tests/fixtures/plugins/)',
      },
      to: {
        path: '^(packages/core/|apps/)',
      },
    },
    {
      name: 'plugins-no-cross-plugin-imports',
      comment: 'A plugin must never import another plugin folder.',
      severity: 'error',
      from: {
        path: '^plugins/([^/]+)/',
      },
      to: {
        path: '^plugins/',
        pathNot: '^plugins/$1/',
      },
    },
    {
      name: 'fixture-plugins-no-cross-plugin-imports',
      comment: 'A fixture plugin must never import another plugin folder.',
      severity: 'error',
      from: {
        path: '^tests/fixtures/plugins/([^/]+)/([^/]+)/',
      },
      to: {
        path: '^(plugins/|tests/fixtures/plugins/)',
        pathNot: '^tests/fixtures/plugins/$1/$2/',
      },
    },
    {
      name: 'apps-no-plugin-imports',
      comment: 'apps/* compose core + contracts; they never import plugin code directly.',
      severity: 'error',
      from: {
        path: '^apps/',
      },
      to: {
        path: '^(plugins/|tests/fixtures/plugins/)',
      },
    },
    {
      name: 'noble-only-in-transport-ble-noble',
      comment: '@abandonware/noble may only be imported inside plugins/transport-ble-noble.',
      severity: 'error',
      from: {
        pathNot: '^plugins/transport-ble-noble/',
      },
      to: {
        path: '@abandonware/noble',
      },
    },
    {
      name: 'metric-and-output-no-ble-or-ftms',
      comment: 'metric-* and output-* must not import anything BLE- or FTMS-related.',
      severity: 'error',
      from: {
        path: '^plugins/(metric-|output-)',
      },
      to: {
        path: '(^packages/contracts/src/ble\\.ts$|^plugins/(transport-|device-)|@abandonware/noble|ftms)',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
