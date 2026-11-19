# SPDX-License-Identifier: AGPL-3.0-or-later
"""User anchors ("Ortsangaben"): at video time t the camera is inside the map frame bbox (S, W, N, E). Each anchor becomes a hard per-step cell mask of the HMM
(rsm.hmm_cal.dp step_ok): the step nearest to t (steps are distance-based; Steps.t is the video time at the end of each step) must lie in a cell whose centre is
inside the frame grown by about one cell. The masks reach every decode of a step process through dp.STEP_OK_HOOK (route_search scan + decode, the local pass,
the island and extension passes, the refine posterior), set by activate(). Anchors that make the decode infeasible are dropped (prune) and reported.
The input enters the hashes from route_search onward (cli.Run.hashes); the map step reruns only if an anchor frame lies outside the search area (grow_bbox)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

TOL_CELLS = 1.0          # along-road frame tolerance in cells (grid spacing h: accounts for step-time and cell-centre discretization)
MIN_TOL_M = 10.0         # minimum along-road tolerance in m
LAT_TOL_M = 3.0          # lateral (perpendicular to the road) margin around the frame in m (avoids swallowing parallel streets 10-20 m away)
NEAR_S = 5.0             # an anchor applies to a step sequence only if one of its steps lies within this many seconds of t
GROW_MARGIN_M = 500.0    # margin around an anchor frame that lies outside the search area
KEYS = ("south", "west", "north", "east")

_ACTIVE: list = []       # anchors in effect for this process
_DROPPED: list = []      # anchors dropped as infeasible (by prune via ensure), for the report


def mmss(t: float) -> str:
    return f"{int(t) // 60}:{int(t) % 60:02d}"


def parse(raw) -> list[dict]:
    """list of {t, bbox: [S,W,N,E] | {south, west, north, east}} (or {"anchors": [...]}) -> [{t, bbox: {south, west, north, east}}] sorted by t; ValueError if invalid"""
    if isinstance(raw, dict):
        raw = raw.get("anchors", [])
    if not isinstance(raw, list):
        raise ValueError("anchors: a list of {t, bbox} is expected")
    out = []
    for i, a in enumerate(raw):
        try:
            t = float(a["t"])
            b = a["bbox"]
            vals = [float(b[k]) for k in KEYS] if isinstance(b, dict) else [float(x) for x in b]
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError(f"anchor {i + 1}: needs t (s) and bbox [S,W,N,E]") from e
        if len(vals) != 4 or not np.all(np.isfinite(vals)) or not np.isfinite(t) or t < 0:
            raise ValueError(f"anchor {i + 1}: invalid time or frame")
        s, w, n, e = vals
        if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
            raise ValueError(f"anchor {i + 1}: the frame must be S < N and W < E in degrees")
        out.append(dict(t=t, bbox=dict(zip(KEYS, vals))))
    return sorted(out, key=lambda a: a["t"])


def load(arg: str) -> list[dict]:
    """--anchors: a JSON file or inline JSON"""
    s = arg.strip()
    if s[:1] in "[{":
        return parse(json.loads(s))
    p = Path(arg)
    if not p.is_file():
        raise ValueError(f"file not found: {arg}")
    try:
        return parse(json.loads(p.read_text()))
    except json.JSONDecodeError as e:
        raise ValueError(f"anchors file is not valid JSON: {e}") from e


def grow_bbox(bbox: dict, anchors: list[dict], margin_m: float = GROW_MARGIN_M) -> dict | None:
    """the search area grown to include every anchor frame (+ margin), or None if all frames lie inside it"""
    nb = dict(bbox)
    for a in anchors or []:
        f = a["bbox"]
        if f["south"] < nb["south"] or f["north"] > nb["north"] or f["west"] < nb["west"] or f["east"] > nb["east"]:
            dlat = margin_m / 111195.0
            dlon = dlat / max(np.cos(np.radians(0.5 * (f["south"] + f["north"]))), 0.1)
            nb = dict(south=min(nb["south"], f["south"] - dlat), west=min(nb["west"], f["west"] - dlon),
                      north=max(nb["north"], f["north"] + dlat), east=max(nb["east"], f["east"] + dlon))
    return None if nb == bbox else nb


def hash_part(P: dict) -> list:
    """the anchors in the hashes of route_search onward ([] without anchors: old hashes unchanged)"""
    a = P.get("anchors")
    return [["anchors2", [[x["t"], [x["bbox"][k] for k in KEYS]] for x in a], TOL_CELLS, MIN_TOL_M, LAT_TOL_M, NEAR_S]] if a else []


def step_of(t_steps, t: float, near_s: float = NEAR_S) -> int | None:
    """index of the step whose time is nearest to t (None if no step lies within near_s s)"""
    ts = np.asarray(t_steps, float)
    if not len(ts):
        return None
    j = int(np.argmin(np.abs(ts - t)))
    return j if abs(ts[j] - t) <= near_s else None


_RECT_CACHE: dict = {}


def rect_xy(crs: str, b: dict) -> tuple:
    """(x0, y0, x1, y1) in the graph CRS that covers the frame (its edges sampled)"""
    key = (crs, tuple(b[k] for k in KEYS))
    if key not in _RECT_CACHE:
        from pyproj import Transformer
        tr = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        u = np.linspace(0, 1, 9)
        lon = np.concatenate([b["west"] + u * (b["east"] - b["west"]), np.full(9, b["east"]), b["west"] + u * (b["east"] - b["west"]), np.full(9, b["west"])])
        lat = np.concatenate([np.full(9, b["south"]), b["south"] + u * (b["north"] - b["south"]), np.full(9, b["north"]), b["south"] + u * (b["north"] - b["south"])])
        x, y = tr.transform(lon, lat)
        _RECT_CACHE[key] = (float(np.min(x)), float(np.min(y)), float(np.max(x)), float(np.max(y)))
    return _RECT_CACHE[key]


def _seg_hits_rect(x0: np.ndarray, y0: np.ndarray, x1: np.ndarray, y1: np.ndarray, rx0: float, ry0: float, rx1: float, ry1: float) -> np.ndarray:
    """Vectorized Liang-Barsky intersection test of segments (x0,y0)-(x1,y1) against axis-aligned rectangle [rx0,rx1] x [ry0,ry1]."""
    dx = x1 - x0
    dy = y1 - y0
    tmin = np.zeros_like(x0, dtype=float)
    tmax = np.ones_like(x0, dtype=float)
    ok = np.ones(len(x0), dtype=bool)
    for p, q in ((-dx, x0 - rx0), (dx, rx1 - x0), (-dy, y0 - ry0), (dy, ry1 - y0)):
        par = np.abs(p) < 1e-12
        ok &= ~(par & (q < 0.0))
        with np.errstate(divide="ignore", invalid="ignore"):
            r = np.where(par, 0.0, q / p)
        tmin = np.where(~par & (p < 0.0), np.maximum(tmin, r), tmin)
        tmax = np.where(~par & (p > 0.0), np.minimum(tmax, r), tmax)
    return ok & (tmin <= tmax)


def cell_mask(G, rect: tuple, tol_m: float | None = None) -> np.ndarray:
    """bool over the grid cells: along the cell's road heading within +-along_tol (~1 cell) of rect and laterally within LAT_TOL_M,
    so tight frames distinguish parallel streets 10-20 m apart even at coarse search spacing h. Falls back to isotropic along_tol
    when no cell intersects the tight frame (e.g. a small box drawn beside a road) or when an explicit tol_m is given."""
    x, y = G.xy[:, 0], G.xy[:, 1]
    along = max(MIN_TOL_M, TOL_CELLS * float(G.h)) if tol_m is None else tol_m
    phi = getattr(G, "phi", None)
    if tol_m is None and phi is not None:
        ux, uy = np.cos(phi), np.sin(phi)
        m = _seg_hits_rect(
            x - along * ux, y - along * uy,
            x + along * ux, y + along * uy,
            rect[0] - LAT_TOL_M, rect[1] - LAT_TOL_M, rect[2] + LAT_TOL_M, rect[3] + LAT_TOL_M,
        )
        if m.any():
            return m
    return (x >= rect[0] - along) & (x <= rect[2] + along) & (y >= rect[1] - along) & (y <= rect[3] + along)


def step_masks(G, st, anchors: list[dict], crs: str | None = None) -> dict:
    """{step j: cell mask} of the anchors for this grid and step sequence (sliced sequences too: their own Steps.t)"""
    crs = crs or G.g.crs
    out = {}
    for a in anchors or []:
        j = step_of(st.t, a["t"])
        if j is None:
            continue
        m = cell_mask(G, rect_xy(crs, a["bbox"]))
        out[j] = m if j not in out else (out[j] & m)
    return out


def _hook(grid, st, step_ok):
    ex = step_masks(grid, st, _ACTIVE) if _ACTIVE else None
    if not ex:
        return step_ok
    out = dict(step_ok or {})
    for j, m in ex.items():
        out[j] = m if j not in out else (np.asarray(out[j], bool) & m)
    return out


def activate(anchors: list[dict] | None):
    """put the anchors in effect for every decode of this process (None / [] switches them off)"""
    from rsm.hmm_cal import dp
    _ACTIVE[:] = list(anchors or [])
    dp.STEP_OK_HOOK = _hook if _ACTIVE else None


def active() -> list[dict]:
    return list(_ACTIVE)


def key() -> str:
    """for cache keys of scores (steps_b._memo_key)"""
    return json.dumps(_ACTIVE, sort_keys=True)


def prune(anchors: list[dict], feasible) -> tuple[list, list]:
    """-> (kept, dropped): all anchors if feasible(all); otherwise greedily in time order, each anchor kept only if it stays feasible with those kept before it"""
    if not anchors or feasible(anchors):
        return list(anchors or []), []
    kept, dropped = [], []
    for a in anchors:
        (kept if feasible(kept + [a]) else dropped).append(a)
    return kept, dropped


def start(P: dict):
    """route_search: the anchors of the run in effect, nothing dropped yet"""
    _DROPPED.clear()
    activate(P.get("anchors"))


def ensure(W, g, E, st, cons=None):
    """route_search (once per search on an edge set, before the scan): drop the active anchors that make the decode infeasible on a reference grid
    (kappa 1, the middle f of the scan) together with the start / end frame, and keep only the others in effect"""
    if not _ACTIVE:
        return
    import dataclasses
    from rsm.hmm_cal import dp
    from . import config as C
    from .steps_b import frame_masks, grid_for
    G = grid_for(g, E, 1.0)
    pre = dp.prepare(G, dataclasses.replace(dp.Par(**C.UTURN_PAR), a_ang=C.F_REF / float(np.median(C.F_GRID)), kappa=1.0))
    sm, em = frame_masks(g, G, cons) if cons else (None, None)
    allv = list(_ACTIVE)

    def feasible(sub):
        activate(sub)
        return bool(np.isfinite(dp.viterbi(pre, st, start_ok=sm, end_ok=em)["score"]))

    kept, dropped = prune(allv, feasible)
    activate(kept)
    for a in dropped:
        if a not in _DROPPED:
            _DROPPED.append(a)
        W.log("warn", f"user anchor at {mmss(a['t'])} cannot be reached together with the others by any route of this video; it is ignored")


def report(W, P: dict) -> dict | None:
    """status `user_anchors` and the record for route.pkl / the result (refine reads `used`)"""
    given = P.get("anchors") or []
    if not given:
        return None
    used = [a for a in given if a not in _DROPPED]
    lv = "good" if not _DROPPED else "difficult" if used else "problem"
    msg = f"{len(used)} of {len(given)} user anchors used"
    if _DROPPED:
        msg += "; not satisfiable and ignored: " + ", ".join(mmss(a["t"]) for a in _DROPPED)
    W.status("user_anchors", lv, float(len(used)), msg)
    return dict(n=len(given), used=used, dropped=list(_DROPPED), dropped_t=[a["t"] for a in _DROPPED])
