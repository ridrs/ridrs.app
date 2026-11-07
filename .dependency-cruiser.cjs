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
        'packages/core may import contracts and the temporal and spatial math; it must never import testing, plugins/, apps/, or tests/.',
      severity: 'error',
      from: {
        path: '^packages/core/',
      },
      to: {
        path: '^(packages/(?!contracts/|core/|temporal/|spatial/)|plugins/|apps/|tests/)',
      },
    },
    {
      name: 'runtime-neutral-core-and-contracts',
      comment:
        'packages/core and packages/contracts run in Node and in a WebView: no node:* builtins and no Node-only libraries. Only packages/core/src/node/ (the Node-only entry) may use them.',
      severity: 'error',
      from: {
        path: '^packages/(core|contracts|ble-bridge|ble-simulator|temporal|spatial|metric-source|ble-peripheral|recording|fit)/',
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
      from: {
        path: '^(packages/(?!testing/|ble-simulator/|replay/)|plugins/|apps/(?!companion/))',
      },
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
      name: 'temporal-is-pure-math',
      comment:
        'packages/temporal is deterministic math: simple-statistics and type-only contracts, no clock, timers, rxjs or Node builtins.',
      severity: 'error',
      from: { path: '^packages/temporal/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^(packages/(?!temporal/|contracts/)|plugins/|apps/|tests/|node:)|node_modules/(?!\\.pnpm/simple-statistics@|simple-statistics/)',
      },
    },
    {
      name: 'temporal-no-undeclared-modules',
      comment:
        'An import packages/temporal cannot resolve (e.g. rxjs, which it does not declare) would bypass temporal-is-pure-math.',
      severity: 'error',
      from: { path: '^packages/temporal/' },
      to: { couldNotResolve: true },
    },
    {
      name: 'temporal-contracts-type-only',
      comment: 'packages/temporal uses the contracts for types only.',
      severity: 'error',
      from: { path: '^packages/temporal/' },
      to: { path: '^packages/contracts/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'temporal-no-builtins',
      comment: 'packages/temporal has no I/O: no Node builtins.',
      severity: 'error',
      from: { path: '^packages/temporal/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'plugins-never-import-temporal',
      comment:
        'Plugins use ctx.temporal: one estimator implementation, and no plugin bypasses series ownership.',
      severity: 'error',
      from: { path: '^(plugins/|tests/fixtures/plugins/)' },
      to: { path: '^packages/temporal/' },
    },
    {
      name: 'spatial-is-pure-sampling',
      comment:
        'packages/spatial is deterministic sampling by distance: type-only contracts, no library, no clock, timers, rxjs or Node builtins.',
      severity: 'error',
      from: { path: '^packages/spatial/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^(packages/(?!spatial/|contracts/)|plugins/|apps/|tests/|node:)|node_modules/',
      },
    },
    {
      name: 'spatial-no-undeclared-modules',
      comment: 'An import packages/spatial cannot resolve would bypass spatial-is-pure-sampling.',
      severity: 'error',
      from: { path: '^packages/spatial/' },
      to: { couldNotResolve: true },
    },
    {
      name: 'spatial-contracts-type-only',
      comment: 'packages/spatial uses the contracts for types only.',
      severity: 'error',
      from: { path: '^packages/spatial/' },
      to: { path: '^packages/contracts/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'spatial-no-builtins',
      comment: 'packages/spatial has no I/O: no Node builtins.',
      severity: 'error',
      from: { path: '^packages/spatial/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'plugins-never-import-spatial',
      comment:
        'Plugins use ctx.spatial: one sampling implementation, and no plugin bypasses series ownership.',
      severity: 'error',
      from: { path: '^(plugins/|tests/fixtures/plugins/)' },
      to: { path: '^packages/spatial/' },
    },
    {
      name: 'shared-plugin-packages-import-contracts-only',
      comment:
        'packages/ble-peripheral and packages/metric-source import packages/contracts and their libraries (p-retry) only - never the core or a plugin.',
      severity: 'error',
      from: { path: '^packages/(ble-peripheral|metric-source)/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^(packages/(?!contracts/|ble-peripheral/|metric-source/)|plugins/|apps/|tests/)|node_modules/(?!\\.pnpm/p-retry@|p-retry/)',
      },
    },
    {
      name: 'derived-metrics-know-only-metrics',
      comment:
        'metric-power-heart-rate-ratio sees metrics and their series only: nothing device-, BLE- or UI-related.',
      severity: 'error',
      from: { path: '^plugins/metric-power-heart-rate-ratio/' },
      to: {
        path: '(^packages/(?!contracts/)|^packages/contracts/src/(ble|ble-bridge|ui)\\.ts$|^plugins/(?!metric-power-heart-rate-ratio/)|react)',
      },
    },
    {
      name: 'physics-plugins-import-contracts-only',
      comment:
        'Physics plugins import packages/contracts only (rxjs in physics-engine): nothing device-, BLE-, UI- or @ridrs/temporal-related. Estimation stays in the temporal data layer.',
      severity: 'error',
      from: { path: '^plugins/physics-', pathNot: '\\.test\\.ts$' },
      to: {
        path: '(^packages/(?!contracts/)|^packages/contracts/src/(ble|ble-bridge|ui)\\.ts$|^(apps|tests)/|node_modules/(?!\\.pnpm/rxjs@|rxjs/))',
      },
    },
    {
      name: 'only-the-physics-engine-owns-a-timer',
      comment:
        'physics-engine is the only clock-driven physics plugin; every other one computes only inside a step the engine calls. (Events and ctx timers are covered by the ADR 0026 review checklist and unit tests.)',
      severity: 'error',
      from: { path: '^plugins/physics-(?!engine/)' },
      to: { path: 'rxjs' },
    },
    {
      name: 'physics-widgets-know-contracts-sdk-and-react',
      comment:
        'The physics and trainer control HUD widgets import packages/contracts, packages/ui-sdk and React only.',
      severity: 'error',
      from: {
        path: '^plugins/ui-widget-(virtual-speed|virtual-distance|gradient|virtual-gear|target-power)/',
      },
      to: { path: '^(packages/(?!contracts/|ui-sdk/)|apps/|tests/)' },
    },
    {
      name: 'control-plugins-import-contracts-only',
      comment:
        'The virtual gears and the ERG driver import packages/contracts only: no device plugin, no BLE, no physics (Phase 8, ADR 0055, ADR 0056).',
      severity: 'error',
      from: { path: '^plugins/control-', pathNot: '\\.test\\.ts$' },
      to: { path: '^(packages/(?!contracts/)|apps/|tests/)' },
    },
    {
      name: 'only-device-and-transport-plugins-reach-ble',
      comment:
        'Only device plugins write to a device, through the peripheral link (the noble transport shares its scan helper): no control, physics or UI plugin reaches it (Phase 8).',
      severity: 'error',
      from: { path: '^plugins/(?!device-|transport-ble-)' },
      to: { path: '^packages/ble-peripheral/' },
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
        path: '^(plugins/[^/]+/client/|packages/ui-shell/|packages/ui-sdk/|packages/ui-preview/|packages/presentation/|packages/contracts/)',
        pathNot: '\\.test\\.ts$',
      },
      to: { path: '^(node:|packages/core/|packages/testing/|apps/|tests/)' },
    },
    {
      name: 'browser-code-no-node-builtins',
      comment: 'Node builtins (dependency type "core") are not available to browser code.',
      severity: 'error',
      from: {
        path: '^(plugins/[^/]+/client/|packages/ui-shell/|packages/ui-sdk/|packages/ui-preview/)',
        pathNot: '\\.test\\.ts$',
      },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'ui-preview-imports-contracts-sdk-and-react-only',
      comment:
        'packages/ui-preview is the kit of the clickable preview (ADR 0059): contracts and ui-sdk types and React, nothing else of ridrs.',
      severity: 'error',
      from: { path: '^packages/ui-preview/' },
      to: { path: '^(packages/(?!contracts/|ui-sdk/|ui-preview/)|plugins/|apps/|tests/)' },
    },
    {
      name: 'only-ui-clients-use-the-preview-kit',
      comment: 'Only the client modules of UI plugins draw with packages/ui-preview (ADR 0059).',
      severity: 'error',
      from: { pathNot: '^(plugins/ui-[^/]+/client/|packages/ui-preview/)' },
      to: { path: '^packages/ui-preview/' },
    },
    {
      name: 'ui-shell-imports-sdk-and-contracts-only',
      comment:
        'The shell talks to the host only through the UiBridge port of packages/ui-sdk; its frame clock comes from packages/presentation.',
      severity: 'error',
      from: { path: '^packages/ui-shell/' },
      to: {
        path: '^(packages/(?!contracts/|ui-sdk/|ui-shell/|presentation/)|plugins/|apps/|tests/)',
      },
    },
    {
      name: 'presentation-imports-contracts-and-sdk-only',
      comment:
        'packages/presentation is DOM-free UI-side logic: packages/contracts and ui-sdk types only - no core, no React, no rxjs, no Node builtins.',
      severity: 'error',
      from: { path: '^packages/presentation/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^(packages/(?!contracts/|ui-sdk/|presentation/)|plugins/|apps/|tests/|node:)|(^|/)node_modules/',
      },
    },
    {
      name: 'presentation-no-undeclared-modules',
      comment:
        'An import packages/presentation cannot resolve (e.g. rxjs or react, which it does not declare) would bypass presentation-imports-contracts-and-sdk-only.',
      severity: 'error',
      from: { path: '^packages/presentation/' },
      to: { couldNotResolve: true },
    },
    {
      name: 'presentation-uses-sdk-types-only',
      comment: 'packages/presentation uses packages/ui-sdk for types only.',
      severity: 'error',
      from: { path: '^packages/presentation/' },
      to: { path: '^packages/ui-sdk/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'presentation-no-builtins',
      comment: 'packages/presentation runs in a WebView: no Node builtins.',
      severity: 'error',
      from: { path: '^packages/presentation/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'simulation-knows-no-presentation',
      comment:
        'Physics plugins and the core never import UI or presentation code: the engine has no frame, render or UI concept.',
      severity: 'error',
      from: { path: '^(plugins/physics-|packages/(core|contracts|temporal|spatial)/)' },
      to: { path: '^packages/(presentation|ui-)' },
    },
    {
      name: 'tauri-only-in-transport-native-and-testing',
      comment:
        '@tauri-apps/* and the Tauri oauth plugin may only be imported by the Tauri BLE package, the Tauri plugins (transport, bridge connector, app files, secrets, HTTP, browser sign-in, media, downloads, archives), the Tauri apps and the simulated bridge in packages/testing.',
      severity: 'error',
      from: {
        pathNot:
          '^(packages/ble-tauri/|plugins/(transport-ble-tauri|bridge-connector-tauri|storage-files-tauri|storage-secrets-tauri|net-http-tauri|auth-sign-in-tauri|storage-media-tauri|data-fetch-tauri|data-archive-tauri)/|apps/(native|companion)/|packages/testing/)',
      },
      to: { path: '(@tauri-apps|@fabianlars/tauri-plugin-oauth)' },
    },
    {
      name: 'domain-plugins-know-no-ui',
      comment:
        'Activity, device, metric, transport, planner and output plugins never import UI code.',
      severity: 'error',
      from: { path: '^plugins/(activity-|device-|metric-|transport-|planner-|output-)' },
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
      from: {
        pathNot:
          '^(plugins/ui-[^/]+/client/|packages/ui-preview/src/|apps/(native|companion)/src/|tests/)',
      },
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
      name: 'fit-sdk-only-in-tests',
      comment:
        'The official Garmin FIT SDK validates exported files in tests and CI only; it is never bundled or distributed (ADR 0034).',
      severity: 'error',
      from: { pathNot: '(^tests/|\\.test\\.ts$)' },
      to: { path: '@garmin/fitsdk' },
    },
    {
      name: 'fit-imports-contracts-only',
      comment:
        'packages/fit is runtime-neutral domain code: it imports packages/contracts only - no Node builtins, no I/O, no other library.',
      severity: 'error',
      from: { path: '^packages/fit/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^(packages/(?!contracts/|fit/)|plugins/|apps/|tests/|node:)|(^|/)node_modules/(?!\\.pnpm/(zod|semver)@|zod/|semver/)',
      },
    },
    {
      name: 'recording-imports-contracts-only',
      comment:
        'packages/recording (format, writer, reader, recovery) imports packages/contracts only and compresses with Web streams.',
      severity: 'error',
      from: { path: '^packages/recording/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^(packages/(?!contracts/|recording/)|plugins/|apps/|tests/|node:)|(^|/)node_modules/(?!\\.pnpm/(zod|semver)@|zod/|semver/)',
      },
    },
    {
      name: 'fit-and-recording-no-builtins',
      comment: 'packages/fit and packages/recording run in a WebView too: no Node builtins.',
      severity: 'error',
      from: { path: '^packages/(fit|recording)/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'replay-imports',
      comment:
        'packages/replay composes a host on a replay clock: it may import the core, recording, contracts and its libraries (microdiff, zod).',
      severity: 'error',
      from: { path: '^packages/replay/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^(packages/(?!contracts/|core/|recording/|replay/)|plugins/|apps/|tests/)|(^|/)node_modules/(?!\\.pnpm/(microdiff|zod|semver|rxjs|dependency-graph|tinyglobby|simple-statistics)@|microdiff/|zod/)',
      },
    },
    {
      name: 'no-plugin-imports-replay',
      comment: 'Replay is a headless tool: no plugin imports it.',
      severity: 'error',
      from: { path: '^(plugins/|tests/fixtures/plugins/)' },
      to: { path: '^packages/replay/' },
    },
    {
      name: 'recording-and-export-know-only-events',
      comment:
        'recording-session and export-fit work on events, config.snapshot and storage.app-files only: contracts, recording and fit - no device, metric, physics or UI code.',
      severity: 'error',
      from: { path: '^plugins/(recording-session|export-fit)/' },
      to: {
        path: '^(packages/(?!contracts/|recording/|fit/)|plugins/(?!recording-session/|export-fit/))',
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
