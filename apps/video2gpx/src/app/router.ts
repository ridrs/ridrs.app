// Hash routes. ?mock= stays in the query string, so a scenario and a route combine: /?mock=result#/p/demo-1/ergebnis
export const STAGES = ["einrichten", "berechnung", "ergebnis", "export"] as const;
export type Stage = (typeof STAGES)[number];
export const RESULT_VIEWS = ["uebersicht", "hoehe", "analyse"] as const;
export type ResultView = (typeof RESULT_VIEWS)[number];
export type Route =
  | { view: "start" } | { view: "tools" } | { view: "maps" } | { view: "settings" } | { view: "selfcheck" }
  | { view: "project"; id: string; stage: Stage | null; sub?: ResultView };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case "werkzeuge": return { view: "tools" };
    case "kartendaten": return { view: "maps" };
    case "einstellungen": return { view: "settings" };
    case "_selfcheck": return { view: "selfcheck" };
    case "p":
      if (parts[1]) {
        // Legacy routes #/p/<id>/hoehe and #/p/<id>/analyse map into the merged Ergebnis views
        if (parts[2] === "hoehe" || parts[2] === "analyse") {
          return { view: "project", id: parts[1], stage: "ergebnis", sub: parts[2] };
        }
        const stage = (STAGES as readonly string[]).includes(parts[2]) ? (parts[2] as Stage) : null;
        if (stage === "ergebnis") {
          const sub: ResultView = (RESULT_VIEWS as readonly string[]).includes(parts[3]) ? (parts[3] as ResultView) : "uebersicht";
          return { view: "project", id: parts[1], stage, sub };
        }
        return { view: "project", id: parts[1], stage };
      }
  }
  return { view: "start" };
}
export const routePath = {
  start: "#/", tools: "#/werkzeuge", maps: "#/kartendaten", settings: "#/einstellungen",
  project: (id: string, stage?: Stage, sub?: ResultView) =>
    `#/p/${encodeURIComponent(id)}${stage ? "/" + stage : ""}${stage === "ergebnis" && sub && sub !== "uebersicht" ? "/" + sub : ""}`,
};
export const currentRoute = (): Route => parseRoute(location.hash);

let handler: (r: Route) => void = () => {};
/** navigate; replace: do not add a history entry (redirects) */
export function go(path: string, replace = false) {
  if (location.hash === path || (path === "#/" && !location.hash)) { handler(currentRoute()); return; }
  if (replace) { history.replaceState(null, "", location.pathname + location.search + path); handler(currentRoute()); }
  else location.hash = path;
}
export function initRouter(onChange: (r: Route) => void) {
  handler = onChange;
  window.addEventListener("hashchange", () => handler(currentRoute()));
}
