// Kartendaten: local .osm.pbf extracts, the Geofabrik download and the elevation tiles. A full view, and a dialog from Einrichten.
import { api } from "../api";
import { S, bus, refreshPbfs, toast } from "../state";
import type { Bbox, DownloadProgress, GeofabrikCandidate } from "../types";
import { banner, btn, chip, progressBar } from "../ui/components";
import { openDialog } from "../ui/dialog";
import { bboxCovers, el, fmtBytes, fmtSize } from "../util";

// the running download (one at a time), kept here so that every open instance shows it
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

/** the three sections; bbox: the search frame the coverage and the Geofabrik search refer to */
function build(getBbox: () => Bbox | null, autoSearch: boolean): { el: HTMLElement; dispose(): void } {
  const list = el("ul", { class: "rows" });
  const renderList = () => {
    const bbox = getBbox();
    list.replaceChildren();
    if (!S.pbfs.length) list.append(el("li", { class: "muted" }, "Noch keine lokalen Karten."));
    for (const p of S.pbfs) {
      const covers = bbox && p.bbox && bboxCovers(p.bbox, bbox);
      list.append(el("li", { class: "data-row" },
        el("div", { class: "grow" },
          el("div", {}, el("b", {}, p.name), " ", chip(p.linked ? "verknüpft (nicht kopiert)" : "App-Ordner"), p.missing ? chip("Datei fehlt", "bad") : null, covers ? chip("deckt den Suchrahmen ab", "ok") : null),
          el("div", { class: "small muted wrap-any" }, `${fmtBytes(p.bytes)} · ${p.bbox ? `Kartenbereich S ${p.bbox[0].toFixed(2)}…N ${p.bbox[2].toFixed(2)}, W ${p.bbox[1].toFixed(2)}…O ${p.bbox[3].toFixed(2)}` : (p.error ?? "kein Kopf-Bereich")} · ${p.path}`)),
        btn(p.linked ? "Verknüpfung entfernen" : "Löschen", async () => {
          if (!p.linked && !(await api.confirm(`„${p.name}“ endgültig löschen?`))) return;
          await api.pbfRemove(p.path); await refreshPbfs();
        }, { size: "sm", attrs: { "aria-label": `${p.linked ? "Verknüpfung entfernen" : "Löschen"}: ${p.name}` } })));
    }
  };
  const add = btn("Vorhandene Datei hinzufügen …", async () => {
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
      el("div", {}, "Kleinste Region, die den Suchrahmen abdeckt: ", el("b", {}, `${c.name} (${c.parent || "Welt"})`), ` · ${fmtBytes(c.bytes)}`),
      cands.length > 1 ? el("select", { "aria-label": "Region", onchange: (e: Event) => { sel = (e.target as HTMLSelectElement).selectedIndex; renderOffer(); } }, ...cands.map((x, i) => el("option", { selected: i === sel }, `${x.name} · ${fmtBytes(x.bytes)}`))) : "",
      el("div", { class: "small muted wrap-any" }, `Quelle: Geofabrik (${c.url}). Der Download startet erst mit deinem Klick.`),
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
    status.textContent = "Lade den Geofabrik-Index und suche die kleinste passende Region …";
    try {
      cands = await api.geofabrikCandidates(bbox); sel = 0;
      status.textContent = cands.length ? "" : "Keine Geofabrik-Region deckt den Suchrahmen vollständig ab.";
      renderOffer();
    } catch (e) { status.textContent = navigator.onLine ? String(e) : "Keine Verbindung: Der Geofabrik-Index kann nicht geladen werden."; }
  };
  const bboxLine = el("p", { class: "small muted" });
  const findBtn = btn("Passende Region suchen (lädt den Geofabrik-Index)", () => void find());

  // elevation
  const demList = el("ul", { class: "rows" });
  const renderDem = async () => {
    const tiles = await api.demList();
    demList.replaceChildren();
    if (!tiles.length) demList.append(el("li", { class: "muted small" }, "Noch keine Höhendaten. Sie werden für das Höhenprofil und den Export für Incyclist geladen (Copernicus DEM GLO-30, eine Kachel 1° × 1°, etwa 25–60 MB)."));
    for (const t of tiles) {
      const name = t.source ? `${t.name} (genauere Höhendaten, ${t.blocks ?? 0} Blöcke)` : t.name.replace("Copernicus_DSM_COG_10_", "").replace("_DEM", "").replace(/_00/g, "");
      demList.append(el("li", { class: "data-row" },
        el("div", { class: "grow" }, el("div", {}, el("b", {}, name), t.sea ? chip("Meer (keine Kachel)") : null), el("div", { class: "small muted wrap-any" }, `${t.sea ? "" : fmtBytes(t.bytes) + " · "}${t.path}`)),
        btn("Löschen", async () => { if (await api.confirm(`Höhendaten „${t.name}“ löschen?`)) { await api.demRemove(t.name); void renderDem(); } }, { size: "sm", attrs: { "aria-label": `Höhendaten ${name} löschen` } })));
    }
  };
  const sync = () => { renderList(); const b = getBbox(); bboxLine.textContent = b ? `Suchrahmen des offenen Projekts: ${fmtSize(b)}.` : "Kein Projekt mit Suchrahmen geöffnet. Die passende Region findest du am einfachsten aus einem Projekt heraus (Einrichten › Kartendaten laden)."; findBtn.disabled = !b; };
  bus.on("pbfs", sync); bus.on("pbf-dl", renderDl);
  sync(); void renderDem(); renderDl();
  if (autoSearch) void find();
  const root = el("div", { class: "stack mapdata" },
    el("section", { class: "stack" }, el("h2", {}, "Karten (.osm.pbf)"), list, el("div", {}, add)),
    el("section", { class: "stack" }, el("h2", {}, "Von Geofabrik laden"), bboxLine, el("div", {}, findBtn), status, offer, dlBox, dlMsg),
    el("section", { class: "stack" }, el("h2", {}, "Höhendaten"), demList, el("p", { class: "help" }, "Copernicus DEM GLO-30 © DLR e.V. 2010-2014 und © Airbus Defence and Space GmbH 2014-2018, bereitgestellt unter COPERNICUS von der Europäischen Union und der ESA."),
      el("p", { class: "help" }, "Genauere Höhendaten werden je Strecke nur für die Blöcke entlang der Route geladen: IGN RGE ALTI (Frankreich, Licence Ouverte 2.0), TINITALY 1.1 (Italien, INGV, CC BY 4.0), DTM Südtirol (CC0), swissALTI3D (© swisstopo), ALS-DGM Österreich (© BEV, CC BY 4.0), DGM1 Bayern (CC BY 4.0), Hessen und NRW (dl-de/zero-2-0), die Copernicus-Füllmaske und NASADEM (NASA, gemeinfrei). Jeder Export nennt die tatsächlich verwendeten Quellen.")));
  return { el: root, dispose() { bus.off("pbfs", sync); bus.off("pbf-dl", renderDl); } };
}

export function mountMaps(root: HTMLElement) {
  const page = el("div", { class: "page" }, el("h1", {}, "Kartendaten"),
    el("p", { class: "lead" }, "Die Berechnung braucht die Straßen als lokale OpenStreetMap-Datei (.osm.pbf), die den Suchrahmen abdeckt. Nichts wird ohne deinen Klick geladen."));
  const offline = banner("warn", "Keine Verbindung: Herunterladen ist gerade nicht möglich. Vorhandene Karten funktionieren weiter.");
  offline.hidden = navigator.onLine;
  window.addEventListener("online", () => (offline.hidden = true)); window.addEventListener("offline", () => (offline.hidden = false));
  page.append(offline, el("div", { class: "panel" }, build(() => null, false).el));
  root.append(page);
}

/** from Einrichten: the same content as a dialog, for the search frame of the open project */
export function openMapData(autoSearch: boolean) {
  const b = build(() => S.bbox, autoSearch);
  openDialog("Kartendaten", b.el, { wide: true, onClose: b.dispose });
}
