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
        path: '^packages/(core|contracts|ble-bridge|ble-simulator)/',
        pathNot: '(^packages/core/src/node/|\\.test\\.ts$)',
      },
      to: {
        dependencyTypesNot: ['type-only'],
        path: '^(node:|fs$|path$|url$|crypto$|os$)|tinyglobby|pino',
      },
    },
    {
      name: 'ble-bridge-only-imports-contracts',
      comment:
        'packages/ble-bridge is the bridge protocol (companion and ridrs side): it imports packages/contracts only.',
      severity: 'error',
      from: { path: '^packages/ble-bridge/' },
      to: { path: '^(packages/(?!contracts/|ble-bridge/)|plugins/|apps/|tests/)' },
    },
    {
      name: 'ble-simulator-not-in-release-code',
      comment:
        'Dummy devices are for tests and the developer companion only: packages/ble-simulator may be imported by packages/testing, tests/** and the companion app (behind VITE_DUMMY_DEVICES).',
      severity: 'error',
      from: { path: '^(packages/(?!testing/|ble-simulator/)|plugins/|apps/(?!companion/))' },
      to: { path: '^packages/ble-simulator/' },
    },
    {
      name: 'bridge-transport-imports-protocol-only',
      comment:
        'transport-ble-bridge knows the bridge protocol and contracts; the platform comes in as the ble-bridge.connector capability.',
      severity: 'error',
      from: { path: '^plugins/transport-ble-bridge/' },
      to: { path: '^packages/(?!contracts/|ble-bridge/)' },
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
      name: 'ui-sdk-only-imports-contracts',
      comment:
        'packages/ui-sdk is the browser-safe client contract: it imports packages/contracts only.',
      severity: 'error',
      from: { path: '^packages/ui-sdk/' },
      to: { path: '^(packages/(?!contracts/|ui-sdk/)|plugins/|apps/|tests/)' },
    },
    {
      name: 'browser-code-stays-browser-safe',
      comment:
        'Client modules, the shell and the client contract run in a WebView: no node builtins, no packages/core, no apps or tests.',
      severity: 'error',
      from: {
        path: '^(plugins/[^/]+/client/|packages/ui-shell/|packages/ui-sdk/|packages/contracts/)',
        pathNot: '\\.test\\.ts$',
      },
      to: { path: '^(node:|packages/core/|packages/testing/|apps/|tests/)' },
    },
    {
      name: 'browser-code-no-node-builtins',
      comment: 'Node builtins (dependency type "core") are not available to browser code.',
      severity: 'error',
      from: {
        path: '^(plugins/[^/]+/client/|packages/ui-shell/|packages/ui-sdk/)',
        pathNot: '\\.test\\.ts$',
      },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'ui-shell-imports-sdk-and-contracts-only',
      comment: 'The shell talks to the host only through the UiBridge port of packages/ui-sdk.',
      severity: 'error',
      from: { path: '^packages/ui-shell/' },
      to: { path: '^(packages/(?!contracts/|ui-sdk/|ui-shell/)|plugins/|apps/|tests/)' },
    },
    {
      name: 'tauri-only-in-transport-native-and-testing',
      comment:
        '@tauri-apps/* may only be imported by the Tauri BLE package, the Tauri plugins (transport, bridge connector), the Tauri apps and the simulated bridge in packages/testing.',
      severity: 'error',
      from: {
        pathNot:
          '^(packages/ble-tauri/|plugins/(transport-ble-tauri|bridge-connector-tauri)/|apps/(native|companion)/|packages/testing/)',
      },
      to: { path: '@tauri-apps' },
    },
    {
      name: 'domain-plugins-know-no-ui',
      comment: 'Activity, device, metric, transport and output plugins never import UI code.',
      severity: 'error',
      from: { path: '^plugins/(activity-|device-|metric-|transport-|output-)' },
      to: { path: '(^packages/ui-|react)' },
    },
    {
      name: 'core-knows-no-ui-packages',
      comment: 'The core indexes UI manifests but never imports UI packages.',
      severity: 'error',
      from: { path: '^packages/(core|contracts)/' },
      to: { path: '(^packages/ui-|react)' },
    },
    {
      name: 'react-only-in-ui-code',
      comment:
        'React is an implementation detail of UI plugin clients, the native app entry and the companion app UI.',
      severity: 'error',
      from: { pathNot: '^(plugins/ui-[^/]+/client/|apps/(native|companion)/src/|tests/)' },
      to: { path: '(^|/)node_modules/.*/(react|react-dom)/' },
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
