// Darstellung: System / Hell / Dunkel as data-theme on <html>, kept in localStorage. ?theme= and ?freeze=1 are for screenshots.
export type Theme = "system" | "light" | "dark";
const KEY = "v2g.theme";
const params = new URLSearchParams(location.search);
/** ?freeze=1: no animations and no mock timers, for deterministic screenshots */
export const frozen = params.get("freeze") === "1";

export function getTheme(): Theme {
  try { const t = localStorage.getItem(KEY); return t === "light" || t === "dark" ? t : "system"; } catch { return "system"; }
}
function apply(t: Theme) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  window.dispatchEvent(new Event("themechange"));
}
export function setTheme(t: Theme) {
  try { if (t === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* private mode */ }
  apply(t);
}
export function initTheme() {
  const q = params.get("theme");
  apply(q === "light" || q === "dark" ? q : getTheme());
  if (frozen) document.documentElement.setAttribute("data-freeze", "");
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => window.dispatchEvent(new Event("themechange")));
}
/** a colour token as the canvas code needs it */
export const token = (name: string, fallback = "#888") => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
