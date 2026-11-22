<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0105: A Downloader for Each Kind of Download

Status: accepted on 2026-11-22, on the maintainer's request that every kind of video source can have a download plugin of its own, that the right one is taken automatically, and that a download can offer several qualities (plan `route-downloaders.md`, step A). Changes ADR 0103 (who downloads the routes of ridrs Scenic).

## Context

`video-source-scenic` read the catalog of ridrs Scenic and downloaded its packages itself (ADR 0094, 0103). A route of another kind, a YouTube video with a track from Scenic, needs another way onto the device, and a downloader for it must be able to come as a plugin of its own, also one that is not part of the repository. Such a download comes in several qualities, the packages of Van Gestel in one.

## Decision

- **Sources and downloaders are apart.** A source lists routes and owns their keys of `route.offer`. Each route has a kind of download (`RouteDownload.kind`, with the source's description of it in `details`). A downloader plugin provides the capability `route.downloader` (cardinality `multiple`) for the kinds it fetches; a source opens each downloader once (`open(changed)`) and hands it its routes of those kinds (`setRoutes`). The first downloader of a kind takes it. A route whose kind no downloader fetches is not offered.
- **The services stay the source's.** `route.fetch`, `route.cancel` and `route.remove` are keyed by `route.offer`, so they reach the source; it passes them on to the downloader of the route.
- **Qualities.** The new service `route.download-options` (keyed by `route.offer`) names the qualities a route can be downloaded in: `{ id, label, size?, recommended? }`. `route.fetch` takes the chosen one as `option`. Download on the ride page (card and details) and in the briefing asks for them: with one, the download starts at once; with several, the route's details or the briefing ask which, the recommended one first in the focus; Back leaves the choice without a download (AGENTS.md rule 12). On the ride page the choice is a dialog over the route's details: when the qualities take longer than 150 ms it says that it reads them, when they cannot be read it says why and offers Try again; a quality may name its `height`, `fps` and whether it is `hdr`, which the dialog shows (`1080p · 60 fps · SDR`) with its size. The qualities are asked for on Download, not listed in the offer, because a downloader may need the network to know them.
- **`download-ride-package`** is the downloader of packages (`ride-package`): the code `video-source-scenic` had (ADR 0094) moved into it unchanged; it offers one quality, `package`. `video-source-scenic` is a source only: a route of the catalog whose `download` names no `kind` is a `ride-package`.
- A downloader provides its capability in `initialize`, as every provider does.

## Consequences

- A YouTube downloader (plan step D) is a plugin of the kind `youtube` and needs no change of the source. Since 2026-11-22 (plan step B) ridrs Scenic lists its published YouTube videos at Lokalisierungsstufe 3 or better with a route and an elevation profile in the ride catalog, `download.kind: "youtube"` with the video's id, its frame rate and Scenic's package without the video; the source hands the downloader the catalog's whole `download` as `details`, and credits a route to its own `author` (the channel) where its source has none. Without a YouTube downloader they are not offered.
- A host without `download-ride-package` offers no route of ridrs Scenic; every composition that wants them lists both plugins.
- The quality choice is in the ride page and the briefing; no current downloader uses it, the scenarios test it with a test downloader.
