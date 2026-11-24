// Kartendaten: smart context order — when opened from Einrichten, Geofabrik download comes FIRST; standalone page focuses on managing local maps & elevation cache.
import { api } from "../api";
import { S, bus, refreshPbfs, toast } from "../state";
import type { Bbox, DownloadProgress, GeofabrikCandidate } from "../types";
import { banner, btn, chip, disclosure, progressBar } from "../ui/components";
import { openDialog } from "../ui/dialog";
import { bboxCovers, el, fmtBytes, fmtSize } from "../util";

const dl: { id: string | null; p: DownloadProgress | null; msg: string } = { id: null, p: null, msg: "" };
export function initMapData() {
  void api.onDownloadProgress((p) => { dl.id = p.id; dl.p = p; dl.msg = ""; bus.emit("pbf-dl"); });
  void api.onDownloadDone(async (r) => {
    dl.id = null; dl.p = null;
    dl.msg = r.ok ? "" : r.cancelled ? "Abgebrochen." : `Fehler: ${navigator.onLine ? r.error : "Keine Verbindung."}`;
    if (r.ok) { toast("Karte heruntergeladen."); await refreshPbfs(); }
    bus.emit("pbf-dl");
  });
}

function build(getBbox: () => Bbox | null, autoSearch: boolean, inDialog: boolean): { el: HTMLElement; dispose(): void } {
  const list = el("ul", { class: "rows" });
  const renderList = () => {
    const bbox = getBbox();
    list.replaceChildren();
    if (!S.pbfs.length) list.append(el("li", { class: "muted small" }, "Noch keine lokalen Karten vorhanden."));
    for (const p of S.pbfs) {
      const covers = bbox && p.bbox && bboxCovers(p.bbox, bbox);
      list.append(el("li", { class: "data-row" },
        el("div", { class: "grow stack-xs" },
          el("div", { class: "row wrap" }, el("b", {}, p.name), chip(fmtBytes(p.bytes)), chip(p.linked ? "verknüpft" : "App-Ordner"), p.missing ? chip("Datei fehlt", "bad") : null, covers ? chip("deckt Suchrahmen ab", "ok") : null),
          el("div", { class: "small muted mono wrap-any" }, p.path)),
        btn(p.linked ? "Entfernen" : "Löschen", async () => {
          if (!p.linked && !(await api.confirm(`„${p.name}“ endgültig löschen?`))) return;
          await api.pbfRemove(p.path); await refreshPbfs();
        }, { size: "sm", attrs: { "aria-label": `${p.linked ? "Verknüpfung entfernen" : "Löschen"}: ${p.name}` } })));
    }
  };
  const add = btn("Vorhandene .osm.pbf hinzufügen …", async () => {
    const f = await api.pickPbf(); if (!f) return;
    try { await api.pbfLink(f); await refreshPbfs(); toast("Karte verknüpft (nicht kopiert)."); } catch (e) { toast(String(e), "error"); }
  }, { icon: "folder" });

  // Geofabrik
  let cands: GeofabrikCandidate[] = [], sel = 0;
  const offer = el("div", { class: "stack" });
  const status = el("div", { class: "small muted", "aria-live": "polite" });
  const bar = progressBar("Karte wird geladen");
  const dlText = el("div", { class: "small tnum" });
  const dlBox = el("div", { class: "stack", hidden: true }, bar.el, dlText, el("div", {}, btn("Download abbrechen", () => void api.pbfDownloadCancel(), { size: "sm" })));
  const dlMsg = el("div", { class: "field-error", hidden: true, role: "alert" });
  const startBtn = btn("Herunterladen", async () => {
    const c = cands[sel];
    dl.id = c.id; dl.p = null; dl.msg = ""; renderDl();
    try { await api.pbfDownload(c.id, c.url, c.file); } catch (e) { dl.id = null; dl.msg = String(e); renderDl(); }
  }, { kind: "primary", icon: "download" });
  const renderOffer = () => {
    offer.replaceChildren();
    if (!cands.length) return;
    const c = cands[sel];
    offer.append(
      el("div", {}, "Passende Region: ", el("b", {}, `${c.name}${c.parent ? ` (${c.parent})` : ""}`), ` · ${fmtBytes(c.bytes)}`),
      cands.length > 1 ? el("select", { "aria-label": "Region", onchange: (e: Event) => { sel = (e.target as HTMLSelectElement).selectedIndex; renderOffer(); } }, ...cands.map((x, i) => el("option", { selected: i === sel }, `${x.name} · ${fmtBytes(x.bytes)}`))) : "",
      el("div", { class: "small muted wrap-any" }, `Quelle: Geofabrik (${c.url})`),
      el("div", {}, startBtn));
    renderDl();
  };
  const renderDl = () => {
    const p = dl.p;
    dlBox.hidden = !dl.id;
    startBtn.disabled = !!dl.id;
    dlMsg.hidden = !dl.msg; dlMsg.textContent = dl.msg;
    if (!dl.id) return;
    const f = p?.total ? (100 * p.bytes) / p.total : null;
    bar.set(p ? f : null);
    dlText.textContent = p ? `${fmtBytes(p.bytes)}${p.total ? ` von ${fmtBytes(p.total)} (${Math.round(f!)} %)` : ""} · ${fmtBytes(p.rate)}/s${p.rate && p.total ? ` · noch ca. ${Math.ceil((p.total - p.bytes) / p.rate / 60)} Min.` : ""}` : "Verbinde …";
  };
  const find = async () => {
    const bbox = getBbox();
    if (!bbox) { status.textContent = "Zuerst in einem Projekt einen Suchrahmen zeichnen."; return; }
    status.textContent = "Suche kleinste passende Region im Geofabrik-Index …";
    try {
      cands = await api.geofabrikCandidates(bbox); sel = 0;
      status.textContent = cands.length ? "" : "Keine Geofabrik-Region deckt den Suchrahmen vollständig ab.";
      renderOffer();
    } catch (e) { status.textContent = navigator.onLine ? String(e) : "Keine Verbindung: Der Geofabrik-Index kann nicht geladen werden."; }
  };
  const bboxLine = el("p", { class: "small muted" });
  const findBtn = btn("Passende Region suchen", () => void find(), { icon: "search" });

  // Elevation cache
  const demList = el("ul", { class: "rows" });
  const renderDem = async () => {
    const tiles = await api.demList();
    demList.replaceChildren();
    if (!tiles.length) demList.append(el("li", { class: "muted small" }, "Noch keine Höhendaten gespeichert. Sie werden pro Strecke in der Höhe-Ansicht geladen."));
    for (const t of tiles) {
      const name = t.source ? `${t.name} (${t.blocks ?? 0} Blöcke)` : t.name.replace("Copernicus_DSM_COG_10_", "").replace("_DEM", "").replace(/_00/g, "");
      demList.append(el("li", { class: "data-row" },
        el("div", { class: "grow stack-xs" },
          el("div", { class: "row wrap" }, el("b", {}, name), t.sea ? chip("Meer") : chip(fmtBytes(t.bytes))),
          el("div", { class: "small muted mono wrap-any" }, t.path)),
        btn("Löschen", async () => { if (await api.confirm(`Höhendaten „${t.name}“ löschen?`)) { await api.demRemove(t.name); void renderDem(); } }, { size: "sm", attrs: { "aria-label": `Höhendaten ${name} löschen` } })));
    }
  };
  const sync = () => {
    renderList();
    const b = getBbox();
    bboxLine.textContent = b ? `Suchrahmen: ${fmtSize(b)}.` : "Öffne ein Projekt und klicke unter Einrichten auf „Kartendaten laden …“, um automatisch die kleinste passende Region zu finden.";
    findBtn.hidden = !b;
  };
  bus.on("pbfs", sync); bus.on("pbf-dl", renderDl);
  sync(); void renderDem(); renderDl();
  if (autoSearch) void find();

  const localSec = el("section", { class: "stack" }, el("h2", {}, "Lokale Karten (.osm.pbf)"), list, el("div", {}, add));
  const geoSec = el("section", { class: "stack" }, el("h2", {}, "Von Geofabrik laden"), bboxLine, el("div", {}, findBtn), status, offer, dlBox, dlMsg);
  const demHelp = el("p", { class: "help" }, "Copernicus DEM GLO-30 © DLR/Airbus/EU/ESA sowie nationale/regionale Geländemodelle (IGN Frankreich, IGN Spanien, INGV, Südtirol, swisstopo, BEV, Bayern, Hessen, NRW, NASADEM).");
  const demSec = inDialog
    ? disclosure("Gespeicherte Höhendaten", demList, demHelp)
    : el("section", { class: "stack" }, el("h2", {}, "Höhendaten"), demList, demHelp);

  const root = el("div", { class: "stack mapdata" }, ...(inDialog ? [geoSec, localSec, demSec] : [localSec, geoSec, demSec]));
  return { el: root, dispose() { bus.off("pbfs", sync); bus.off("pbf-dl", renderDl); } };
}

export function mountMaps(root: HTMLElement) {
  const page = el("div", { class: "page narrow" },
    el("div", { class: "stack-xs" },
      el("h1", {}, "Kartendaten"),
      el("p", { class: "lead" }, "Lokale OpenStreetMap-Dateien (.osm.pbf) und gespeicherte Höhendaten. Nichts wird ohne deinen Klick geladen.")),
    );
  const offline = banner("warn", "Keine Verbindung: Herunterladen ist gerade nicht möglich. Vorhandene Karten funktionieren weiter.");
  offline.hidden = navigator.onLine;
  window.addEventListener("online", () => (offline.hidden = true)); window.addEventListener("offline", () => (offline.hidden = false));
  page.append(offline, el("div", { class: "panel" }, build(() => null, false, false).el));
  root.append(page);
}

export function openMapData(autoSearch: boolean) {
  const b = build(() => S.bbox, autoSearch, true);
  openDialog("Kartendaten", b.el, { wide: true, onClose: b.dispose });
}
