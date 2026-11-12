<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0061: Video Frames Chosen by the Render Clock, Decoded with WebCodecs and mp4box.js

## Context

The video world (`plugins/ui-world-video`) shows a route's video at the presented distance. The first version drove an HTML `<video>` element like a player: it set `playbackRate` to the rider's speed over the camera's, nudged it towards the video time of the distance and seeked when more than 2 s off. Measured with a dummy trainer (200 W and 1000 W, Col de Pennes):

- the rate was rewritten almost every frame (169 times in 10 s) and stepped by 11–25 % at every GPX point, where the camera speed between two points changes;
- above the 4× cap (1000 W on a slow stretch needs about 5×) the video fell behind, and a seek decodes from the last keyframe (up to 8.3 s back), so the rider could outrun every seek: in the Tauri window one picture about every 2 s.

The UI already has one render clock at the display's rate (ADR 0028). Rule 10: rendering reads, never drives. The picture of a render frame should be a function of that frame's presented distance alone, like the demo landscape's road, not the state of a media player.

Setting `currentTime` every render frame is a seek every frame: not workable with long GOPs. WebCodecs (`VideoDecoder`, `VideoFrame`) decodes frames on demand; WebKit in the Tauri window supports it for both codecs of the library (H.264 `avc1.64001f`, AV1 `av01.0.05M.08`; checked in a `WKWebView` on macOS 26), as does Chromium. WebCodecs needs the encoded samples and the decoder configuration, which an MP4 demuxer provides; parsing ISO BMFF boxes is generic work (rule 2).

## Decision

- **The render clock chooses the frame.** Each render frame shows the decoded video frame with the latest presentation time at or before `videoTimeAt(track, presented distance)`. There is no playback rate, no seek threshold and no rate cap; standing still shows the same frame.
- **WebCodecs decodes ahead into a small buffer.** The plugin fetches the samples by HTTP range from the file's own byte offsets, feeds them in decode order and keeps the decoded frames from the shown one up to a short lead. When the shown time leaves what the decoder can reach in time (behind the buffer, or past a keyframe ahead of what was fed), it resets the decoder and starts at the last keyframe at or before that time. Until the frame arrives, the last picture stays.
- **mp4box.js** (`mp4box` 2.4.1, BSD-3-Clause, pure ESM, the demuxer of the WebCodecs samples) reads the sample table and the decoder configuration (`avcC`, `av1C`). Only `ftyp` and `moov` are fetched (0.3–3.6 MB for the library's files, `moov` at the end); the media data is never read in full. 2.5.0 was 12 days old when chosen; 2.4.1 had been out for four months.
- The frame is drawn on a `<canvas>`; the `<video>` element is gone. (HDR videos: ADR 0091.)

## Consequences

- Smoothness is the rider's: the picture moves exactly as far as the physics moved, whatever the speed, and a stretch where the rider is faster than the decoder skips to keyframes instead of falling behind.
- Memory is bounded by the buffer (about 30 decoded 720p frames). Decoding at high speed costs CPU or the hardware decoder in proportion to the speed.
- The selection and feeding logic is pure and tested with a fake decoder (Vitest); WebCodecs itself is not available in Node or happy-dom.
- A file whose codec the platform cannot decode shows a message instead of a picture.
