#!/usr/bin/env node
// Screenshots and accessibility check of every mock scenario, light and dark (plan-ui section 12).
// Needs a running `pnpm dev` (port 1450) and an installed Google Chrome (playwright-core drives it; no browser download).
//   node scripts/ui-shots.mjs              all scenarios, both themes, 1360 x 900 (+ a subset at 900 x 640)
//   node scripts/ui-shots.mjs --list       print the URLs (for checking by hand in a browser)
//   node scripts/ui-shots.mjs --only result,running --theme dark
// Writes research/route-shape-matching/work/ui-shots/<name>-<theme>[-small].png (git-ignored) and prints a summary.
// Exit code 1 when axe finds WCAG 2.1 A/AA violations, a page logs an error, the self-check fails or the focus is lost.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.V2G_URL ?? "http://127.0.0.1:1450/";
const OUT = join(ROOT, "research/route-shape-matching/work/ui-shots");
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

/** name, mock scenario, route (default: the scenario's), extra query, a click before the shot, small: also 900 x 640 */
export const SHOTS = [
  { name: "start", scenario: "start", small: true },
  { name: "start-recent", scenario: "recent" },
  { name: "start-url", scenario: "recent", type: "https://example.org/watch?v=demo" },
  { name: "start-notemplate", scenario: "notemplate", type: "https://example.org/watch?v=demo" },
  { name: "tools", scenario: "tools", small: true },
  { name: "tools-ytdlp", scenario: "tools-ytdlp" },
  { name: "tools-nopipeline", scenario: "tools-nopipeline" },
  { name: "import", scenario: "import" },
  { name: "import-unknown", scenario: "import", extra: "&total=unknown" },
  { name: "import-error", scenario: "import-error" },
  { name: "settings", scenario: "templates" },
  { name: "settings-editor", scenario: "templates", click: "Neue Vorlage …" },
  { name: "dev", scenario: "dev" },
  { name: "setup", scenario: "project", small: true },
  { name: "setup-fresh", scenario: "fresh" },
  { name: "setup-nosuggest", scenario: "nosuggest" },
  { name: "setup-noframe", scenario: "noframe" },
  { name: "setup-nomap", scenario: "nomap" },
  { name: "setup-mapdata-dialog", scenario: "nomap", click: "Kartendaten laden …" },
  { name: "setup-novideo", scenario: "novideo" },
  { name: "setup-videomissing", scenario: "videomissing" },
  { name: "setup-offline", scenario: "offline" },
  { name: "setup-frames", scenario: "frames" },
  { name: "mapdata", scenario: "mapdata" },
  { name: "running", scenario: "running", small: true },
  { name: "running-start", scenario: "running-start" },
  { name: "running-parallel", scenario: "running-parallel" },
  { name: "running-stream", scenario: "running-stream" },
  { name: "cancelled", scenario: "cancelled" },
  { name: "failed", scenario: "failed" },
  { name: "result", scenario: "result", small: true },
  { name: "result-uncertain", scenario: "uncertain" },
  { name: "result-noroute", scenario: "noroute" },
  { name: "result-difficult", scenario: "difficult" },
  { name: "result-hints", scenario: "hints" },
  { name: "result-nodem", scenario: "result", extra: "&dem=missing" },
  { name: "result-frames", scenario: "result-frames" },
  { name: "analyse", scenario: "analyse-bad", small: true },
  { name: "hoehe", scenario: "hoehe-full", small: true },
  { name: "hoehe-download", scenario: "hoehe-missing" },
  { name: "export", scenario: "export", small: true },
  { name: "export-uncertain", scenario: "export-uncertain" },
  { name: "export-running", scenario: "export-running" },
  { name: "export-done", scenario: "export-done" },
  { name: "selfcheck", scenario: "selfcheck" },
];

const url = (s, theme, freeze = true) => `${BASE}?mock=${s.scenario}${s.extra ?? ""}&theme=${theme}${freeze ? "&freeze=1" : ""}${s.route ? s.route : ""}`;
const only = opt("--only")?.split(",");
const themes = opt("--theme") ? [opt("--theme")] : ["light", "dark"];
const list = SHOTS.filter((s) => !only || only.includes(s.name));
if (args.includes("--list")) { for (const s of list) for (const t of themes) console.log(url(s, t)); process.exit(0); }

const require = createRequire(import.meta.url);
const { chromium } = await import("playwright-core");
const axeSource = (await import("node:fs")).readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const problems = [];

async function shoot(s, theme, size, suffix) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: theme });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/tile\.openstreetmap|127\.0\.0\.1:9|does-not-play|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.dismiss());
  await page.goto(url(s, theme), { waitUntil: "load" });
  await page.waitForTimeout(900);
  if (s.type) { await page.fill("input.lg", s.type); await page.waitForTimeout(400); }
  if (s.click) { await page.getByRole("button", { name: s.click }).first().click(); await page.waitForTimeout(700); }
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0)); // a full-page shot of a scrolled page repeats the sticky bar
  const file = join(OUT, `${s.name}-${theme}${suffix}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(async () => {
    const r = await window.axe.run({ exclude: [[".leaflet-tile-pane"], [".leaflet-marker-pane"]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  });
  const checks = await page.evaluate(() => ({ h1: document.querySelectorAll("h1:not([hidden])").length, selfcheck: document.querySelector("[data-selfcheck]")?.getAttribute("data-selfcheck") ?? null, overflowX: document.documentElement.scrollWidth > window.innerWidth + 1 }));
  const issues = [...axe.map((a) => `axe ${a}`), ...errors.map((e) => `console ${e}`)];
  if (checks.selfcheck === "fail") issues.push("selfcheck failed");
  if (checks.overflowX) issues.push("horizontal overflow");
  if (checks.h1 < 1) issues.push("no h1");
  console.log(`${issues.length ? "FAIL" : "ok  "} ${s.name}-${theme}${suffix}${issues.length ? "\n     " + issues.join("\n     ") : ""}`);
  if (issues.length) problems.push(`${s.name}-${theme}${suffix}`);
  await ctx.close();
}

for (const s of list) for (const t of themes) {
  await shoot(s, t, { width: 1360, height: 900 }, "");
  if (s.small) await shoot(s, t, { width: 900, height: 640 }, "-small");
}

// the focus survives 2 s of live run events (no re-render of the focused control)
if (!only || only.includes("running")) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(url({ scenario: "running" }, "light", false));
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Abbrechen" }).focus();
  await page.locator("summary", { hasText: "Protokoll" }).focus();
  await page.waitForTimeout(2000);
  const kept = await page.evaluate(() => document.activeElement?.tagName === "SUMMARY");
  console.log(`${kept ? "ok  " : "FAIL"} focus kept during a running job`);
  if (!kept) problems.push("focus");
  await ctx.close();
}
// keyboard: cancel a run with Enter, the focus moves to "Fortsetzen", Enter resumes; no page errors on the way
if (!only || only.includes("running")) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/tile\.openstreetmap|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(url({ scenario: "running" }, "light", false));
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Abbrechen" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const resumed = await page.evaluate(() => !!Array.from(document.querySelectorAll("button")).find((b) => b.offsetParent && b.textContent.trim() === "Abbrechen"));
  const ok = focused === "Fortsetzen" && resumed && !errors.length;
  console.log(`${ok ? "ok  " : "FAIL"} cancel and resume by keyboard${ok ? "" : ` (focus: ${focused}, resumed: ${resumed}, errors: ${errors.join(" | ")})`}`);
  if (!ok) problems.push("cancel-resume");
  await ctx.close();
}
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s): ${problems.join(", ")}` : `\nall clean · screenshots in ${OUT}`);
process.exit(problems.length ? 1 : 0);
