// "ridrs Scenic": the card of the Export stage for a project made from a ridrs Scenic job (docs/FEATURE_atlas.md). The checklist of
// src/atlas.ts (every blocking item green or overridden with a note), then "Für ridrs Scenic speichern …" writes <id>.scenic.json, which the
// atlas admin uploads ("video2gpx-Ergebnis hochladen"). The state of the list is kept in app.json (atlas.qc).
import { api } from "../api";
import { revealLabel } from "../app/platform";
import { routePath } from "../app/router";
import { buildPayload, freshQc, payloadName, qcChecks, qcFor, qcReady, type AtlasCheckId, type AtlasQcState, type QcItem } from "../atlas";
import { E, profileCurrent } from "../elevation";
import { zAt } from "../ridePanel";
import { S, saveCur, toast } from "../state";
import { banner, btn, copyBtn, field, toneIcon } from "../ui/components";
import { debounce, el } from "../util";

const fmt = (s: number | null) => { if (s == null) return ""; const m = Math.floor(s / 60), x = Math.round(s % 60); return `${m}:${String(x).padStart(2, "0")}`; };
/** "m:ss", "h:mm:ss" or seconds */
const parseT = (v: string): number | null => { const p = v.trim().replace(",", ".").split(":").map(Number); if (!v.trim() || p.some((x) => !Number.isFinite(x))) return null; return p.reduce((a, x) => a * 60 + x, 0); };

export function atlasCard(): { el: HTMLElement; build(): void } {
  const root = el("section", { class: "panel stack card", "aria-labelledby": "atlas-h", hidden: true });
  let list: HTMLUListElement, saveBtn: HTMLButtonElement, res: HTMLElement, t0In: HTMLInputElement, t1In: HTMLInputElement, note: HTMLTextAreaElement;
  const persist = debounce(() => void saveCur({}), 400);

  const state = (): AtlasQcState | null => {
    const a = S.cur?.app.atlas, r = S.result;
    if (!a || !r) return null;
    const qc = qcFor(a.qc, r.sig, r.points, r.intro_end);
    if (qc !== a.qc) { a.qc = qc; persist(); }
    return qc;
  };
  const items = (): QcItem[] => {
    const r = S.result!, st = state()!, a = S.cur!.app.atlas!;
    return qcChecks({ verdict: r.verdict, points: r.points, standstills: r.standstills, cutTimes: r.cut_times, hintLines: S.hint?.lines ?? null, hasRoute: !!a.job.route_gpx, state: st });
  };

  function row(it: QcItem, st: AtlasQcState): HTMLElement {
    const tone = it.ok ? "ok" : it.overridden ? "warn" : it.blocking ? "bad" : "warn";
    const body: (Node | string | null)[] = [el("div", { class: "row wrap" }, toneIcon(tone), el("b", {}, it.label), el("span", { class: "small muted" }, it.detail))];
    if (it.id === "cuts") {
      const pieces = (it.value as { times: number[] }).times;
      if (pieces.length) {
        const edges = [st.t_start!, ...pieces, st.t_end!];
        body.push(el("div", { class: "stack-s" }, ...edges.slice(1).map((b, i) => {
          const a = edges[i];
          const cb = el("input", { type: "checkbox", checked: st.cuts_checked.includes(a), onchange: () => {
            st.cuts_checked = cb.checked ? [...new Set([...st.cuts_checked, a])] : st.cuts_checked.filter((x) => x !== a); persist(); render(); } });
          return el("label", { class: "check small" }, cb, ` Stück ${fmt(a)}–${fmt(b)} in der Analyse geprüft`);
        }), el("a", { class: "small", href: routePath.project(S.cur!.app.id, "analyse") }, "Zur Analyse")));
      }
    }
    if (it.id === "viewed") {
      const tick = (k: "start" | "turn" | "end", label: string) => {
        const cb = el("input", { type: "checkbox", checked: st.viewed[k], onchange: () => { st.viewed[k] = cb.checked; persist(); render(); } });
        return el("label", { class: "check small" }, cb, ` ${label}`);
      };
      body.push(el("div", { class: "row wrap" }, tick("start", "Anfang"), tick("turn", "eine Kehre oder Kreuzung"), tick("end", "Ende"),
        el("a", { class: "small", href: routePath.project(S.cur!.app.id, "ergebnis") }, "Zum Ergebnis")));
    }
    if (it.overridable && !it.ok) {
      const inp = el("input", { type: "text", value: st.overrides[it.id as AtlasCheckId] ?? "", placeholder: "Trotzdem senden, weil …", "aria-label": `${it.label}: Begründung zum Übergehen`,
        oninput: () => { st.overrides[it.id] = inp.value; persist(); renderSoon(); } });
      body.push(el("div", { class: "row wrap small" }, el("span", { class: "muted" }, "Übergehen mit Notiz:"), inp));
    }
    return el("li", { class: `check-item ${it.ok || it.overridden ? "ok" : "open"}`, "data-check": it.id }, el("div", { class: "stack-s grow" }, ...body));
  }

  function render() {
    const st = state();
    if (!st || !list) return;
    const its = items();
    // keep the focus on a text field while the list is rebuilt
    const f = document.activeElement as HTMLInputElement | null, fid = f && list.contains(f) ? f.closest("li")?.getAttribute("data-check") : null, pos = f?.selectionStart ?? null;
    list.replaceChildren(...its.map((it) => row(it, st)));
    if (fid) { const n = list.querySelector<HTMLInputElement>(`li[data-check="${fid}"] input[type=text]`); if (n) { n.focus(); if (pos != null) n.setSelectionRange(pos, pos); } }
    const ready = qcReady(its);
    saveBtn.disabled = !ready;
    saveBtn.title = ready ? "" : "Erst alle Punkte grün oder mit Notiz übergehen";
  }
  const renderSoon = debounce(render, 250);

  async function write() {
    const cur = S.cur, r = S.result, st = state();
    if (!cur?.app.atlas || !r || !st) return;
    const job = cur.app.atlas.job, its = items();
    try {
      const pj = r.project ?? {};
      const payload = buildPayload({ job, verdict: r.verdict, verdict_basis: r.verdict_basis, points: r.points, standstills: r.standstills, cutTimes: r.cut_times,
        pipeline_hash: String(pj.pipeline_hash ?? pj.code_hash ?? ""), vehicle: String(pj.effective?.vehicle ?? cur.app.vehicle ?? "auto"),
        offset_m: typeof pj.effective?.offset_m === "number" ? pj.effective.offset_m : null, app_version: await api.appVersion().catch(() => "unbekannt"),
        state: st, items: its, eleAt: profileCurrent() && E.profile ? (s: number) => zAt(E.profile!, s) : null });
      const dest = await api.pickSaveAtlas(payloadName(job));
      if (!dest) return;
      const w = await api.atlasResultWrite(dest, JSON.stringify(payload));
      cur.app.atlas.written = { path: w.path, at: Date.now() };
      await saveCur({});
      const admin = `${job.atlas.base}/admin/#v=${job.video_id}`;
      res.replaceChildren(el("div", { class: "ok-text" }, `Gespeichert: ${w.path} (${Math.round(w.bytes / 1024)} kB, ${payload.t.length} Punkte${payload.e ? ", mit Höhen" : ""}).`), " ",
        btn(revealLabel, () => void api.reveal(w.path), { size: "sm" }),
        el("p", { class: "help" }, "Im Admin von ridrs Scenic das Video öffnen und die Datei mit „video2gpx-Ergebnis hochladen“ hochladen: ", el("span", { class: "mono wrap-any" }, admin), " ", copyBtn(() => admin, "Adresse kopieren")));
    } catch (e) { toast(e instanceof Error ? e.message : String(e), "error"); }
  }

  function build() {
    const a = S.cur?.app.atlas, r = S.result;
    root.hidden = !a || !r;
    if (!a || !r) { root.replaceChildren(); return; }
    const st = state()!;
    const job = a.job;
    t0In = el("input", { type: "text", class: "narrow", value: fmt(st.t_start), "aria-label": "Erste Fahrsekunde", onchange: () => { st.t_start = parseT(t0In.value); persist(); render(); } });
    t1In = el("input", { type: "text", class: "narrow", value: fmt(st.t_end), "aria-label": "Letzte Fahrsekunde", onchange: () => { st.t_end = parseT(t1In.value); persist(); render(); } });
    const reset = btn("Aus dem Ergebnis", () => { const d = freshQc(r.points, r.intro_end); st.t_start = d.t_start; st.t_end = d.t_end; t0In.value = fmt(st.t_start); t1In.value = fmt(st.t_end); persist(); render(); }, { size: "sm" });
    note = el("textarea", { rows: 2, "aria-label": "Notiz für ridrs Scenic", oninput: () => { st.note = note.value; persist(); } });
    note.value = st.note;
    list = el("ul", { class: "checks", "aria-label": "Prüfliste für ridrs Scenic" });
    saveBtn = btn("Für ridrs Scenic speichern …", () => void write(), { kind: "primary", icon: "download" });
    res = el("div", { class: "small", "aria-live": "polite" });
    root.replaceChildren(el("h2", { id: "atlas-h" }, "ridrs Scenic"),
      el("p", { class: "small muted" }, `Für ${job.title ?? job.video_id} (${job.video_id}) in ridrs Scenic. Jeder Punkt muss grün sein oder mit einer Notiz übergangen werden; die Übereinstimmung mit der Scenic-Route ist nur ein Hinweis.`),
      ...(job.route_gpx ? [] : [banner("info", "ridrs Scenic hat für dieses Video keine Route: die Linie von video2gpx kann dort die erste werden.")]),
      el("div", { class: "row wrap end-align" }, field("Erste Fahrsekunde", t0In).el, field("Letzte Fahrsekunde", t1In).el, reset),
      list, field("Notiz für ridrs Scenic (optional)", note).el,
      el("div", { class: "row wrap" }, saveBtn), res);
    render();
  }

  return { el: root, build };
}
