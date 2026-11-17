# SPDX-License-Identifier: AGPL-3.0-or-later
"""Lane model (driving line layer L1): road cross-section and preferred lateral position from OSM tags and the vehicle. A MODEL, not a measurement.

Lateral coordinate d per path metre: metres to the driving side of travel (right in right-hand traffic), 0 = the OSM line. On a two-way road the OSM line is the road
centre, on a one-way road or a roundabout it is the centre of the carriageway. Pure functions, no I/O; arrays are per metre of the decoded path."""
from __future__ import annotations

import numpy as np
from scipy.ndimage import uniform_filter1d

from . import config as C

NARROW_CLASSES = ("unclassified", "residential", "living_street", "service", "track")


def _base(hw: str) -> str:
    return hw[:-5] if hw.endswith("_link") else hw


def cross_section(highway, width, lanes, oneway, roundabout) -> tuple[np.ndarray, np.ndarray]:
    """carriageway width W (m) and its standard deviation per metre: tagged width, else lanes x lane width of the class, else the class default (C.LANE_WIDTH_DEFAULT)"""
    hw = np.asarray(highway).astype(str)
    w = np.asarray(width, float)
    n = np.asarray(lanes, int)
    ow, rb = np.asarray(oneway, bool), np.asarray(roundabout, bool)
    W = np.empty(len(hw)); sd = np.empty(len(hw))
    for i, h in enumerate(hw):
        b = _base(h)
        if np.isfinite(w[i]):
            W[i], sd[i] = w[i], C.LANE_SD_M[0]
        elif n[i] > 0:
            W[i], sd[i] = n[i] * C.LANE_LANE_W.get(b, C.LANE_LANE_W["other"]), C.LANE_SD_M[1]
        elif rb[i]:
            W[i], sd[i] = C.LANE_WIDTH_DEFAULT["roundabout"], C.LANE_SD_M[2]
        elif ow[i] and b not in ("motorway", "trunk"):
            W[i], sd[i] = C.LANE_WIDTH_DEFAULT["oneway"], C.LANE_SD_M[2]
        else:
            W[i] = C.LANE_WIDTH_DEFAULT.get(h, C.LANE_WIDTH_DEFAULT.get(b, C.LANE_WIDTH_DEFAULT["other"]))
            sd[i] = C.LANE_SD_M[2]
    return W, sd


def narrow(highway, W, lanes, marked) -> np.ndarray:
    """two-way roads without a centre marking: motor vehicles use the whole road (W < C.LANE_NARROW_M, lane_markings=no, or a minor class with unknown lanes)"""
    hw = np.asarray(highway).astype(str)
    minor = np.array([_base(h) in NARROW_CLASSES for h in hw])
    return (np.asarray(W) < C.LANE_NARROW_M) | (np.asarray(marked) == 0) | (minor & (np.asarray(lanes) <= 0) & (np.asarray(marked) != 1))


def corridor(W, oneway, roundabout, narrow_, vehicle: str) -> tuple[np.ndarray, np.ndarray]:
    """[lo, hi] of the vehicle centre: own half [0, W/2 - margin] on two-way roads; whole carriageway on one-way roads, roundabouts and (motor vehicles) narrow roads"""
    W = np.asarray(W, float)
    m = C.LANE_MARGIN_M[vehicle]
    whole = np.asarray(oneway, bool) | np.asarray(roundabout, bool) | (np.asarray(narrow_, bool) & (vehicle != "bike"))
    hi = W / 2 - m
    lo = np.where(whole, -W / 2 + m, 0.0)
    mid = 0.5 * (lo + hi)
    bad = lo > hi                                                              # road narrower than the vehicle plus margins: its middle
    return np.where(bad, mid, lo), np.where(bad, mid, hi)


def preferred(W, lanes, lanes_fwd, oneway, roundabout, narrow_, cycle, vehicle: str) -> np.ndarray:
    """preferred position d_pref (before the corridor clip): bike C.LANE_BIKE_EDGE_M from the own edge (cycle lane: its centre); car the centre of the outer own lane,
    near the middle on narrow roads; motorcycle as the car, C.LANE_MOTO_SHIFT_M towards the centre"""
    W = np.asarray(W, float)
    n = np.asarray(lanes, int); nf = np.asarray(lanes_fwd, int)
    ow = np.asarray(oneway, bool) | np.asarray(roundabout, bool)
    if vehicle == "bike":
        e = np.where(W < 4.0, C.LANE_BIKE_EDGE_M[1], C.LANE_BIKE_EDGE_M[0])
        e = np.where(np.asarray(cycle) == 1, C.LANE_BIKE_CYCLELANE_M, e)
        return W / 2 - e
    n_ow = np.where(nf > 0, nf, np.where(n > 0, n, 1))                         # one-way: lanes of the carriageway
    two_tot = np.where(n > 0, n, 2)
    two_fwd = np.where(nf > 0, nf, np.maximum(two_tot // 2, 1))
    d_ow = W / 2 - W / (2 * n_ow)
    d_two = (two_fwd - 0.5) * W / np.maximum(two_tot, 1)
    d_nar = np.minimum(W / 2 - C.LANE_MARGIN_M["car"], 0.5)
    d = np.where(ow, d_ow, np.where(narrow_, d_nar, d_two))
    return d - (C.LANE_MOTO_SHIFT_M if vehicle == "motorcycle" else 0.0)


def ramp(x: np.ndarray, step: float = 1.0) -> np.ndarray:
    """step functions along the path become ramps over C.LANE_RAMP_M"""
    k = max(1, int(round(C.LANE_RAMP_M / step)))
    return uniform_filter1d(np.asarray(x, float), k, mode="nearest") if len(x) > 1 else np.asarray(x, float)


def model(R: dict, vehicle: str, step: float = 1.0) -> dict:
    """the whole L1 model from the per-metre arrays of refine/result.npz (missing tags: unknown). -> dict(d, lo, hi, W, sd, src) per metre; src 0 tagged width,
    1 lanes, 2 class default"""
    n = len(R["xy"])
    get = lambda k, fill, dt: np.asarray(R[k], dt) if k in R else np.full(n, fill, dt)
    hw = np.asarray(R["highway"]).astype(str) if "highway" in R else np.full(n, "")
    width, lanes, lf = get("width", np.nan, float), get("lanes", 0, int), get("lanes_fwd", 0, int)
    ow, rb, mk, cy = get("oneway", False, bool), get("roundabout", False, bool), get("marked", -1, int), get("cycle", 0, int)
    W, sd = cross_section(hw, width, lanes, ow, rb)
    nar = narrow(hw, W, lanes, mk) & ~ow & ~rb
    lo, hi = corridor(W, ow, rb, nar, vehicle)
    d = np.clip(preferred(W, lanes, lf, ow, rb, nar, cy, vehicle), lo, hi)
    src = np.where(np.isfinite(width), 0, np.where(lanes > 0, 1, 2))
    lo_r, hi_r = ramp(lo, step), ramp(hi, step)
    return dict(d=np.clip(ramp(d, step), lo_r, hi_r), lo=lo_r, hi=hi_r, W=ramp(W, step), sd=sd, src=src, roundabout=rb)
