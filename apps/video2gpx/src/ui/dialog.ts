// Modal dialogs (<dialog>): labelled by their heading, Escape closes, focus returns to the opener.
import { el } from "../util";
import { icon } from "./icons";

let seq = 0;
export interface DialogHandle { dlg: HTMLDialogElement; body: HTMLElement; close: () => void }

export function openDialog(title: string, content: HTMLElement, opts: { wide?: boolean; onClose?: () => void } = {}): DialogHandle {
  document.querySelectorAll("dialog").forEach((d) => (d as HTMLDialogElement).close());
  const opener = document.activeElement as HTMLElement | null;
  const id = `dlg-${++seq}`;
  const dlg = el("dialog", { class: opts.wide ? "wide" : "", "aria-labelledby": id });
  const close = () => dlg.close();
  const body = el("div", { class: "dlg-body" }, content);
  dlg.append(el("div", { class: "dlg-head" }, el("h2", { id }, title), el("button", { class: "icon-btn", type: "button", "aria-label": "Schließen", onclick: close }, icon("cross"))), body);
  dlg.addEventListener("close", () => { dlg.remove(); opts.onClose?.(); if (opener?.isConnected) opener.focus(); });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, body, close };
}

/** A confirmation inside the web view (the native ask() of Tauri stays in api.confirm for destructive actions). */
export function infoDialog(title: string, ...content: (Node | string)[]) {
  return openDialog(title, el("div", { class: "stack" }, ...content));
}
