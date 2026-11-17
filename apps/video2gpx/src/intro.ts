// Intro end set by hand ("Intro-Ende hier setzen"): the user's video second replaces the intro the pipeline finds from the scene cuts
// (rsm/pipeline/cuts.py plan, CLI --intro-end; a change reruns the rotation step and every later one, motion is reused).
// Pure data functions; only type imports, so the module also runs under `node --test` (tests/intro/intro.test.ts).

/** the value stored in app.json and passed to the run: a positive video second rounded to 1/100 s, else null (automatic) */
export function introParam(t: unknown): number | null {
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.round(t * 100) / 100 : null;
}

/** has the intro end set by hand changed since the last run (then a rerun is needed for it to take effect) */
export const introChanged = (cur: unknown, last: unknown): boolean => introParam(cur) !== introParam(last);

/** m:ss of a video second (the label of the buttons) */
export function introMmss(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
