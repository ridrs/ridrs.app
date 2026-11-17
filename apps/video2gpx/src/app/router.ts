// Hash routes. ?mock= stays in the query string, so a scenario and a route combine: /?mock=result#/p/demo-1/ergebnis
export const STAGES = ["einrichten", "berechnung", "ergebnis", "analyse", "hoehe", "export"] as const;
export type Stage = (typeof STAGES)[number];
export type Route =
  | { view: "start" } | { view: "tools" } | { view: "maps" } | { view: "settings" } | { view: "selfcheck" }
  | { view: "project"; id: string; stage: Stage | null };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case "werkzeuge": return { view: "tools" };
    case "kartendaten": return { view: "maps" };
    case "einstellungen": return { view: "settings" };
    case "_selfcheck": return { view: "selfcheck" };
    case "p":
      if (parts[1]) return { view: "project", id: parts[1], stage: (STAGES as readonly string[]).includes(parts[2]) ? (parts[2] as Stage) : null };
  }
  return { view: "start" };
}
export const routePath = {
  start: "#/", tools: "#/werkzeuge", maps: "#/kartendaten", settings: "#/einstellungen",
  project: (id: string, stage?: Stage) => `#/p/${encodeURIComponent(id)}${stage ? "/" + stage : ""}`,
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
