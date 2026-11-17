<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ridrs ride v1

A `.ride` file is one video route: a ZIP whose files, unpacked into a folder, are an Incyclist video folder (`gpx-import`). Incyclist imports that folder unchanged; ridrs plays the route from the ZIP without unpacking it, or from such a folder unpacked.

- File name: `<anything>.ride`; a ZIP with the same files and `.zip` is read the same way
- Decision record: [ADR 0094](../decisions/0094-video-routes-stored-as-ride-packages.md); dragged and chosen packages: ADR 0090, ADR 0093
- Reader and writer of the control file: `packages/ride` (`@ridrs/ride`); entries of a route's folder: `crates/ridrs-media/src/ride.rs`

## Files

```text
Col_de_la_Madone.ride
  FR_Col_de_la_Madone.xml     the control file (gpx-import)
  FR_Col_de_la_Madone.mp4     the video the control file names; stored, not compressed
  FR_Col_de_la_Madone.gpx     the GPX track the control file names; its times are the video's
  preview.jpg                 optional: the route's picture
  …                           anything else; ignored (video2gpx adds video2gpx.json and LIESMICH.txt)
```

- **The video entry is stored** (ZIP compression method 0), so it can be played by range straight from the ZIP. ZIP64 is fine. Every other entry may be stored or deflated.
- **The video may come in any container ridrs reads** (ADR 0101): MP4, M4V or QuickTime (`.mp4`, `.m4v`, `.mov`, with the sample table anywhere, not fragmented) or Matroska and WebM (`.mkv`, `.webm`, with cues). Its codec must be one the platform's WebCodecs decodes: H.264, HEVC, VP9 or AV1. The control file names it with its own extension.
- Paths in the control file are relative to the control file; the video, the track and the control file lie in one folder of the ZIP.
- The picture is the one `<preview>` names, else the first of `preview.png`, `preview.jpg`, `<video>_preview.png` and `<video>_preview.jpg` next to the video, letters compared without case: the names Incyclist looks for. No other name is a picture.
- The title is `<title>`, else `<name>`, else the file's name.

## The control file

UTF-8, or UTF-16 with a byte order mark. HTML's named entities (`&auml;`) are read as their characters.

```xml
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<gpx-import>
  <name>FR_Col_de_la_Madone</name>
  <title>Route du Col de la Madone</title>
  <video-file-path>FR_Col_de_la_Madone.mp4</video-file-path>
  <gpx-file-path>FR_Col_de_la_Madone.gpx</gpx-file-path>
  <framerate>50</framerate>
  <start-frame>1</start-frame>
  <preview>preview.jpg</preview>
  <informations>
    <information distance="20" de="Col de la Madone\nLänge: 22,9 km" en="Col de la Madone\nLength: 22.9 km" />
  </informations>
  <segments>
    <segment name="The climb" start="0" end="12000" />
  </segments>
</gpx-import>
```

| Element | Required | ridrs reads it as |
|---|---|---|
| `video-file-path` | yes | the video |
| `gpx-file-path` | yes | the track; its times map the route onto the video |
| `framerate` | no, 30 | frames per second of the video, never rounded |
| `start-frame` | no, 1 | the video frame of the track's first point |
| `title` | no | the route's title: a text, or one element per language (`<de>`, `<en>`) of which the first is shown, as in Incyclist |
| `name` | no | the route's technical name; without `<title>` its title, without the country of its first two letters (`FR_`) and with `_` as spaces (Incyclist keeps the `_`) |
| `preview` | no | the route's picture |
| `informations/information` | no | notes along the route: `distance` in m from the start, the text by language in one attribute each; `\n` is a line break |
| `segments/segment` | no | named parts of the route: `name`, `start` and `end` in m |

Incyclist reads more (`id`, `country`, `description1`, `end-frame`, `duration`, `next-video`, `cuts`, `elevation-shift`, `autoCorrect`, `previewURL`); ridrs keeps them and reads them once it needs them. Elements neither app knows are ignored by both: a writer may add its own. There is no ridrs extension in v1.

## A route's folder in the media storage

```text
<media>/videos/<source>/<route>/
  route.ride      optional: the package, never changed after it is stored
  <path>          a file that replaces or adds the entry <path> of route.ride; without a package, an entry
```

A route is the entries of its package and the files beside it: a file whose path equals an entry's path (letters compared without case) replaces that entry, any other adds one. A folder without `route.ride` is a route of its files alone, as Incyclist would read the unpacked package. Hidden files (`.DS_Store`) are no entries. A route gets a picture, a corrected track or a better control file as a file beside its package, which stays as it was.

## For writers

- Store the video, deflate the text (video2gpx does).
- Write both `<name>` (technical, e.g. `FR_Col_de_la_Madone`) and `<title>` (what riders read).
- Name the picture in `<preview>`, best as `preview.jpg` or `preview.png`.
- Write the control file in UTF-8 and line breaks in notes as `\n`.
