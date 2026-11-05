<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0047: Icons from Lucide, Kept as SVG Assets

## Context

The device details need a Remove button with a bin icon. An emoji (🗑) renders as a colour picture that differs per system and cannot take the button's colour, as with the bolt of the status badges. Drawing common icons like a bin by hand is generic work, not ridrs domain logic (AGENTS.md rule 2); the drawn icons so far (`KindIcon`, `FactIcon`, …) are ridrs-specific shapes.

## Decision

- **Lucide** (`lucide-static` 1.55.0; ISC, with the icons derived from Feather under MIT) as the icon library: a large, consistent, actively maintained set of 24 × 24 stroke icons that matches the look of the drawn icons (round caps and joins, `currentColor`).
- The icons a plugin uses are copied unchanged into an asset folder of the plugin, `client/assets/icons/`, together with Lucide's `LICENSE`; each file keeps its `@license` comment. No npm dependency: the whole set (thousands of files) would be installed for one icon, and an asset folder is where further images of the plugin go.
- A plugin loads an icon with `new URL('./assets/icons/<name>.svg', import.meta.url)`: Vite bundles the file (or inlines it as a `data:` URL, which the app's CSP allows), and Node only computes a file URL, so the headless UI scenarios need no loader.
- The icon is painted as a CSS mask over `currentColor`, so it takes the colour of the button's text like the drawn icons.

## Consequences

- A new icon is one copied file, from the same Lucide version where possible; this ADR names the version.
- The asset folder belongs to `ui-devices`. Once a second plugin needs icons, they move to a shared UI package rather than being imported across plugins (AGENTS.md rule 5).
- Masks do not render in happy-dom; the scenarios check the button by its word, and the icon is `aria-hidden`.
