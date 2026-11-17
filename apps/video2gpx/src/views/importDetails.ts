// The import of a video by a template: the block in the Einrichten side panel, and the details dialog (exact command, live output).
import { go, routePath } from "../app/router";
import { cancelImport, imp, importErrorText, importPct, retryImport } from "../features/import";
import { bus } from "../state";
import { banner, btn, codeWell, copyBtn, progressBar } from "../ui/components";
import { openDialog } from "../ui/dialog";
import { el, fmtBytes, fmtEta } from "../util";

const RESPONSIBILITY = "Die App lädt nichts von sich aus. Was der Befehl tut und ob du das Video verwenden darfst, liegt bei dir.";

export function openImportDetails() {
  const log = el("pre", { class: "logbox mono", tabIndex: 0, "aria-label": "Ausgabe des Befehls" });
  const text = () => imp.log.map((l) => (l.stream === "stderr" ? `[stderr] ${l.line}` : l.line)).join("\n");
  const fill = () => { log.textContent = text() || "(noch keine Ausgabe)"; log.scrollTop = log.scrollHeight; };
  const cmd = codeWell(imp.command || "…", { label: "Genau dieser Befehl wird ausgeführt" });
  const sync = () => { cmd.set(imp.command || "…"); fill(); };
  fill();
  bus.on("import-log", sync); bus.on("import", sync);
  openDialog("Import: Einzelheiten", el("div", { class: "stack" },
    el("div", { class: "label" }, "Genau dieser Befehl wird ausgeführt"), cmd.el,
    el("div", { class: "row between" }, el("div", { class: "label" }, "Ausgabe (stdout und stderr)"), copyBtn(text, "Ausgabe kopieren")), log,
    el("p", { class: "help" }, RESPONSIBILITY)), { wide: true, onClose: () => { bus.off("import-log", sync); bus.off("import", sync); } });
}

/** The video block of the side panel while an import runs or after it failed. update() patches it. */
export function importBlock(): { el: HTMLElement; update(project: string): void } {
  const title = el("div", { class: "imp-title" });
  const sub = el("div", { class: "small muted" });
  const bar = progressBar("Video wird geladen");
  const text = el("div", { class: "small tnum" });
  const run = el("div", { class: "stack" }, bar.el, text,
    el("div", { class: "row wrap" }, btn("Abbrechen", () => void cancelImport(), { size: "sm" }), btn("Details", openImportDetails, { size: "sm" })),
    el("p", { class: "help" }, "Du kannst den Suchrahmen schon festlegen und den Abgleich starten."));
  const errMsg = el("span", {});
  const tail = el("pre", { class: "logbox mono short", tabIndex: 0, "aria-label": "Letzte Zeilen der Ausgabe" });
  const err = el("div", { class: "stack", hidden: true }, banner("bad", errMsg), tail,
    el("div", { class: "row wrap" }, btn("Erneut versuchen", () => void retryImport(), { size: "sm", kind: "primary" }), btn("Details", openImportDetails, { size: "sm" }),
      btn("Vorlage bearbeiten", () => go(routePath.settings), { size: "sm" }), btn("Andere Quelle wählen", () => go(routePath.start), { size: "sm" })));
  const root = el("div", { class: "stack imp-block" }, title, sub, run, err);
  return {
    el: root,
    update(project) {
      const mine = imp.project === project;
      const failed = mine && !imp.running && !!imp.done && !imp.done.ok;
      root.hidden = !(mine && (imp.running || failed));
      if (root.hidden) return;
      const p = imp.progress;
      title.textContent = p?.title ?? "Video";
      sub.textContent = failed ? `Import mit „${imp.templateName}“` : `Wird geladen${imp.templateName ? ` · ${imp.templateName}` : ""}`;
      run.hidden = failed; err.hidden = !failed;
      if (failed) {
        errMsg.textContent = importErrorText(imp.done!);
        const lines = imp.done!.tail ?? imp.log.slice(-5).map((l) => l.line);
        tail.hidden = !lines.length; tail.textContent = lines.slice(-5).join("\n");
        return;
      }
      const pct = importPct();
      const parts = [
        pct !== null ? `${Math.round(pct)} %` : null,
        p?.bytes != null ? (p.total ? `${fmtBytes(p.bytes)} von ${fmtBytes(p.total)}` : `${fmtBytes(p.bytes)} geladen`) : null,
        p?.rate ? `${fmtBytes(p.rate)}/s` : null,
        p?.eta_s != null ? fmtEta(p.eta_s) : null,
      ].filter(Boolean);
      bar.set(pct, pct !== null ? `Video wird geladen, ${Math.round(pct)} Prozent` : "Video wird geladen");
      text.textContent = parts.join(" · ") || (p?.phase === "finishing" ? "Wird abgeschlossen …" : "Startet …");
    },
  };
}
