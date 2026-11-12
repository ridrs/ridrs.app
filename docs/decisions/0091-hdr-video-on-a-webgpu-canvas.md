<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0091: HDR Video Routes on a WebGPU Canvas, Converted by the Video World

Status: proposed on 2026-11-12.

## Context

The video world draws each decoded frame on a 2D canvas (ADR 0061). HDR routes (VP9 Profile 2 and AV1 Main, 10-bit, PQ, BT.2020, from video2gpx's Incyclist export) looked flat or washed out, while Safari and a bare `WKWebView` show the same file in HDR in a `<video>` element. Measured in a `WKWebView` on macOS 26 (M3 Pro, built-in XDR display):

- `VideoDecoder` gives 8-bit `NV12` for 10-bit input. It labels AV1 frames correctly (BT.2020, PQ) but VP9 frames as BT.709, whatever the stream is; neither the full VP9 codec string nor a `colorSpace` in the configuration changes that.
- A 2D canvas is SDR. A WebGPU canvas configured `rgba16float`, `display-p3`, `toneMapping: { mode: 'extended' }` is accepted and shown in HDR, but `importExternalTexture` of a frame converts it to SDR first: the brightest value reaching the shader was 0.73 to 0.79 of SDR white for both codecs.
- Copying the frame's planes (`VideoFrame.copyTo`) and converting them in a shader gave 2.45 (AV1, 4K) and 2.16 (VP9, 1440p) times SDR white, at 1.5 to 4 ms per frame. Seen next to the `<video>` element, the picture matched.

## Decision

- **The colour comes from the container.** The video index reads the sample entry's `colr` box (nclx), else the fields of `vpcC`, as ISO/IEC 23091-2 code points (`VideoIndex.colour`).
- **PQ with BT.2020 primaries and matrix is shown on a WebGPU canvas** (`client/hdr-renderer.ts`): the renderer copies the `NV12` planes into two textures and converts in a shader: the BT.2020 non-constant-luminance matrix for the declared range, the PQ curve from a lookup table with BT.2408's reference white (203 cd/m²) as SDR white, BT.2020 to Display P3 and the sRGB transfer function, extended above 1. The colour maths (`client/hdr.ts`) is plain TypeScript and tested headless.
- **Everything else stays on the 2D canvas**: SDR videos, HLG, other primaries, a platform without an extended WebGPU canvas, and frames that are not `NV12`. The HDR canvas is a second `<canvas>`, because a canvas with a WebGPU context can have no 2D one.
- One copy is in flight at a time; a frame that arrives while one is copied is offered again on the next render frame. The render clock still chooses the frame (ADR 0061).

## Consequences

- HDR routes are shown in HDR in the Mac app, with the frame choice of ADR 0061 unchanged.
- WebKit decodes to 8 bits, so smooth gradients of an HDR video can band; the app cannot change that.
- Highlights above the display's headroom are clipped by the system, not tone-mapped.
- WebGPU itself cannot be tested in Node; the colour reading, the choice of canvas and the maths are (Cucumber `world/hdr-video.feature`, Vitest).
