// The frame of the app: global bar, 4-step workflow bar, views, toasts, live region.
import { profileCurrent } from "../elevation";
import { imp, importPct } from "../features/import";
import { active, activeName, toolsReady } from "../features/run";
import { S, bus, finishedSteps, overallPct, runningSteps, type RunState } from "../state";
import { announce, liveRegion } from "../ui/components";
import { icon } from "../ui/icons";
import { $, el } from "../util";
import { closeProject, openProject, projectTitle } from "./project";
import { STAGES, currentRoute, go, routePath, type ResultView, type Route, type Stage } from "./router";

/** a run started during an import that has not begun yet: no percentage to show */
const waitsForVideo = (r: RunState) => r.input?.state === "growing" && !runningSteps(r).length && finishedSteps(r) === 0;

export const STAGE_LABEL: Record<Stage, string> = { einrichten: "Einrichten", berechnung: "Berechnung", ergebnis: "Ergebnis", export: "Export" };
export const RESULT_VIEW_LABEL: Record<ResultView, string> = { uebersicht: "Übersicht", hoehe: "Höhe", analyse: "Analyse" };
const VIEW_TITLE = { start: "Start", tools: "Werkzeuge", maps: "Kartendaten", settings: "Einstellungen", selfcheck: "Selbsttest" } as const;
type PlainView = keyof typeof VIEW_TITLE;

export interface Regions {
  views: Record<PlainView, HTMLElement>;
  ws: HTMLElement; head: HTMLElement; map: HTMLElement; video: HTMLElement; side: HTMLElement; main: HTMLElement; info: HTMLElement; timeline: HTMLElement;
}
let R: Regions;
let mainEl: HTMLElement, titleEl: HTMLElement, stageNav: HTMLElement, stageH1: HTMLElement, toolsLink: HTMLElement, runChip: HTMLAnchorElement, impChip: HTMLAnchorElement, devBadge: HTMLElement;
const stageLinks = {} as Record<Stage, HTMLAnchorElement>;
const shown: Partial<Record<PlainView, () => void>> = {};
/** called when a plain view becomes visible */
export function onShow(v: PlainView, f: () => void) { shown[v] = f; }

export function buildShell(): Regions {
  const view = (name: string) => el("div", { class: `view view-${name}`, hidden: true });
  const views = { start: view("start"), tools: view("tools"), maps: view("maps"), settings: view("settings"), selfcheck: view("selfcheck") };
  const reg = (tag: "section" | "aside" | "div", cls: string, label?: string) => el(tag, { class: cls, "aria-label": label });
  stageH1 = el("h1", { class: "sr-only ws-h1" }, "Einrichten");
  R = {
    views, ws: el("div", { class: "view ws", hidden: true }),
    head: reg("div", "ws-head"), map: reg("section", "ws-map panel", "Karte"), video: reg("section", "ws-video panel", "Video"), side: reg("aside", "ws-side panel", "Einrichten"),
    main: reg("div", "ws-main"), info: reg("aside", "ws-info panel", "Angaben zur Berechnung"), timeline: reg("section", "ws-timeline", "Zeitleiste und Anpassung"),
  };
  R.ws.append(stageH1, R.head, R.map, R.video, R.side, R.main, R.info, R.timeline);

  titleEl = el("span", { class: "bar-title" });
  devBadge = el("span", { class: "chip dev", hidden: true, title: "Die Berechnung läuft mit dem externen Python der Entwicklungsumgebung, nicht mit der eingebauten Pipeline (Einstellungen)." }, "Entwicklermodus");
  runChip = el("a", { class: "activity", hidden: true });
  impChip = el("a", { class: "activity", hidden: true });
  toolsLink = el("a", { href: routePath.tools, class: "bar-link" }, icon("wrench"), el("span", {}, "Werkzeuge"), el("span", { class: "dot", hidden: true }), el("span", { class: "sr-only miss", hidden: true }, " (ein Programm fehlt)"));
  const bar = el("header", { class: "bar" },
    el("a", { class: "brand", href: routePath.start }, "video2gpx"), titleEl, devBadge, el("div", { class: "spacer" }), impChip, runChip,
    el("nav", { class: "bar-nav", "aria-label": "Bereiche" },
      el("a", { href: routePath.maps, class: "bar-link" }, icon("map"), el("span", {}, "Kartendaten")), toolsLink,
      el("a", { href: routePath.settings, class: "bar-link" }, icon("settings"), el("span", {}, "Einstellungen"))));

  // 4-step workflow bar (Ergebnis holds Übersicht, Höhe and Analyse views)
  const ol = el("ol", { class: "stage-steps" });
  STAGES.forEach((s, i) => {
    stageLinks[s] = el("a", { class: "stage-link" }, el("span", { class: "stage-n" }, String(i + 1)), el("span", { class: "stage-l" }, STAGE_LABEL[s]), el("span", { class: "stage-x" }));
    stageLinks[s].addEventListener("click", (e) => { if (stageLinks[s].getAttribute("aria-disabled") === "true") e.preventDefault(); });
    ol.append(el("li", {}, stageLinks[s]));
  });

  stageNav = el("nav", { class: "stagebar", "aria-label": "Arbeitsschritte", hidden: true }, ol);
  mainEl = el("main", { id: "main", tabIndex: -1 }, ...Object.values(views), R.ws);
  $("#app").append(el("a", { class: "skip", href: "#main", onclick: (e: Event) => { e.preventDefault(); mainEl.focus(); } }, "Zum Inhalt"), bar, stageNav, mainEl, el("div", { id: "toasts" }), liveRegion());

  bus.on("toast", toast);
  for (const ev of ["run", "runtick", "import", "env", "result", "projects", "video", "import-title", "elevation", "analyse"]) bus.on(ev, updateBar);
  bus.on("run-finished", (project: string) => {
    const r = currentRoute();
    announce(`Berechnung fertig: ${S.result ? ({ confident: "Route gefunden", uncertain: "Route unsicher", no_route: "keine verlässliche Route" })[S.result.verdict] : ""}`);
    if (r.view === "project" && r.id === project && r.stage === "berechnung") go(routePath.project(project, "ergebnis"));
    else updateBar();
  });
  document.addEventListener("keydown", shortcuts);
  return R;
}

export function stageAvailable(s: Stage): boolean {
  if (s === "einrichten") return true;
  if (s === "berechnung") return S.run.started || S.run.running || active.project === S.cur?.app.id;
  return !!S.result;
}
export const defaultStage = (): Stage => (S.run.running ? "berechnung" : S.result ? "ergebnis" : S.run.started && S.run.exit && S.run.exit.code !== 0 ? "berechnung" : "einrichten");
export const currentStage = (): Stage | null => (R.ws.hidden ? null : (R.ws.dataset.stage as Stage));
export const currentResultView = (): ResultView => (R.ws.dataset.sub as ResultView) || "uebersicht";

let first = true, routeToken = 0;
/** stages of the open project that were shown (for the check mark of Ergebnis) */
const visited = new Set<string>();
export async function onRoute(r: Route) {
  const token = ++routeToken;
  const prevStage = currentStage();
  const prevProject = S.cur?.app.id ?? null;
  if (r.view === "project") {
    const ok = await openProject(r.id);
    if (token !== routeToken) return;
    if (!ok) { go(routePath.start, true); return; }
    const stage = r.stage && stageAvailable(r.stage) ? r.stage : defaultStage();
    const sub: ResultView | undefined = stage === "ergebnis" ? (r.sub ?? "uebersicht") : undefined;
    if (stage !== r.stage) { go(routePath.project(r.id, stage, sub), true); return; }
    const sameErgebnis = prevProject === r.id && prevStage === "ergebnis" && stage === "ergebnis";
    for (const v of Object.values(R.views)) v.hidden = true;
    R.ws.hidden = false; R.ws.dataset.stage = stage;
    if (sub) R.ws.dataset.sub = sub; else delete R.ws.dataset.sub;
    visited.add(`${r.id}/${stage}`);
    stageH1.textContent = `${STAGE_LABEL[stage]}: ${projectTitle(S.cur!.app)}`;
    stageH1.hidden = stage === "ergebnis";
    const subSuffix = sub && sub !== "uebersicht" ? ` (${RESULT_VIEW_LABEL[sub]})` : "";
    document.title = `${STAGE_LABEL[stage]}${subSuffix}: ${projectTitle(S.cur!.app)} – video2gpx`;
    updateBar();
    bus.emit("stage", stage, sub ?? null);
    if (!sameErgebnis) {
      window.scrollTo(0, 0);
      if (!first) {
        if (stage === "ergebnis") R.head.querySelector<HTMLElement>("h1")?.focus();
        else mainEl.focus({ preventScroll: true });
      }
    }
  } else {
    R.ws.hidden = true; delete R.ws.dataset.stage; delete R.ws.dataset.sub;
    if (S.cur) closeProject();
    for (const [k, v] of Object.entries(R.views)) v.hidden = k !== r.view;
    document.title = `${VIEW_TITLE[r.view]} – video2gpx`;
    updateBar();
    bus.emit("stage", null, null);
    shown[r.view]?.();
    window.scrollTo(0, 0);
    if (r.view !== "start") mainEl.focus({ preventScroll: true });
  }
  first = false;
}

function updateBar() {
  const cur = S.cur, inProject = !R.ws.hidden && !!cur;
  titleEl.textContent = inProject ? projectTitle(cur!.app) : "";
  titleEl.hidden = !inProject;
  stageNav.hidden = !inProject;
  devBadge.hidden = !(S.settings?.dev_mode ?? S.env?.dev_mode);
  const miss = !!S.env && !toolsReady(S.env);
  toolsLink.querySelector<HTMLElement>(".dot")!.hidden = !miss;
  toolsLink.querySelector<HTMLElement>(".miss")!.hidden = !miss;
  const route = currentRoute();
  document.querySelectorAll<HTMLAnchorElement>(".bar-link").forEach((a) => { if (a.getAttribute("href") === (location.hash || "#/")) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (inProject) {
    const stage = R.ws.dataset.stage as Stage;
    for (const s of STAGES) {
      const a = stageLinks[s], ok = stageAvailable(s);
      a.href = routePath.project(cur!.app.id, s);
      if (ok) { a.removeAttribute("aria-disabled"); a.removeAttribute("title"); a.tabIndex = 0; } else { a.setAttribute("aria-disabled", "true"); a.title = "Erst nach der Berechnung"; }
      if (s === stage) a.setAttribute("aria-current", "step"); else a.removeAttribute("aria-current");
      const x = a.querySelector<HTMLElement>(".stage-x")!;
      const state = stageState(s, cur!.app.id);
      if (x.dataset.state !== state) {
        x.dataset.state = state;
        x.replaceChildren(...(state === "run" ? [icon("spinner", "spin")] : state === "done" ? [icon("check")] : state === "warn" ? [icon("warning")] : []));
      }
      const pct = s === "berechnung" && state === "run" && !waitsForVideo(S.run) ? ` ${Math.round(overallPct(S.run))} %` : "";
      const t = x.querySelector(".pct") ?? x.appendChild(el("span", { class: "pct" }));
      if (t.textContent !== pct) t.textContent = pct;
    }
  }
  const rs = active.state;
  runChip.hidden = !active.project || (route.view === "project" && route.id === active.project && route.stage === "berechnung");
  if (active.project) { runChip.href = routePath.project(active.project, "berechnung"); setChip(runChip, rs && waitsForVideo(rs) ? "Berechnung wartet auf das Video" : `Berechnung ${rs ? Math.round(overallPct(rs)) + " %" : "läuft"}`, `Berechnung läuft: ${activeName()}`); }
  impChip.hidden = !imp.running || !imp.project || (route.view === "project" && route.id === imp.project && route.stage === "einrichten");
  if (imp.running && imp.project) { const p = importPct(); impChip.href = routePath.project(imp.project, "einrichten"); setChip(impChip, `Video lädt${p !== null ? ` ${Math.round(p)} %` : ""}`, "Zum Import"); }
}

/** the mark in the stage bar: a spinner while working, a check when done */
function stageState(s: Stage, project: string): "run" | "done" | "warn" | "" {
  switch (s) {
    case "einrichten": return S.run.started || !!S.result ? "done" : "";
    case "berechnung": return S.run.running ? "run" : S.result ? "done" : "";
    case "ergebnis": return S.result && (visited.has(`${project}/ergebnis`) || profileCurrent()) ? "done" : "";
    default: return "";
  }
}
function setChip(a: HTMLAnchorElement, text: string, title: string) {
  if (!a.firstChild) a.append(icon("spinner", "spin"), el("span", {}));
  const s = a.querySelector("span")!;
  if (s.textContent !== text) s.textContent = text;
  a.title = title;
}

function toast(msg: string, kind: "info" | "error" = "info") {
  const t = el("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, el("span", {}, msg), el("button", { type: "button", class: "icon-btn", "aria-label": "Meldung schließen", onclick: () => t.remove() }, icon("cross")));
  $("#toasts").append(t);
  setTimeout(() => t.remove(), kind === "error" ? 12000 : 6000);
}

function shortcuts(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || document.querySelector("dialog[open]")) return;
  if (e.key === ",") { e.preventDefault(); go(routePath.settings); }
  else if (e.key === "o" || e.key === "O") { e.preventDefault(); bus.emit("pick-video"); }
  else if (e.key === "Enter") {
    const b = Array.from(mainEl.querySelectorAll<HTMLElement>("[data-primary]")).find((x) => x.offsetParent !== null);
    if (b) { e.preventDefault(); b.click(); }
  }
}
