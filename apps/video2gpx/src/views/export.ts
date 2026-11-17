// Export: start time of the GPX timestamps, the GPX card, and the Incyclist card (incyclist.ts).
import { api } from "../api";
import { routePath } from "../app/router";
import { incyclistCard } from "../incyclist";
import { S, bus, saveCur, toast } from "../state";
import { banner, btn, field } from "../ui/components";
import { debounce, el, fmtBytes, fromLocalInput, toLocalInput } from "../util";
import { revealLabel } from "../app/platform";

let root: HTMLElement, eleIn: HTMLInputElement, warn: HTMLElement, startIn: HTMLInputElement, fromFile: HTMLButtonElement, gpxInfo: HTMLElement, gpxRes: HTMLElement;
let inc: ReturnType<typeof incyclistCard>;
let builtFor = "";

export function mountExport(mainEl: HTMLElement) {
  root = el("div", { class: "export-view", hidden: true });
  warn = el("div", {});
  startIn = el("input", { type: "datetime-local" });
  fromFile = btn("aus Videodatei", () => { const ct = S.cur?.app.probe?.creation_time; if (ct) startIn.value = toLocalInput(ct); }, { size: "sm" });
  const apply = btn("Übernehmen", () => void retime(), { size: "sm" });
  gpxInfo = el("p", { class: "small muted" });
  eleIn = el("input", { type: "checkbox", checked: true });
  gpxRes = el("div", { class: "small", "aria-live": "polite" });
  inc = incyclistCard();
  root.append(warn,
    el("section", { class: "panel row wrap end-align" }, field("Startzeit der GPX-Zeitstempel", startIn, "Uhrzeit des ersten Videobilds. Schreibt nur die Zeiten neu, ohne Neuberechnung.", "grow").el, fromFile, apply),
    el("div", { class: "cards" },
      el("section", { class: "panel stack card", "aria-labelledby": "gpx-h" }, el("h2", { id: "gpx-h" }, "GPX"), gpxInfo,
        el("label", { class: "row small" }, eleIn, "mit Höhen (aus dem Höhenprofil)"),
        el("div", { class: "row wrap" }, btn("GPX speichern …", () => void exportGpx(), { kind: "primary", icon: "download", attrs: { "data-primary": "" } }), btn(revealLabel, () => S.result && void api.reveal(S.result.gpx), { icon: "folder" })), gpxRes),
      inc.el));
  mainEl.append(root);
  bus.on("stage", (s: string | null) => { root.hidden = s !== "export"; if (s === "export") show(); });
  bus.on("result", () => { if (!root.hidden) show(); });
  // the profile is made or changed (Höhe stage, or the playback panel computing it): the elevation line of the Incyclist card follows
  const again = debounce(() => { if (!root.hidden) inc.refresh(); }, 500);
  bus.on("elevation", again);
}

function show() {
  const cur = S.cur, r = S.result;
  if (!cur || !r) return;
  warn.replaceChildren();
  if (r.verdict === "uncertain") warn.append(banner("warn", "Die Route ist unsicher. Prüfe sie im Ergebnis, bevor du sie verwendest. ", el("a", { href: routePath.project(cur.app.id, "ergebnis") }, "Zum Ergebnis")));
  if (r.verdict === "no_route") warn.append(banner("bad", "Die App hat keine verlässliche Route gefunden. Die Dateien lassen sich trotzdem speichern, sollten aber nicht verwendet werden."));
  startIn.value = toLocalInput(cur.app.start_time ?? r.project.effective?.start_time);
  fromFile.hidden = !cur.app.probe?.creation_time;
  gpxInfo.textContent = `1 Punkt pro Sekunde · ${r.points.length} Punkte · ${fmtBytes(r.gpx_bytes)}`;
  if (builtFor !== cur.app.id) { builtFor = cur.app.id; gpxRes.textContent = ""; inc.build(); }
  else { inc.update(); inc.refresh(); }   // the elevation may have changed in the Höhe stage
}

async function retime() {
  const cur = S.cur, r = S.result;
  if (!cur || !r) return;
  const iso = fromLocalInput(startIn.value);
  if (!iso) { toast("Bitte Datum und Uhrzeit eingeben.", "error"); startIn.focus(); return; }
  try { const res = await api.pipelineRetime(cur.app.id, iso); await saveCur({ start_time: iso }); toast(`Startzeit gesetzt: ${res.start_time ?? iso} (${res.points ?? r.points.length} Punkte), ohne Neuberechnung.`); }
  catch (e) { toast(String(e), "error"); }
}

async function exportGpx() {
  const cur = S.cur, r = S.result;
  if (!cur || !r) return;
  if (r.verdict === "no_route" && !(await api.confirm("Die App hat keine verlässliche Route gefunden. Trotzdem exportieren?"))) return;
  const name = (cur.app.probe?.title ?? cur.app.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "route";
  const dest = await api.pickSave(`${name}.gpx`);
  if (!dest) return;
  try {
    gpxRes.textContent = eleIn.checked ? "Speichere mit Höhen …" : "Speichere …";
    const res = await api.gpxExport(cur.app.id, dest, eleIn.checked);
    gpxRes.replaceChildren(el("span", { class: "ok-text" }, `Gespeichert: ${dest} (${Math.round(res.bytes / 1024)} kB, ${res.ele ? "mit" : "ohne"} Höhen)`), " ", btn(revealLabel, () => void api.reveal(dest), { size: "sm" }));
    if (res.note) gpxRes.append(el("div", { class: "warn-text" }, res.note));
  }
  catch (e) { gpxRes.textContent = ""; toast(String(e), "error"); }
}
