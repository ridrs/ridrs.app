<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0099: The Gauges Glow in HDR on a WebGPU Canvas

Status: proposed on 2026-11-16.

## Context

The gauge HUD (`ui-hud-gauges`) sits over the video, which on HDR routes is brighter than SDR white (ADR 0091). The gauges drew their colours in Display P3 with `dynamic-range-limit: no-limit`, but the web view stops CSS colours at SDR white: it parses `color(display-p3 2 2 2)` and `color(srgb-linear 4 4 4)`, but does not know `rec2100-*` colours, and only a WebGPU canvas with extended tone mapping was measured beyond SDR white (ADR 0091). Next to an HDR video the gauges looked dull, and their dimmed, half-transparent scale and grey text took on the colours of the scenery behind them.

## Decision

- **The dial is glass, what is on it is solid.** The dial's background is translucent and blurs the scenery behind it; the scale, the ticks, the numbers and the marks are fully opaque. The part of the scale not lit yet is a thin track in its zone colours dimmed towards the dial (opaque, `dimmed()`); the lit part is the full-width arc in Display P3 at full brightness. No blurred glow: a halo is see-through.
- **On an HDR screen the drawing goes beyond SDR white.** The gauge stays an SVG (its structure, tests and accessibility unchanged). Where `navigator.gpu` exists, `(dynamic-range: high)` matches and a canvas accepts `rgba16float`, `display-p3` and extended tone mapping, a WebGPU canvas over the dial shows the same SVG, rasterised, `HDR_GAIN` (1.8) times as bright in linear light, and the SVG itself is hidden. The text font goes into the rasterised SVG inline, since an SVG image loads no files. All gauges share one device.
- **Elsewhere the SVG shows itself**, at SDR white at most.

## Consequences

- On the Mac's XDR display the gauges are about as bright as the highlights of an HDR route, with the scenery showing through only between them.
- A gauge rasterises its SVG again when it renders or changes size: a few times a second while riding.
- WebGPU cannot be tested in Node; the solid and translucent parts are (Cucumber `ui/gauge-hud.feature`), the colour helpers are (Vitest).
