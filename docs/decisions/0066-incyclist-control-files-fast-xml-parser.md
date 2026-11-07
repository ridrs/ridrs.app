<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0066: Incyclist Control Files with fast-xml-parser and entities

Status: proposed on 2026-11-06, for the Incyclist importer ([video-sources.md](../ideas/video-sources.md), section 5).

## Context

`video-import-incyclist` turns a downloaded Incyclist package into a ridrs video route. It reads the package's control file (`gpx-import` XML): the video and the track, frame rate and start frame, notes along the route and segments. It runs on the host side, in Node (headless, tests) and in the WebView, so `DOMParser` is not there everywhere. The control files of the Van Gestel routes use HTML's named entities in attribute values (`L&auml;nge`), which XML does not know, and some are UTF-16 with a byte order mark.

## Decision

- **`fast-xml-parser` 5.11.2** (MIT; pure JS, ESM, Node and browsers) parses the control file into objects: attributes without a prefix, values as text, `information` and `segment` always lists. 5.12.0 was three days old; 5.11.2 is the latest older than two weeks.
- **`entities` 8.1.0** (BSD-2-Clause, pure JS) decodes HTML's named entities (`decodeHTML`) before parsing, except XML's own five, as the video world's `library.ts` does with the browser's HTML parser. fast-xml-parser's own `htmlEntities` option does not reach attribute values in 5.11. 9.0.0 was eight days old.
- The byte order mark chooses the text decoding (`TextDecoder`, a platform built-in): UTF-16 BE, UTF-16 LE, else UTF-8.
- Rejected: `DOMParser` (not in Node; happy-dom only in tests); own XML code (generic, against rule 2); `@xmldom/xmldom` (DOM API, more than the importer needs; no HTML entities either).

## Consequences

- The control files of all 23 Van Gestel routes read alike, UTF-16 ones included (`incyclist.test.ts`, `video-downloads.feature`).
- Six small MIT dependencies come with fast-xml-parser (NOTICE).
