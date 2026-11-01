<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0014: React for UI Plugin Clients

UI plugin clients render with **React** (`react` / `react-dom` 19.3.1, MIT), as decided by the maintainer (D3), instead of Preact as the Phase 3 brief proposed. Reasons: the tech-stack direction names React and keeps `react-three-fiber` open for the later 3D world, and in the native app all plugins are bundled into one build, so React is a single shared chunk rather than one copy per plugin bundle (the size argument for Preact does not apply).

The client contract stays framework-neutral: a `UiComponent` is `(container, ctx) => cleanup | void` (`packages/ui-sdk`). The shell (`packages/ui-shell`) is plain DOM code and does not depend on React; each UI plugin creates its own React root inside its container. A plugin may use another framework without any change to the shell. `@vitejs/plugin-react` 6.1.2 (MIT) compiles the JSX in `apps/native`.
