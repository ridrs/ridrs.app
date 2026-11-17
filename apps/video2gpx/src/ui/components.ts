// Small UI building blocks: each returns an element and, where the content changes, functions that patch it.
import { copyText, el } from "../util";
import { icon, type IconName } from "./icons";

type Child = Node | string | null | undefined | false;
let seq = 0;
export const uid = (p: string) => `${p}-${++seq}`;

export interface BtnOpts { kind?: "primary" | "danger" | "ghost"; size?: "sm" | "lg"; icon?: IconName; title?: string; disabled?: boolean; attrs?: Record<string, any> }
export function btn(label: string, onclick: (e: MouseEvent) => void, o: BtnOpts = {}): HTMLButtonElement {
  return el("button", { type: "button", class: `btn${o.kind ? " " + o.kind : ""}${o.size ? " " + o.size : ""}`, title: o.title, disabled: !!o.disabled, onclick, ...(o.attrs ?? {}) }, o.icon ? icon(o.icon) : null, el("span", {}, label));
}
export function setBtnLabel(b: HTMLButtonElement, label: string) { const s = b.querySelector("span"); if (s && s.textContent !== label) s.textContent = label; }
export function iconBtn(name: IconName, label: string, onclick: (e: MouseEvent) => void, attrs: Record<string, any> = {}): HTMLButtonElement {
  return el("button", { type: "button", class: "icon-btn", "aria-label": label, title: label, onclick, ...attrs }, icon(name));
}

/** a button that cannot be used yet: stays focusable, says why (aria-describedby is set by the caller) */
export function setSoftDisabled(b: HTMLElement, off: boolean) {
  if (off) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled");
}
export const isSoftDisabled = (b: HTMLElement) => b.getAttribute("aria-disabled") === "true";

export type Tone = "ok" | "warn" | "bad" | "info" | "run" | "wait" | "off";
const TONE_ICON: Record<Tone, IconName> = { ok: "check", warn: "warning", bad: "cross", info: "info", run: "spinner", wait: "circle", off: "minus" };
export function toneIcon(t: Tone): HTMLElement { return el("span", { class: `tone tone-${t}` }, icon(TONE_ICON[t], t === "run" ? "spin" : "")); }
export function setToneIcon(holder: HTMLElement, t: Tone) {
  if (holder.dataset.tone === t) return;
  holder.dataset.tone = t; holder.className = `tone tone-${t}`; holder.replaceChildren(icon(TONE_ICON[t], t === "run" ? "spin" : ""));
}

/** icon + label + text; the level is in the icon shape and in the words, never in the colour alone */
export function statusRow(t: Tone, label: Child, text: Child, title?: string): HTMLElement {
  return el("div", { class: `status-row ${t}`, title }, toneIcon(t), el("span", { class: "lbl" }, label), el("span", { class: "txt" }, text));
}

export function banner(t: "info" | "warn" | "bad", ...children: Child[]): HTMLElement {
  return el("div", { class: `banner ${t}`, role: t === "bad" ? "alert" : undefined }, toneIcon(t), el("div", { class: "banner-body" }, ...children));
}

export function chip(text: string, cls = "", title?: string): HTMLElement { return el("span", { class: `chip ${cls}`, title }, text); }

export interface Progress { el: HTMLElement; set(pct: number | null, valueText?: string): void; setBuffer(pct: number | null): void }
/** determinate, indeterminate (pct null) and two-layer (buffer = the part that is available, fill = the part that is done) */
export function progressBar(label: string, cls = ""): Progress {
  const buffer = el("div", { class: "buffer", hidden: true });
  const fill = el("div", { class: "fill" });
  const bar = el("div", { class: `progress ${cls}`, role: "progressbar", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100" }, buffer, fill);
  return {
    el: bar,
    set(pct, valueText) {
      bar.classList.toggle("indeterminate", pct === null);
      if (pct === null) { bar.removeAttribute("aria-valuenow"); fill.style.width = ""; }
      else { const p = Math.max(0, Math.min(100, pct)); bar.setAttribute("aria-valuenow", String(Math.round(p))); fill.style.width = `${p}%`; }
      if (valueText) bar.setAttribute("aria-valuetext", valueText); else bar.removeAttribute("aria-valuetext");
    },
    setBuffer(pct) { buffer.hidden = pct === null; if (pct !== null) buffer.style.width = `${Math.max(0, Math.min(100, pct))}%`; },
  };
}

export interface StepRow { tone: Tone; text: string; pct?: number | null; buffer?: number | null }
export interface StepList { el: HTMLElement; set(i: number, r: StepRow): void }
/** ordered list of steps; several rows may run at the same time. horizontal: the compact variant of the export card */
export function stepList(labels: string[], horizontal = false): StepList {
  const rows = labels.map((l, i) => {
    const ic = toneIcon("wait");
    const txt = el("span", { class: "step-state" });
    const bar = progressBar(l, "thin");
    bar.el.hidden = true;
    const li = el("li", { class: "step wait" }, ic, el("span", { class: "step-n" }, String(i + 1)), el("span", { class: "step-name" }, l), txt, bar.el);
    return { li, ic, txt, bar, label: l };
  });
  return {
    el: el("ol", { class: `steps${horizontal ? " horizontal" : ""}` }, ...rows.map((r) => r.li)),
    set(i, r) {
      const row = rows[i];
      if (!row) return;
      row.li.className = `step ${r.tone}`;
      setToneIcon(row.ic, r.tone);
      if (row.txt.textContent !== r.text) row.txt.textContent = r.text;
      const show = r.tone === "run" && r.pct !== undefined;
      row.bar.el.hidden = !show;
      if (show) { row.bar.set(r.pct ?? null, r.pct === null || r.pct === undefined ? undefined : `${row.label}, ${Math.round(r.pct)} Prozent`); row.bar.setBuffer(r.buffer ?? null); }
    },
  };
}

export interface Segmented<T extends string> { el: HTMLElement; set(v: T): void; setDisabled(b: boolean): void }
/** radio group drawn as one control; arrow keys come from the native radios */
export function segmented<T extends string>(label: string, options: readonly (readonly [T, string])[], value: T, onChange: (v: T) => void): Segmented<T> {
  const name = uid("seg");
  const inputs = options.map(([v, l]) => {
    const inp = el("input", { type: "radio", name, value: v, checked: v === value, onchange: () => onChange(v) });
    return { inp, lab: el("label", { class: "seg" }, inp, el("span", {}, l)) };
  });
  return {
    el: el("div", { class: "segmented", role: "radiogroup", "aria-label": label }, ...inputs.map((i) => i.lab)),
    set(v) { for (const i of inputs) i.inp.checked = i.inp.value === v; },
    setDisabled(b) { for (const i of inputs) i.inp.disabled = b; },
  };
}

export interface Field { el: HTMLElement; setError(msg: string | null): void; setHelp(msg: Child): void }
/** label + control + help + error; help and error are connected with aria-describedby */
export function field(label: string, control: HTMLElement, help?: Child, cls = ""): Field {
  const id = control.id || (control.id = uid("f"));
  const helpEl = el("div", { class: "help", id: `${id}-h`, hidden: !help }, help ?? "");
  const errEl = el("div", { class: "field-error", id: `${id}-e`, hidden: true });
  control.setAttribute("aria-describedby", `${id}-h ${id}-e`);
  return {
    el: el("div", { class: `field ${cls}` }, el("label", { for: id }, label), control, helpEl, errEl),
    setError(msg) { errEl.hidden = !msg; errEl.textContent = msg ?? ""; if (msg) control.setAttribute("aria-invalid", "true"); else control.removeAttribute("aria-invalid"); },
    setHelp(msg) { helpEl.hidden = !msg; helpEl.replaceChildren(msg || ""); },
  };
}

export function copyBtn(get: () => string, label = "Kopieren"): HTMLButtonElement {
  const b = btn(label, async () => {
    const ok = await copyText(get());
    setBtnLabel(b, ok ? "Kopiert" : "Nicht möglich");
    setTimeout(() => setBtnLabel(b, label), 1600);
  }, { size: "sm", icon: "copy" });
  return b;
}

/** monospace text in a well, with a copy button; {input} and {out} are marked when `marks` is set */
export function codeWell(text: string, opts: { marks?: boolean; copy?: boolean; label?: string } = {}): { el: HTMLElement; set(t: string): void } {
  const code = el("code", { class: "mono" });
  let cur = "";
  const set = (t: string) => {
    cur = t;
    if (!opts.marks) { code.textContent = t; return; }
    code.replaceChildren(...t.split(/(\{input\}|\{out\})/).filter(Boolean).map((p) => (p === "{input}" || p === "{out}" ? el("span", { class: "ph" }, p) : p)));
  };
  set(text);
  return { el: el("div", { class: "well", role: "group", "aria-label": opts.label ?? "Befehl" }, code, opts.copy === false ? null : copyBtn(() => cur)), set };
}

export function disclosure(summary: Child, ...body: Child[]): HTMLDetailsElement {
  return el("details", { class: "disc" }, el("summary", {}, icon("chevron"), el("span", {}, summary)), el("div", { class: "disc-body" }, ...body));
}

export function emptyState(ic: IconName, heading: string, text: Child, ...actions: Child[]): HTMLElement {
  return el("div", { class: "empty" }, icon(ic, "big"), el("div", { class: "empty-h" }, heading), text ? el("div", { class: "muted" }, text) : null, actions.length ? el("div", { class: "row center wrap" }, ...actions) : null);
}

/** the "⋯" menu: a button that opens a list of actions; arrow keys move, Escape closes and returns the focus */
export function menu(label: string, items: { label: string; icon?: IconName; danger?: boolean; onclick: () => void }[]): HTMLElement {
  const list = el("div", { class: "menu", role: "menu", hidden: true });
  const close = (focus = true) => { list.hidden = true; trigger.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside); if (focus) trigger.focus(); };
  const outside = (e: Event) => { if (!wrap.contains(e.target as Node)) close(false); };
  const open = () => { list.hidden = false; trigger.setAttribute("aria-expanded", "true"); document.addEventListener("pointerdown", outside); (list.firstElementChild as HTMLElement | null)?.focus(); };
  const trigger = iconBtn("more", label, () => (list.hidden ? open() : close()), { "aria-haspopup": "menu", "aria-expanded": "false" });
  for (const it of items) list.append(el("button", { type: "button", role: "menuitem", class: `menu-item${it.danger ? " danger" : ""}`, tabIndex: -1, onclick: () => { close(); it.onclick(); } }, it.icon ? icon(it.icon) : null, it.label));
  list.addEventListener("keydown", (e) => {
    const els = Array.from(list.children) as HTMLElement[], i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); els[(i + 1) % els.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); els[(i - 1 + els.length) % els.length].focus(); }
    else if (e.key === "Escape") { e.stopPropagation(); close(); }
    else if (e.key === "Tab") close(false);
  });
  const wrap = el("div", { class: "menu-wrap" }, trigger, list);
  return wrap;
}

// one polite live region for the whole app (step changes, end of a run); set by the shell
let live: HTMLElement | null = null;
export function liveRegion(): HTMLElement { return (live ??= el("div", { class: "sr-only", "aria-live": "polite", role: "status" })); }
export function announce(text: string) { if (live && live.textContent !== text) live.textContent = text; }
