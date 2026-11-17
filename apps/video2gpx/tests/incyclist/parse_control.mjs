// Compatibility check of an exported Incyclist package with the Ridrs importer (now packages/ride/src/control.ts).
// parseControl below is a JS copy of the importer as of 2026-11-11; its two dependencies are loaded read-only from
// packages/ride/node_modules (RIDRS_PLUGIN overrides the folder). Nothing outside this app is changed.
//   node tests/incyclist/parse_control.mjs <control.xml> [--expect-video NAME.mp4] [--expect-gpx NAME.gpx] [--expect-fps 50] [--expect-start 1051]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const PLUGIN = process.env.RIDRS_PLUGIN ?? new URL("../../../../packages/ride/", import.meta.url).pathname;
const req = createRequire(PLUGIN.endsWith("/") ? PLUGIN : PLUGIN + "/");
const { XMLParser } = req("fast-xml-parser");
const { decodeHTML } = req("entities");

function decodeText(bytes) {
  const encoding = bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-8";
  return new TextDecoder(encoding).decode(bytes);
}
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false, parseAttributeValue: false,
  isArray: (name) => name === "information" || name === "segment" });
const list = (value) => (Array.isArray(value) ? value : []);
const XML_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);
const withoutHtmlEntities = (text) => text.replace(/&([A-Za-z][A-Za-z0-9]*);/g, (entity, name) => (XML_ENTITIES.has(name) ? entity : decodeHTML(entity).replace("&", "&amp;")));
export function parseControl(text) {
  const root = parser.parse(withoutHtmlEntities(text))["gpx-import"];
  const video = String(root?.["video-file-path"] ?? "").trim();
  const gpx = String(root?.["gpx-file-path"] ?? "").trim();
  if (!video || !gpx) throw new Error("The control file names no video or no GPX track");
  const notes = list(root?.informations?.information).map(({ distance, ...text }) => ({
    distance: Number(distance),
    text: Object.fromEntries(Object.entries(text).map(([language, value]) => [language, value.replaceAll("\\n", "\n")])),
  }));
  const segments = list(root?.segments?.segment).map((segment) => ({ name: segment.name ?? "", start: Number(segment.start), end: Number(segment.end) }));
  return {
    video, gpx,
    framerate: Number(root?.framerate) || 30,
    startFrame: Number(root?.["start-frame"]) || 1,
    notes: notes.filter((note) => Number.isFinite(note.distance) && note.distance >= 0),
    segments: segments.filter((s) => s.name && Number.isFinite(s.start) && Number.isFinite(s.end)),
  };
}

const [file, ...rest] = process.argv.slice(2);
const c = parseControl(decodeText(readFileSync(file)));
console.log(JSON.stringify(c, null, 2));
const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (opt("--expect-video") && c.video !== opt("--expect-video")) fail(`video ${c.video}`);
if (opt("--expect-gpx") && c.gpx !== opt("--expect-gpx")) fail(`gpx ${c.gpx}`);
if (opt("--expect-fps") && Math.abs(c.framerate - Number(opt("--expect-fps"))) > 1e-4) fail(`framerate ${c.framerate}`);
if (opt("--expect-start") && c.startFrame !== Number(opt("--expect-start"))) fail(`startFrame ${c.startFrame}`);
if (c.notes.length < 2 || !c.notes[0].text.de.includes("\n")) fail("notes");
console.log("OK: parsed by the Ridrs parseControl logic");
