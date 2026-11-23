// Berechnung: clear overall progress, parallel step list, download row when waiting for import, smart error recovery, signals card.
import { api } from "../api";
import { go, routePath } from "../app/router";
import { LEVEL_DE, LEVEL_TONE, VEHICLE_DE, gloss } from "../features/gloss";
import { active, canResume, cancel, start } from "../features/run";
import { STEPS, S, bus, effectivePbf, finishedSteps, overallPct, runningSteps } from "../state";
import type { StepId } from "../types";
import { announce, btn, copyBtn, progressBar, setToneIcon, statusRow, stepList, toneIcon, type Tone } from "../ui/components";
import { icon } from "../ui/icons";
import { el, fmtBytes, fmtDur, fmtEta, fmtSize } from "../util";
import { openMapData } from "./maps";

const DEPS: Partial<Record<StepId, number[]>> = { route_search: [1, 2, 3], plausibility: [4], refine: [4], gpx: [6] };

let root: HTMLElement, info: HTMLElement;
let head: HTMLElement, pctPill: HTMLElement, eta: HTMLElement, overall: ReturnType<typeof progressBar>, cancelBtn: HTMLButtonElement;
let inputRow: HTMLElement, inputIcon: HTMLElement, inputText: HTMLElement, inputBar: ReturnType<typeof progressBar>;
let steps: ReturnType<typeof stepList>, endBox: HTMLElement, logDisc: HTMLDetailsElement, logSum: HTMLElement, logPre: HTMLElement;
let params: HTMLElement, signals: HTMLElement;
let lastAnnounce = "";

export function mountRun(mainEl: HTMLElement, infoEl: HTMLElement) {
  root = el("div", { class: "run-view panel" }); info = infoEl;
  head = el("h2", { class: "run-h" });
  pctPill = el("span", { class: "chip accent tnum", hidden: true });
  eta = el("span", { class: "small muted tnum" });
  overall = progressBar("Gesamtfortschritt der Berechnung", "lg");
  cancelBtn = btn("Abbrechen", () => void cancel(), { kind: "danger" });
  inputIcon = toneIcon("run");
  inputText = el("span", { class: "step-state" });
  inputBar = progressBar("Video laden", "thin");
  inputRow = el("div", { class: "step run input-row", hidden: true }, inputIcon, el("span", { class: "step-n" }), el("span", { class: "step-name" }, "Video laden"), inputText, inputBar.el);
  steps = stepList(STEPS.map((s) => s.label));
  endBox = el("div", { class: "stack" });
  logSum = el("span", {});
  logPre = el("pre", { class: "logbox mono", tabIndex: 0, "aria-label": "Protokoll der Berechnung" });
  logDisc = el("details", { class: "disc" }, el("summary", {}, icon("chevron"), logSum),
    el("div", { class: "disc-body stack" }, logPre, el("div", { class: "row wrap" }, copyBtn(() => logText(), "Protokoll kopieren"), btn("Projektordner zeigen", () => void api.reveal(S.cur?.dir ?? ""), { size: "sm", icon: "folder" }))));
  root.append(
    el("div", { class: "run-top" },
      el("div", { class: "row between wrap" }, el("div", { class: "row wrap" }, head, pctPill), el("div", { class: "row" }, eta, cancelBtn)),
      overall.el),
    el("div", { class: "steps-wrap" }, inputRow, steps.el), endBox, logDisc);
  mainEl.append(root);
  params = el("dl", { class: "facts small" });
  signals = el("div", { class: "signals" });
  info.append(el("h2", { class: "label" }, "Laufparameter"), params, el("h2", { class: "label" }, "Signale"), signals);
  for (const ev of ["run", "runtick", "result", "project", "import"]) bus.on(ev, schedule);
  bus.on("stage", (s: string | null) => { root.hidden = s !== "berechnung"; if (s === "berechnung") update(); });
}

let pending = false;
function schedule() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; update(); }); }
const logText = () => S.run.logs.map((l) => (l.level === "info" ? "" : `[${l.level}] `) + l.message).join("\n");

function stepRow(i: number): { tone: Tone; text: string; pct?: number | null; buffer?: number | null } {
  const r = S.run, id = STEPS[i].id, s = r.steps[id];
  switch (s.state) {
    case "running":
      if (s.waiting) return { tone: "run", text: `wartet auf den Download${r.input?.pct != null ? ` (${Math.round(r.input.pct)} % geladen)` : ""}`, pct: s.pct, buffer: r.input?.pct ?? null };
      return { tone: "run", text: [`${Math.round(s.pct)} %`, s.eta !== undefined ? fmtEta(s.eta) : null, id === "motion" && r.input?.state === "growing" ? "läuft schon während des Downloads" : null].filter(Boolean).join(" · "), pct: s.pct, buffer: id === "motion" && r.input?.state === "growing" ? r.input.pct : null };
    case "done": return { tone: "ok", text: s.seconds ? `fertig · ${fmtDur(s.seconds)}` : "fertig" };
    case "skipped": return s.reused ? { tone: "ok", text: "übernommen aus dem letzten Lauf" } : { tone: "off", text: "ausgeschaltet" };
    case "failed": return { tone: "bad", text: "fehlgeschlagen" };
    default: {
      const open = (DEPS[id] ?? []).filter((n) => !["done", "skipped"].includes(r.steps[STEPS[n - 1].id].state));
      return { tone: "wait", text: r.running && open.length ? `wartet auf ${open.length > 1 ? open.slice(0, -1).join(", ") + " und " + open.at(-1) : open[0]}` : "wartet" };
    }
  }
}

function update() {
  const cur = S.cur, r = S.run;
  if (!cur || root.hidden) return;
  const runningHere = active.project === cur.app.id && r.running;
  const waitingForVideo = runningHere && !!r.input && r.input.state === "growing" && !runningSteps(r).length && finishedSteps(r) === 0;
  const done = finishedSteps(r);
  const failed = !!r.exit && r.exit.code !== 0 && !r.exit.cancelled && r.exit.code !== 130;
  const cancelled = !!r.exit && (r.exit.cancelled || r.exit.code === 130);
  const title = runningHere ? (waitingForVideo ? "Wartet auf das Video" : runningSteps(r).length || done ? "Berechnung läuft" : "Berechnung startet …")
    : r.exit?.code === 0 || S.result ? "Berechnung fertig" : cancelled ? `Abgebrochen nach ${done} von 7 Schritten` : failed ? "Berechnung fehlgeschlagen" : r.started ? "Berechnung" : "Noch keine Berechnung";
  if (head.textContent !== title) head.textContent = title;
  const pct = r.exit?.code === 0 ? 100 : overallPct(r);
  pctPill.hidden = waitingForVideo || !r.started;
  pctPill.textContent = `${Math.round(pct)} %`;
  overall.set(waitingForVideo ? null : pct, `${Math.round(pct)} Prozent`);
  const etas = runningSteps(r).map((id) => r.steps[id].eta).filter((x): x is number => x !== undefined);
  eta.textContent = runningHere ? (r.progress?.eta !== undefined ? fmtEta(r.progress.eta) : etas.length ? fmtEta(Math.max(...etas)) : "") : "";

  const focusHere = document.activeElement === cancelBtn || endBox.contains(document.activeElement);
  cancelBtn.hidden = !runningHere;

  const inp = r.input;
  inputRow.hidden = !inp;
  if (inp) {
    const complete = inp.state === "complete";
    inputRow.className = `step ${complete ? "ok" : "run"} input-row`;
    setToneIcon(inputIcon, complete ? "ok" : "run");
    inputText.textContent = complete ? "Video geladen" : [inp.pct != null ? `${Math.round(inp.pct)} %` : null, inp.total ? `${fmtBytes(inp.bytes)} von ${fmtBytes(inp.total)}` : `${fmtBytes(inp.bytes)} geladen`].filter(Boolean).join(" · ");
    inputBar.el.hidden = complete;
    inputBar.set(inp.pct, inp.pct != null ? `Video laden, ${Math.round(inp.pct)} Prozent` : undefined);
  }
  STEPS.forEach((_, i) => steps.set(i, stepRow(i)));

  const endKey = JSON.stringify([waitingForVideo, runningHere, failed, cancelled, r.error ?? null, r.exit?.code ?? null, r.started, canResume(), !!S.result]);
  if (endBox.dataset.key !== endKey) {
    endBox.dataset.key = endKey;
    endBox.replaceChildren();
    if (waitingForVideo) endBox.append(el("p", { class: "banner info" }, toneIcon("info"), el("span", {}, "Die Berechnung startet, sobald das Video geladen ist.")));
    if (!runningHere && (failed || cancelled || (r.error && r.exit?.code !== 0 && r.started))) {
      const code = r.exit?.code ?? null;
      const actions: HTMLElement[] = [];
      // Put the most helpful fix first: on OOM (3) shrink frame, on bad map (4) check maps, on cancel (130) resume
      if (code === 3) {
        actions.push(btn("Suchrahmen verkleinern", () => go(routePath.project(cur.app.id, "einrichten")), { kind: "primary" }));
        if (canResume()) actions.push(btn("Fortsetzen", () => void start(true)));
      } else if (code === 4) {
        actions.push(btn("Kartendaten prüfen", () => openMapData(false), { kind: "primary" }));
        if (canResume()) actions.push(btn("Fortsetzen", () => void start(true)));
      } else {
        if (canResume()) actions.push(btn("Fortsetzen", () => void start(true), { kind: "primary" }));
        if (code === 2) actions.push(btn("Video und Karte prüfen", () => go(routePath.project(cur.app.id, "einrichten")), { kind: canResume() ? undefined : "primary" }));
      }
      actions.push(btn("Zurück zu Einrichten", () => go(routePath.project(cur.app.id, "einrichten"))));
      endBox.append(el("div", { class: `banner ${cancelled ? "info" : "bad"}`, role: cancelled ? "status" : "alert" }, toneIcon(cancelled ? "info" : "bad"),
        el("div", { class: "banner-body" }, el("div", {}, r.error ?? (cancelled ? "Abgebrochen." : "Die Berechnung ist fehlgeschlagen.")), el("div", { class: "row wrap" }, ...actions))));
      if (failed && !logDisc.dataset.auto) { logDisc.open = true; logDisc.dataset.auto = "1"; }
    } else delete logDisc.dataset.auto;
    if (!runningHere && S.result) endBox.append(el("div", { class: "row" }, btn("Zum Ergebnis", () => go(routePath.project(cur.app.id, "ergebnis")), { kind: "primary", icon: "chevron" })));
    if (focusHere || document.activeElement === document.body) endBox.querySelector<HTMLButtonElement>("button")?.focus();
  }

  logSum.textContent = `Protokoll (${r.logs.length})`;
  const t = r.logs.slice(-300).map((l) => (l.level === "info" ? "" : `[${l.level}] `) + l.message).join("\n") || "(noch keine Meldungen)";
  if (logPre.textContent !== t) { const end = logPre.scrollTop + logPre.clientHeight >= logPre.scrollHeight - 4; logPre.textContent = t; if (end) logPre.scrollTop = logPre.scrollHeight; }

  const runIds = runningSteps(r);
  const msg = runningHere ? (runIds.length ? `Schritt ${STEPS.findIndex((s) => s.id === runIds[runIds.length - 1]) + 1} von 7: ${runIds.map((id) => STEPS.find((s) => s.id === id)!.label).join(", ")}` : waitingForVideo ? "Wartet auf das Video" : "") : title;
  if (msg && msg !== lastAnnounce) { lastAnnounce = msg; announce(msg); }
  renderInfo();
}

function renderInfo() {
  const app = S.cur!.app, lr = S.run.running ? app.last_run : null;
  const bbox = lr?.bbox ?? S.bbox, pbf = lr ? lr.pbf.split("/").pop() : effectivePbf(S.bbox)?.name;
  const hints = [(lr ? lr.start_bbox : S.startFrame) ? "Startrahmen" : null, (lr ? lr.end_bbox : S.endFrame) ? "Endrahmen" : null, (lr ? lr.hint : app.hint) ? "Streckenhinweis" : null, (lr ? lr.anchors : app.anchors)?.length ? `${(lr ? lr.anchors : app.anchors)!.length} Ortsangaben` : null].filter(Boolean);
  const pairs: [string, string][] = [["Suchrahmen", bbox ? fmtSize(bbox) : "–"], ["Karte", pbf ?? "–"], ["Fahrzeug", VEHICLE_DE[lr?.vehicle ?? app.vehicle ?? "auto"]], ["Hinweise", hints.length ? hints.join(", ") : "keine"]];
  const sig = JSON.stringify(pairs);
  if (params.dataset.sig !== sig) { params.dataset.sig = sig; params.replaceChildren(...pairs.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])); }
  const st = S.run.statuses;
  const ssig = JSON.stringify(st.map((s) => [s.key, s.level, s.value]));
  if (signals.dataset.sig === ssig) return;
  signals.dataset.sig = ssig;
  signals.replaceChildren(...(st.length ? st.map((s) => { const g = gloss(s); return statusRow(LEVEL_TONE[s.level], g.label, `${LEVEL_DE[s.level]} · ${g.text}`); }) : [el("p", { class: "muted small" }, "Die Signale erscheinen, sobald die Schritte sie melden.")]));
}
