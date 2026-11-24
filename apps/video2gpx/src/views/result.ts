// Ergebnis: unified page merging Übersicht, Höhe, and Analyse as 3 views under one verdict header,
// with a view switcher and always-available "Ort festlegen" toolbar above synced video & map.
import { analyseBusy, analyseReady } from "../analyse";
import { RESULT_VIEWS, go, routePath, type ResultView } from "../app/router";
import { RESULT_VIEW_LABEL, currentResultView } from "../app/shell";
import { token } from "../app/theme";
import { E, anythingMissing, elevationBusy, profileCurrent } from "../elevation";
import { LEVEL_DE, LEVEL_TONE, VERDICT, VEHICLE_DE, gloss, reasonDe } from "../features/gloss";
import { rideState, zAt } from "../ridePanel";
import { S, bus, saveCur } from "../state";
import type { ResultData } from "../types";
import { banner, btn, chip, disclosure, iconBtn, statusRow, toneIcon } from "../ui/components";
import { icon, type IconName } from "../ui/icons";
import { CONF_COLORS, confClass, el, fmtBytes, fmtDur, fmtKm, pointAt } from "../util";
import { getPlayer, togglePlay, videoDuration } from "../videoPanel";
import { introChanged, introMmss, introParam } from "../intro";
import { start } from "../features/run";
import { isRouteEdited, normalizeEdit } from "../routeEdit";

const CONF_DE = { high: "hoch", mid: "mittel", low: "gering", none: "außerhalb des erkannten Abschnitts" } as const;
const VIEW_ICON: Record<ResultView, IconName> = { uebersicht: "route", hoehe: "mountain", analyse: "activity" };
let head: HTMLElement, tl: HTMLElement;
let vIcon: HTMLElement, vTitle: HTMLHeadingElement, vFacts: HTMLElement, vChips: HTMLElement, vReasons: HTMLElement, vAlert: HTMLElement;
let exportBtn: HTMLButtonElement, analyseBtn: HTMLButtonElement;
const tabBtns = {} as Record<ResultView, HTMLButtonElement>;
let playBtn: HTMLButtonElement, introBtn: HTMLButtonElement, introSetBtn: HTMLButtonElement, introRerunBtn: HTMLButtonElement, introAutoBtn: HTMLButtonElement, introStatus: HTMLElement;
let timeEl: HTMLElement, track: HTMLElement, canvas: HTMLCanvasElement, tip: HTMLElement, eleNote: HTMLElement, eleRange: HTMLElement, sigDisc: HTMLDetailsElement, sigSum: HTMLElement, sigBody: HTMLElement;
let adjustDisc: HTMLDetailsElement, adjustSummary: HTMLElement, adjustForProject = "";
let curT = 0;

export interface ResultMounts {
  /** Container inside the collapsible "Route anpassen & korrigieren" panel (Übersicht view) for routeEditor & advanced step rerun. */
  adjustHost: HTMLElement;
  /** Toolbar slot on the right of the view switcher (always visible in all 3 views) for "Ort festlegen" & rerun button. */
  anchorBarHost: HTMLElement;
  /** Compact tray below the toolbar (always visible in all 3 views when anchors exist or drawing is active). */
  anchorTrayHost: HTMLElement;
}

/** Mounts Ergebnis and returns the host elements for routeEditor & anchorPanel. */
export function mountResult(headEl: HTMLElement, tlEl: HTMLElement): ResultMounts {
  head = headEl; tl = tlEl;
  vIcon = el("span", { class: "tone" });
  vTitle = el("h1", { class: "verdict-h", tabIndex: -1 });
  vFacts = el("div", { class: "small muted" });
  vChips = el("div", { class: "row wrap" });
  vReasons = el("div", { class: "small" });
  vAlert = el("div", {});
  analyseBtn = btn("In Analyse prüfen", () => go(routePath.project(S.cur!.app.id, "ergebnis", "analyse")), { icon: "activity" });
  analyseBtn.hidden = true;
  exportBtn = btn("Weiter: Export", () => go(routePath.project(S.cur!.app.id, "export")), { kind: "primary", icon: "chevron", attrs: { "data-primary": "" } });

  // ---- 3-view switcher (Übersicht, Höhe, Analyse) + always-available "Ort festlegen" slot
  const tablist = el("div", { class: "res-tabs", role: "tablist", "aria-label": "Ergebnis-Ansichten" });
  RESULT_VIEWS.forEach((view, idx) => {
    const b = el("button", {
      type: "button",
      class: "res-tab",
      role: "tab",
      id: `res-tab-${view}`,
      "aria-selected": view === "uebersicht" ? "true" : "false",
      tabIndex: view === "uebersicht" ? 0 : -1,
      onclick: () => { if (S.cur) go(routePath.project(S.cur.app.id, "ergebnis", view)); },
      onkeydown: (e: KeyboardEvent) => {
        let next = -1;
        if (e.key === "ArrowRight") next = (idx + 1) % RESULT_VIEWS.length;
        else if (e.key === "ArrowLeft") next = (idx - 1 + RESULT_VIEWS.length) % RESULT_VIEWS.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = RESULT_VIEWS.length - 1;
        if (next >= 0) {
          e.preventDefault();
          const v = RESULT_VIEWS[next];
          tabBtns[v].focus();
          if (S.cur) go(routePath.project(S.cur.app.id, "ergebnis", v));
        }
      },
    }, icon(VIEW_ICON[view]), el("span", {}, RESULT_VIEW_LABEL[view]), el("span", { class: "res-tab-x" })) as HTMLButtonElement;
    tabBtns[view] = b;
    tablist.append(b);
  });

  const anchorBarHost = el("div", { class: "row wrap res-anchor-bar" });
  const anchorTrayHost = el("div", { class: "res-anchor-tray", hidden: true });
  const toolbar = el("div", { class: "res-toolbar row wrap between" }, tablist, anchorBarHost);

  const resHead = el("div", { class: "res-head stack-s" },
    el("div", { class: "verdict" },
      vIcon,
      el("div", { class: "grow stack-xs" }, el("div", { class: "row wrap" }, vTitle, vChips), vFacts, vReasons),
      el("div", { class: "row wrap verdict-actions" }, analyseBtn, exportBtn)),
    vAlert,
    toolbar,
    anchorTrayHost);
  head.append(resHead);

  // ---- Clean Timeline Panel
  playBtn = iconBtn("play", "Abspielen", () => togglePlay());
  introBtn = btn("Intro überspringen", () => { const t = S.result?.intro_end; if (t != null) seek(t); }, { size: "sm", icon: "chevron" });
  introBtn.hidden = true;
  timeEl = el("span", { class: "tl-time mono tnum" }, "0:00 / 0:00");
  canvas = el("canvas", { class: "tl-canvas", "aria-hidden": "true" });
  tip = el("div", { class: "tl-tip", hidden: true });
  eleNote = el("div", { class: "tl-ele-bar row wrap between small", hidden: true });
  eleRange = el("span", { class: "tl-range small muted tnum" });
  track = el("div", { class: "tl-track", role: "slider", tabIndex: 0, "aria-label": "Zeitleiste: Sicherheit und Höhe", "aria-valuemin": "0" }, canvas, tip);
  sigSum = el("span", {}); sigBody = el("div", { class: "signals" });
  sigDisc = el("details", { class: "disc" }, el("summary", {}, icon("chevron"), sigSum), el("div", { class: "disc-body" }, sigBody));
  const legend = el("div", { class: "maplegend" }, ...(["high", "mid", "low", "none"] as const).map((c) => el("span", { class: "lg" }, el("i", { class: "sw line", style: `--c:${CONF_COLORS[c]}` }), { high: "hoch ≥ 90 %", mid: "mittel 50–90 %", low: "gering", none: "außerhalb" }[c])));

  const tlPanel = el("div", { class: "panel stack tl-panel" },
    el("div", { class: "tl-row" },
      el("div", { class: "tl-ctrl" }, playBtn, timeEl),
      el("div", { class: "tl-labels small muted", "aria-hidden": "true" }, el("span", {}, "Sicherheit"), el("span", {}, "Höhe")),
      el("div", { class: "tl-wrap" }, track),
      eleRange),
    eleNote,
    el("div", { class: "row wrap between tl-foot" },
      el("div", { class: "row wrap" }, legend, introBtn),
      el("div", { class: "row wrap" },
        disclosure("Genauigkeit", el("p", { class: "small" }, "Straße richtig, wo die Sicherheit hoch ist. Entlang der Straße etwa 5–10 m in Kurven, bis 20–40 m auf langen Geraden. Seitlich: Näherung (feste Verschiebung von der OSM-Mittellinie).")),
        sigDisc)));

  // ---- Organized Collapsible "Route anpassen & korrigieren" Panel
  introSetBtn = btn("Intro-Ende hier setzen", () => void setIntro(curT), { size: "sm" });
  introRerunBtn = btn("Neu berechnen", () => void rerunIntro(), { size: "sm", kind: "primary" });
  introAutoBtn = btn("Automatisch", () => void setIntro(null), { size: "sm" });
  introRerunBtn.hidden = introAutoBtn.hidden = true;
  introStatus = el("span", { class: "small muted" });

  const introSection = el("div", { class: "adjust-sec row wrap between" },
    el("div", { class: "row wrap" }, el("span", { class: "label" }, "Intro-Ende"), introStatus),
    el("div", { class: "row wrap" }, introSetBtn, introAutoBtn, introRerunBtn));

  const adjustHost = el("div", { class: "disc-body adjust-body stack" });
  adjustSummary = el("span", { class: "small muted" });
  adjustDisc = el("details", { class: "disc adjust-disc" },
    el("summary", {}, icon("chevron"), icon("sliders"), el("span", { class: "adjust-title" }, "Route anpassen & korrigieren"), adjustSummary),
    adjustHost);
  adjustHost.append(introSection);

  tl.append(tlPanel, el("div", { class: "panel adjust-panel" }, adjustDisc));

  // seeking: pointer on the track, keys on the slider
  const tAt = (x: number) => { const r = canvas.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)) * videoDuration(); };
  track.addEventListener("pointerdown", (e) => { track.setPointerCapture(e.pointerId); seek(tAt(e.clientX)); track.onpointermove = (m) => seek(tAt(m.clientX)); });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) track.addEventListener(ev, () => { track.onpointermove = null; });
  track.addEventListener("mousemove", (e) => { const t = tAt(e.clientX), r = canvas.getBoundingClientRect(); tip.hidden = false; tip.textContent = fmtDur(t); tip.style.left = `${e.clientX - r.left}px`; });
  track.addEventListener("mouseleave", () => (tip.hidden = true));
  track.addEventListener("keydown", (e) => {
    const d = videoDuration(), step = e.shiftKey ? 30 : 5;
    const k: Record<string, () => number> = { ArrowRight: () => curT + step, ArrowUp: () => curT + step, ArrowLeft: () => curT - step, ArrowDown: () => curT - step, Home: () => 0, End: () => d, PageUp: () => curT + 30, PageDown: () => curT - 30 };
    if (k[e.key]) { e.preventDefault(); seek(Math.max(0, Math.min(d, k[e.key]()))); }
    else if (e.key === " ") { e.preventDefault(); togglePlay(); }
  });

  bus.on("time", (t: number) => { curT = t; drawSoon(); });
  bus.on("playstate", (p: boolean) => { playBtn.replaceChildren(icon(p ? "pause" : "play")); playBtn.setAttribute("aria-label", p ? "Anhalten" : "Abspielen"); playBtn.title = playBtn.getAttribute("aria-label")!; });
  for (const ev of ["result", "player", "profile", "project", "video-state", "run"]) bus.on(ev, () => { renderHead(); drawSoon(); });
  for (const ev of ["elevation", "analyse"]) bus.on(ev, renderTabs);
  bus.on("stage", (s: string | null) => { if (s === "ergebnis") { renderHead(); drawSoon(); } });
  window.addEventListener("themechange", drawSoon);
  new ResizeObserver(drawSoon).observe(canvas);
  return { adjustHost, anchorBarHost, anchorTrayHost };
}

function seek(t: number) {
  curT = t;
  if (getPlayer()) bus.emit("seek", t); else bus.emit("time", t);
  bus.emit("seeked");
  drawSoon();
}

async function setIntro(t: number | null) {
  if (!S.cur) return;
  const v = t == null ? null : introParam(t);
  if (t != null && v == null) return;
  await saveCur({ intro_end: v });
  renderHead();
}

async function rerunIntro() {
  const id = S.cur?.app.id;
  if (id && await start(false, null)) go(routePath.project(id, "berechnung"));
}

function renderHead() {
  const r = S.result, cur = S.cur;
  if (!r || !cur) return;
  const v = VERDICT[r.verdict];
  vIcon.replaceWith(vIcon = toneIcon(v.tone)); vIcon.classList.add("big");
  vTitle.textContent = v.title;
  const eff = r.project.effective ?? {};
  const km = (r.project.steps?.refine?.summary?.path_km as number | undefined) ?? (r.points.at(-1)?.arc_m ?? 0) / 1000;
  const lateral = eff.lateral_source === "video" ? "Fahrlinie aus dem Video gemessen" : eff.offset_m !== undefined ? `Fahrlinie ${String(eff.offset_m).replace(".", ",")} m ${eff.traffic_side === "left" ? "links" : "rechts"} (Näherung)` : null;
  vFacts.textContent = [km ? fmtKm(km) : null, eff.vehicle ? VEHICLE_DE[eff.vehicle] ?? eff.vehicle : null, lateral, `${r.points.length} Punkte`].filter(Boolean).join(" · ");
  vChips.replaceChildren(...chipsOf(r));
  vReasons.replaceChildren();
  if (r.reasons.length && r.verdict !== "confident") vReasons.append(el("span", {}, "Gründe: "), ...r.reasons.flatMap((x, i) => { const d = reasonDe(x); return [i ? "; " : "", el("span", { lang: d.known ? undefined : "en" }, d.text)]; }));
  vAlert.replaceChildren();
  if (S.videoMissing && cur.app.video) vAlert.append(banner("warn", "Das Video wurde nicht gefunden: ", el("span", { class: "mono wrap-any" }, cur.app.video), ". Die Karte funktioniert weiter. Unter Einrichten kannst du es neu zuordnen."));
  if (r.verdict === "no_route") vAlert.append(banner("bad", el("div", {}, "Keine verlässliche Route gefunden. Die App zeigt sie deshalb nicht an."),
    el("div", { class: "row wrap" }, S.showRoute ? null : btn("Route trotzdem anzeigen", () => { S.showRoute = true; bus.emit("result"); }, { size: "sm" }), btn("Hinweise ergänzen", () => go(routePath.project(cur.app.id, "einrichten")), { size: "sm" }))));

  // Smart CTA priority: confident -> Export is primary; uncertain / no_route -> show Analyse shortcut unless already on Analyse
  const sub = currentResultView();
  const needsCheck = r.verdict !== "confident";
  analyseBtn.hidden = !needsCheck || sub === "analyse";
  analyseBtn.className = `btn${r.verdict === "no_route" ? " primary" : ""}`;
  exportBtn.className = `btn${r.verdict === "no_route" && sub !== "analyse" ? "" : " primary"}`;
  renderTabs();

  // Intro & adjust panel summary
  const st = S.run.statuses;
  introBtn.hidden = r.intro_end == null;
  if (r.intro_end != null) introBtn.title = `Zum Ende des erkannten Intros springen (${fmtDur(r.intro_end)})`;
  const manual = introParam(cur.app.intro_end), pending = introChanged(manual, cur.app.last_run?.intro_end);
  introSetBtn.title = "Die aktuelle Videozeit als Ende des Intros übernehmen. Wirkt nach „Neu berechnen“.";
  introRerunBtn.hidden = !pending || !cur.app.last_run;
  introRerunBtn.title = manual != null ? `Mit Intro-Ende ${introMmss(manual)} neu berechnen` : "Mit automatisch erkanntem Intro neu berechnen";
  introAutoBtn.hidden = manual == null;
  introStatus.textContent = manual != null ? `von Hand auf ${introMmss(manual)} gesetzt${pending ? " (noch nicht berechnet)" : ""}` : r.intro_end != null ? `automatisch bei ${fmtDur(r.intro_end)}` : "automatisch (kein Intro erkannt)";

  const edited = isRouteEdited(normalizeEdit(r.reroute));
  const activeBits = [edited ? "Route angepasst" : null, manual != null ? `Intro ${introMmss(manual)}` : null].filter(Boolean);
  adjustSummary.textContent = activeBits.length ? activeBits.join(" · ") : "Route ziehen · Intro-Ende · Erweitert";
  const projKey = `${cur.app.id}:${r.sig}`;
  if (adjustForProject !== projKey) {
    adjustForProject = projKey;
    adjustDisc.open = needsCheck || activeBits.length > 0;
  }

  sigSum.textContent = `Signale (${st.length})`;
  sigDisc.hidden = !st.length;
  sigBody.replaceChildren(...st.map((s) => { const g = gloss(s); return statusRow(LEVEL_TONE[s.level], g.label, `${LEVEL_DE[s.level]} · ${g.text}`); }));
}

function renderTabs() {
  const sub = currentResultView();
  for (const v of RESULT_VIEWS) {
    const b = tabBtns[v];
    const active = v === sub;
    b.setAttribute("aria-selected", active ? "true" : "false");
    b.tabIndex = active ? 0 : -1;
    const x = b.querySelector<HTMLElement>(".res-tab-x")!;
    const st = v === "hoehe"
      ? (elevationBusy() ? "run" : E.state === "missing" || (E.dem && anythingMissing()) ? "warn" : profileCurrent() ? "done" : "")
      : v === "analyse"
        ? (analyseBusy() ? "run" : analyseReady() ? "done" : "")
        : "";
    if (x.dataset.state !== st) {
      x.dataset.state = st;
      x.replaceChildren(...(st === "run" ? [icon("spinner", "spin")] : st === "done" ? [icon("check")] : st === "warn" ? [icon("warning")] : []));
    }
  }
}

function chipsOf(r: ResultData): HTMLElement[] {
  const out = [/without decoy/i.test(r.verdict_basis) ? chip("ohne Täuschungstest", "", "Kein Test gegen Vergleichsstrecken: „sicher“ heißt sauberes Kalibrierungsmaximum und eindeutige Position.") : chip("mit Täuschungstest")];
  const h = r.project?.hints_used;
  if (h?.hint_file) out.push(h.route_hint_applied ? chip(`mit Streckenhinweis (${h.buffer_m} m)`, "hint") : chip("Streckenhinweis verworfen", "warn"));
  if (h && (h.start_bbox || h.end_bbox)) { const what = [h.start_bbox ? "Startrahmen" : null, h.end_bbox ? "Endrahmen" : null].filter(Boolean).join(" und "); out.push(h.frames_applied ? chip(`mit ${what}`, "hint") : chip(`${what} nicht anwendbar`, "warn")); }
  return out;
}

let raf = 0;
function drawSoon() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

function draw() {
  const r = S.result;
  if (!r || tl.closest(".ws")?.getAttribute("data-stage") !== "ergebnis" || currentResultView() !== "uebersicht") return;
  const pts = r.points, d = videoDuration() || pts.at(-1)!.t;
  const { profile, note } = rideState();
  const p = pointAt(pts, curT), cls = confClass(p);
  timeEl.textContent = `${fmtDur(curT)} / ${fmtDur(d)}`;
  track.setAttribute("aria-valuemax", String(Math.round(d)));
  track.setAttribute("aria-valuenow", String(Math.round(curT)));
  track.setAttribute("aria-valuetext", `${fmtDur(curT)} von ${fmtDur(d)}, Sicherheit ${CONF_DE[cls]}`);
  playBtn.disabled = !getPlayer();
  eleNote.hidden = !note || (!!profile && !note.extra);
  if (note && (!profile || note.extra)) {
    const msg = note.text === "Höhendaten fehlen" && note.bytes ? `Höhendaten fehlen (${fmtBytes(note.bytes)}).` : note.extra && note.bytes ? `${note.text} (ca. ${fmtBytes(note.bytes)}).` : note.text;
    eleNote.replaceChildren(
      el("span", { class: "row" }, toneIcon(note.busy ? "run" : note.extra ? "info" : "warn"), el("span", {}, msg)),
      !note.busy && S.cur ? btn("Höhendaten prüfen", () => go(routePath.project(S.cur!.app.id, "ergebnis", "hoehe")), { size: "sm", icon: "mountain" }) : "");
  }
  eleRange.textContent = profile ? `${Math.round(profile.min_m)}–${Math.round(profile.max_m)} m` : "";

  const rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.round(rect.width * dpr)), h = Math.max(10, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const c = canvas.getContext("2d")!;
  c.clearRect(0, 0, w, h);
  const stripH = Math.round(18 * dpr), gap = Math.round(6 * dpr), X = (t: number) => (t / d) * w;
  c.fillStyle = token("--c-surface-2", "#eee"); c.fillRect(0, 0, w, stripH);
  for (let x = 0; x < w; x += dpr) { const q = pointAt(pts, (x / w) * d); c.fillStyle = CONF_COLORS[confClass(q)]; c.fillRect(x, 0, dpr + 0.5, stripH); }
  const top = stripH + gap, bottom = h - 2 * dpr;
  c.fillStyle = token("--c-surface-2", "#eee"); c.fillRect(0, top, w, bottom - top);
  if (profile) {
    const zs: number[] = [];
    for (let x = 0; x <= w; x += 2 * dpr) { const q = pointAt(pts, (x / w) * d); zs.push(q.extrapolated || q.arc_m === undefined ? NaN : zAt(profile, q.arc_m)); }
    const fin = zs.filter(Number.isFinite);
    if (fin.length) {
      let lo = Math.min(...fin), hi = Math.max(...fin); if (hi - lo < 12) { const m = (hi + lo) / 2; lo = m - 6; hi = m + 6; }
      const Y = (z: number) => bottom - ((z - lo) / (hi - lo)) * (bottom - top - 4 * dpr);
      c.beginPath(); let pen = false;
      zs.forEach((z, i) => { const x = i * 2 * dpr; if (!Number.isFinite(z)) { pen = false; return; } if (!pen) { c.moveTo(x, Y(z)); pen = true; } else c.lineTo(x, Y(z)); });
      c.strokeStyle = token("--c-text-2", "#666"); c.lineWidth = 1.5 * dpr; c.stroke();
      c.lineTo(w, bottom); c.lineTo(0, bottom); c.closePath(); c.globalAlpha = 0.18; c.fillStyle = token("--c-accent", "#2563eb"); c.fill(); c.globalAlpha = 1;
    }
  }
  c.fillStyle = token("--c-text", "#111");
  c.fillRect(Math.round(X(curT) - dpr), 0, 2 * dpr, h);
}
