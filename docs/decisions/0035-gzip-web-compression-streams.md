<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0035: gzip with Web Compression Streams

`.ridrs` files are gzip-compressed with the Web standard `CompressionStream` / `DecompressionStream` (Node ≥ 18, WKWebView on macOS/iOS 16.4+, WebView2, Android WebView). No dependency, no zip library. `@ridrs/recording` pipes a `Blob` stream through it and reads the result with `Response`. The streams complete on real I/O turns, so fake-timer tests wait for them with real `setImmediate` turns (`RidrsWorld.waitForIo`).
