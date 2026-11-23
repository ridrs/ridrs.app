// Boot: api, store, shell, views, event wiring, router.
import "./style.css";
import { api, initApi } from "./api";
import { attachVideo, refreshProjects } from "./app/project";
import { currentRoute, go, initRouter, routePath } from "./app/router";
import { buildShell, onRoute, onShow } from "./app/shell";
import { initTheme } from "./app/theme";
import { importErrorText, initImport, loadTemplates } from "./features/import";
import { initRun, toolsReady } from "./features/run";
import { initAnalyse } from "./analyse";
import { initElevation } from "./elevation";
import { wireIncyclistEvents } from "./incyclist";
import { initMapPanel } from "./mapPanel";
import { S, bus, refreshPbfs, saveCur, toast } from "./state";
import type { ImportDone } from "./types";
import { isImagePath } from "./util";
import { initVideoPanel } from "./videoPanel";
import { mountAnalyse } from "./views/analyse";
import { mountElevation } from "./views/elevation";
import { mountExport } from "./views/export";
import { initMapData, mountMaps } from "./views/maps";
import { mountResult } from "./views/result";
import { mountRouteEditor } from "./routeEditor";
import { mountAnchors } from "./anchorPanel";
import { mountRun } from "./views/run";
import { mountSettings, showSettings } from "./views/settings";
import { mountSetup, suggestAfterTitle } from "./views/setup";
import { handleDrop, mountStart, showStart } from "./views/start";
import { mountTools, recheck } from "./views/tools";

async function main() {
  initTheme();
  await initApi();
  const R = buildShell();
  initRun(); initImport(); initMapData(); initElevation(); initAnalyse(); wireIncyclistEvents();
  initMapPanel(R.map); initVideoPanel(R.video);
  mountStart(R.views.start); mountTools(R.views.tools); mountMaps(R.views.maps); mountSettings(R.views.settings);
  mountSetup(R.side, R.ws); mountRun(R.main, R.info); mountAnalyse(R.main, R.video, R.head); mountElevation(R.main, R.head); mountExport(R.main); const adjustHost = mountResult(R.head, R.timeline); mountRouteEditor(adjustHost); mountAnchors(adjustHost);
  onShow("start", showStart); onShow("settings", showSettings); onShow("tools", () => void recheck());
  if (api.mock) { const m = await import("./mock/selfcheck"); m.mountSelfcheck(R.views.selfcheck); }

  // on the Export stage an image becomes the preview of the Incyclist package; anything else goes to the start page's handler
  const onExport = () => { const r = currentRoute(); return r.view === "project" && r.stage === "export"; };
  await api.onFileDrop((paths) => {
    const img = paths.find(isImagePath);
    if (img && onExport()) bus.emit("preview-drop", img); else handleDrop(paths);
  }, (over) => bus.emit("drag", over));
  // the title of an imported video names its project and may suggest a search frame
  bus.on("import-title", async (project: string, title: string) => {
    const isCur = S.cur?.app.id === project;
    const app = isCur ? S.cur!.app : (await api.projectOpen(project).catch(() => null))?.app;
    if (!app || app.video || app.name === title) return;
    app.name = title;
    await api.projectSave(app.id, app);
    await refreshProjects();
    if (isCur) { bus.emit("projects"); suggestAfterTitle(); }
  });
  bus.on("import-done", async (r: ImportDone) => {
    if (r.ok && r.file) { if (await attachVideo(r.project, r.file)) toast("Video geladen."); }
    else if (!r.cancelled && S.cur?.app.id !== r.project) toast(importErrorText(r), "error");
    if (r.ok && S.cur?.app.id === r.project) void saveCur({});
  });

  S.settings = await api.settingsGet();
  await Promise.all([refreshProjects(), refreshPbfs(), loadTemplates()]);
  initRouter((r) => void onRoute(r));
  if (!location.hash && api.mock) { const { SC } = await import("./mock/scenarios"); history.replaceState(null, "", location.pathname + location.search + SC.route); }
  else if (!location.hash && S.settings.last_project && S.projects.some((p) => p.id === S.settings!.last_project)) { /* start page; the last project is first in the list */ }
  void api.envCheck().then((e) => {
    S.env = e; bus.emit("env");
    // a required program is missing: the Werkzeuge view instead of the start page
    if (!toolsReady(e) && currentRoute().view === "start") go(routePath.tools, true);
  });
  await onRoute(currentRoute());
}

void main();
