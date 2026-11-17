// Unit-like checks without a test runner (no new dependency): ?mock=selfcheck#/_selfcheck prints pass/fail into the page.
// The screenshot script reads the result from [data-selfcheck].
import { classifySource } from "../features/import";
import { reasonDe } from "../features/gloss";
import { freshRun, overallPct, reduce, runningSteps } from "../state";
import { el } from "../util";

type Case = [string, () => boolean];

const kind = (s: string) => classifySource(s).kind;
const CASES: Case[] = [
  ["leer", () => kind("   ") === "empty"],
  ["https-Adresse", () => kind("https://example.org/watch?v=1") === "url"],
  ["http-Adresse mit Leerzeichen am Rand", () => kind("  http://example.org/a  ") === "url"],
  ["Adresse ohne Punkt im Host ist keine", () => kind("https://example") === "unknown"],
  ["localhost-Adresse", () => kind("http://localhost:8080/v.mp4") === "url"],
  ["absoluter Pfad", () => { const s = classifySource("/Users/a/Movies/ride.MP4"); return s.kind === "file" && !s.volume; }],
  ["Pfad in Anführungszeichen", () => kind("'/Users/a/ride.mov'") === "file"],
  ["Home-Pfad", () => kind("~/Movies/ride.mkv") === "file"],
  ["Netzlaufwerk", () => { const s = classifySource("/Volumes/NAS/ride.mp4"); return s.kind === "file" && s.volume; }],
  ["file://-Adresse mit %20", () => { const s = classifySource("file:///Users/a/My%20Ride.mp4"); return s.kind === "file" && s.path === "/Users/a/My Ride.mp4"; }],
  ["keine Videodatei", () => { const s = classifySource("/Users/a/notes.txt"); return s.kind === "unknown" && s.reason === "novideo"; }],
  ["Text", () => { const s = classifySource("Rousset Pontaix"); return s.kind === "unknown" && s.reason === "unknown"; }],
  ["Schritte laufen parallel", () => {
    const r = freshRun();
    reduce(r, { type: "step", id: "motion", index: 1, of: 7, state: "running", pct: 40 });
    reduce(r, { type: "step", id: "rotation", index: 2, of: 7, state: "running", pct: 30 });
    reduce(r, { type: "step", id: "map", index: 3, of: 7, state: "done", seconds: 48 });
    return runningSteps(r).join(",") === "motion,rotation" && r.steps.map.state === "done" && r.steps.map.pct === 100 && r.steps.map.seconds === 48;
  }],
  ["Eingabe-Ereignis", () => {
    const r = freshRun();
    reduce(r, { type: "input", state: "growing", pct: 58, bytes: 1, total: 2 });
    return r.input?.state === "growing" && r.input.pct === 58 && r.started;
  }],
  ["wartet auf das Video", () => {
    const r = freshRun();
    reduce(r, { type: "step", id: "motion", index: 1, of: 7, state: "running", pct: 50, waiting_for_input: true });
    return !!r.steps.motion.waiting;
  }],
  ["Gesamtfortschritt aus den Schritten", () => {
    const r = freshRun();
    const p0 = overallPct(r);
    reduce(r, { type: "step", id: "motion", index: 1, of: 7, state: "done" });
    const p1 = overallPct(r);
    reduce(r, { type: "progress", pct: 77 });
    return p0 === 0 && p1 > 0 && p1 < 100 && overallPct(r) === 77;
  }],
  ["unbekannter Schritt wird übergangen", () => { const r = freshRun(); reduce(r, { type: "step", id: "nope" as any, index: 9, of: 9, state: "running" }); return runningSteps(r).length === 0; }],
  ["Ende", () => { const r = freshRun(); r.running = true; reduce(r, { type: "exit", code: 3, cancelled: false }); return !r.running && r.exit?.code === 3; }],
  ["Grund übersetzt", () => reasonDe("mean posterior 0.84 < 0.9").text === "Mittlere Sicherheit 0,84 (unter 0,9)"],
  ["unbekannter Grund bleibt", () => !reasonDe("something new").known],
];

export function mountSelfcheck(root: HTMLElement) {
  const rows = CASES.map(([name, f]) => { let ok = false; try { ok = f(); } catch { ok = false; } return { name, ok }; });
  const failed = rows.filter((r) => !r.ok).length;
  root.append(el("div", { class: "page narrow" },
    el("h1", {}, "Selbsttest"),
    el("p", { class: failed ? "bad-text" : "ok-text", "data-selfcheck": failed ? "fail" : "pass" }, failed ? `${failed} von ${rows.length} Prüfungen fehlgeschlagen` : `Alle ${rows.length} Prüfungen bestanden`),
    el("ul", { class: "rows" }, ...rows.map((r) => el("li", { class: r.ok ? "ok-text" : "bad-text" }, `${r.ok ? "bestanden" : "FEHLER"}: ${r.name}`)))));
}
