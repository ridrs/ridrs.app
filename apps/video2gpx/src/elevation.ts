// The elevation of the open project as one shared state: profile, diagnostics, the sources the route needs and the download.
// The Höhe stage (views/elevation.ts) shows and drives it; the playback panel (ridePanel.ts) and the stage bar (app/shell.ts) read it.
import { api } from "./api";
import { S, bus } from "./state";
import type { DemStatus, ElevationDiag, ElevationProfile } from "./types";

export type ElState = "idle" | "loading" | "computing" | "ready" | "missing" | "error";
export interface Download { running: boolean; index: number; of: number; bytes: number; total: number; extra: boolean; error: string | null; note: string | null; cancelled: boolean }

export const E = {
  project: "",
  state: "idle" as ElState,
  profile: null as ElevationProfile | null,
  /** made by other pipeline code or from other source blocks than there are now (the Höhe stage computes it again) */
  stale: false,
  diag: null as ElevationDiag | null,
  diagError: null as string | null,
  dem: null as DemStatus | null,
  error: null as string | null,
  dl: { running: false, index: 0, of: 0, bytes: 0, total: 0, extra: false, error: null, note: null, cancelled: false } as Download,
};

const changed = () => bus.emit("elevation");
let token = 0, diagToken = 0, demToken = 0;

/** a profile that matches the pipeline and the cached sources */
export const profileCurrent = () => !!E.profile && !E.stale;
/** downloading or computing: the stage bar shows a spinner */
export const elevationBusy = () => E.dl.running || E.state === "computing";

export function resetElevation() {
  token++; diagToken++; demToken++;
  Object.assign(E, { project: S.cur?.app.id ?? "", state: "idle", profile: null, stale: false, diag: null, diagError: null, dem: null, error: null });
  E.dl = { running: false, index: 0, of: 0, bytes: 0, total: 0, extra: false, error: null, note: null, cancelled: false };
  changed();
}

/** The profile of the open result: read, or computed when there is none and the Copernicus tiles are there. A stale one is returned as it is
 *  (stale = true) and computed again only with `recompute`. */
export async function loadElevation(o: { recompute?: boolean } = {}): Promise<void> {
  const cur = S.cur, my = ++token;
  if (!cur || !S.result?.points.length) { E.state = "idle"; E.profile = null; changed(); return; }
  if (E.project !== cur.app.id) resetElevation();
  const had = !!E.profile;
  E.state = o.recompute || !had ? "computing" : E.state; E.error = null;
  changed();
  try {
    const r = await api.profileLoad(cur.app.id, !!o.recompute);
    if (my !== token) return;
    if (r.ready && r.profile) {
      const fresh = !E.profile || E.profile.pipeline_hash !== r.profile.pipeline_hash || E.profile.z.length !== r.profile.z.length || E.profile.ascent_m !== r.profile.ascent_m || !!o.recompute;
      E.profile = r.profile; E.stale = !!r.stale; E.state = "ready";
      if (fresh) { E.diag = null; E.diagError = null; }
    } else if (r.reason === "dem_missing") { E.profile = null; E.stale = false; E.state = "missing"; if (r.dem) E.dem = r.dem; }
    else { E.profile = null; E.stale = false; E.state = "error"; E.error = r.error ?? "unbekannter Fehler"; }
  } catch (e) {
    if (my !== token) return;
    E.profile = null; E.state = "error"; E.error = String(e);
  }
  changed();
}

/** the diagnostics next to the profile (Höhe stage only: the file is large) */
export async function loadDiag(): Promise<void> {
  const cur = S.cur, p = E.profile;
  if (!cur || !p?.diag || E.diag) return;
  const my = ++diagToken;
  try {
    const d = await api.profileDiag(cur.app.id);
    if (my !== diagToken || E.profile !== p) return;
    E.diag = d && d.version >= 2 && d.n === p.z.length ? d : null;
    E.diagError = E.diag ? null : "Die Diagnosedaten passen nicht zum Profil.";
  } catch (e) {
    if (my === diagToken) { E.diag = null; E.diagError = String(e); }
  }
  changed();
}

/** which sources the route has (online: the sizes of missing Copernicus tiles are asked from the server) */
export async function loadDem(online: boolean): Promise<void> {
  const cur = S.cur, my = ++demToken;
  if (!cur) return;
  try {
    const d = await api.demStatus(cur.app.id, online);
    if (my !== demToken) return;
    E.dem = d;
  } catch { /* the list stays as it was */ }
  changed();
}

/** how much is missing in total, in bytes (Copernicus tiles and extra blocks) */
export const missingBytes = () => (E.dem ? E.dem.missing_bytes + (E.dem.extra_missing_bytes ?? 0) : 0);
export const anythingMissing = () => !!E.dem && (E.dem.tiles.some((t) => t.state === "missing") || (E.dem.extras?.missing_blocks ?? 0) > 0);

/** download everything that is missing; the profile is computed again when it is done */
export async function startDownload(): Promise<void> {
  const cur = S.cur;
  if (!cur || E.dl.running) return;
  const tiles = (E.dem?.tiles ?? []).filter((t) => t.state === "missing").map((t) => t.name);
  E.dl = { running: true, index: 0, of: 0, bytes: 0, total: 0, extra: false, error: null, note: null, cancelled: false };
  changed();
  try { await api.demDownload(tiles, cur.app.id); }
  catch (e) { E.dl = { ...E.dl, running: false, error: String(e) }; changed(); }
}
export async function cancelDownload(): Promise<void> { await api.demCancel().catch(() => {}); }

export function initElevation() {
  void api.onDemProgress((p) => { if (!E.dl.running) return; Object.assign(E.dl, { index: p.index, of: p.of, bytes: p.bytes, total: p.total, extra: !!p.extra }); changed(); });
  void api.onDemDone(async (r) => {
    if (!E.dl.running) return;
    E.dl = { ...E.dl, running: false, cancelled: !!r.cancelled, error: r.ok || r.cancelled ? null : r.error ?? "Download fehlgeschlagen", note: r.note ?? null };
    changed();
    if (r.cancelled) { await loadDem(false); return; }
    await loadDem(true);
    // new data: compute the profile again (also after an error: tiles may have come in)
    await loadElevation({ recompute: true });
    await loadDiag();
  });
  bus.on("project", () => resetElevation());
}
