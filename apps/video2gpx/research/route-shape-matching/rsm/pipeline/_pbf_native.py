# SPDX-License-Identifier: AGPL-3.0-or-later
"""Optional native C streaming PBF node scanner for rsm.pipeline.osm (falls back transparently to pyosmium when absent or RSM_NO_NATIVE=1)."""
from __future__ import annotations

import ctypes
import os
import platform
from pathlib import Path

import numpy as np

_PROGRESS_CB = ctypes.CFUNCTYPE(None, ctypes.c_double)
MISSING_E7 = np.int32(-2147483648)


def _load():
    if os.environ.get("RSM_NO_NATIVE") == "1":
        return None
    here = Path(__file__).resolve().parent
    arch = platform.machine().lower()
    for p in (here / f"_pbf_native_{arch}.so", here / "_pbf_native.so"):
        if not p.is_file():
            continue
        try:
            lib = ctypes.CDLL(str(p))
            lib.pbf_scan_nodes_in_boxes.argtypes = [
                ctypes.c_char_p,
                ctypes.c_int32,
                ctypes.POINTER(ctypes.c_double),
                ctypes.c_double,
                ctypes.c_int32,
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.POINTER(ctypes.c_int64)),
                ctypes.POINTER(ctypes.POINTER(ctypes.c_int32)),
                ctypes.POINTER(ctypes.POINTER(ctypes.c_int32)),
                ctypes.POINTER(ctypes.POINTER(ctypes.c_uint32)),
                ctypes.POINTER(ctypes.c_int64),
            ]
            lib.pbf_scan_nodes_in_boxes.restype = ctypes.c_int32
            lib.pbf_free_nodes.argtypes = [
                ctypes.POINTER(ctypes.c_int64),
                ctypes.POINTER(ctypes.c_int32),
                ctypes.POINTER(ctypes.c_int32),
                ctypes.POINTER(ctypes.c_uint32),
            ]
            lib.pbf_free_nodes.restype = None
            lib.pbf_lookup_nodes_by_ids.argtypes = [
                ctypes.c_char_p,
                ctypes.c_void_p,
                ctypes.c_int64,
                ctypes.c_int32,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            lib.pbf_lookup_nodes_by_ids.restype = ctypes.c_int32
            lib.pbf_way_box_masks.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_int64,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_int64,
                ctypes.c_void_p,
            ]
            lib.pbf_way_box_masks.restype = None
            lib.pbf_way_box_mask_one.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_int64,
                ctypes.c_void_p,
                ctypes.c_int64,
            ]
            lib.pbf_way_box_mask_one.restype = ctypes.c_uint32
            return lib
        except OSError:
            continue
    return None


LIB = _load()


def available() -> bool:
    return LIB is not None


def _n_threads() -> int:
    return max(1, min(4, os.cpu_count() or 2))


def scan_nodes_in_boxes(pbf: str | Path, boxes_swne: list[tuple[float, float, float, float]],
                        pad_deg: float = 0.05, progress=None) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None:
    """Stream all nodes in `pbf` inside any padded box -> sorted (ids int64, lat_e7 int32, lon_e7 int32, mask uint32), or None to fall back."""
    if LIB is None or not boxes_swne or len(boxes_swne) > 32:
        return None
    arr = np.asarray(boxes_swne, dtype=np.float64).reshape(-1)
    c_boxes = arr.ctypes.data_as(ctypes.POINTER(ctypes.c_double))
    cb = _PROGRESS_CB(progress) if progress is not None else None
    cb_ptr = ctypes.cast(cb, ctypes.c_void_p) if cb is not None else ctypes.c_void_p(0)

    out_ids = ctypes.POINTER(ctypes.c_int64)()
    out_lat = ctypes.POINTER(ctypes.c_int32)()
    out_lon = ctypes.POINTER(ctypes.c_int32)()
    out_mask = ctypes.POINTER(ctypes.c_uint32)()
    out_n = ctypes.c_int64(0)

    rc = LIB.pbf_scan_nodes_in_boxes(
        os.fsencode(str(pbf)),
        len(boxes_swne),
        c_boxes,
        float(pad_deg),
        _n_threads(),
        cb_ptr,
        ctypes.byref(out_ids),
        ctypes.byref(out_lat),
        ctypes.byref(out_lon),
        ctypes.byref(out_mask),
        ctypes.byref(out_n),
    )
    if rc != 0:
        return None
    n = int(out_n.value)
    if n == 0:
        return (np.empty(0, np.int64), np.empty(0, np.int32), np.empty(0, np.int32), np.empty(0, np.uint32))
    try:
        ids = np.ctypeslib.as_array(out_ids, shape=(n,)).copy()
        lat = np.ctypeslib.as_array(out_lat, shape=(n,)).copy()
        lon = np.ctypeslib.as_array(out_lon, shape=(n,)).copy()
        mask = np.ctypeslib.as_array(out_mask, shape=(n,)).copy()
    finally:
        LIB.pbf_free_nodes(out_ids, out_lat, out_lon, out_mask)
    return ids, lat, lon, mask


def lookup_nodes_by_ids(pbf: str | Path, sorted_ids: np.ndarray, progress=None) -> tuple[np.ndarray, np.ndarray] | None:
    """Stream `pbf` and fetch (lat_e7, lon_e7) for each ID in sorted unique int64 array `sorted_ids` (MISSING_E7 if absent), or None to fall back."""
    if LIB is None:
        return None
    sids = np.ascontiguousarray(sorted_ids, dtype=np.int64)
    n = len(sids)
    lat = np.empty(n, dtype=np.int32)
    lon = np.empty(n, dtype=np.int32)
    if n == 0:
        return lat, lon
    cb = _PROGRESS_CB(progress) if progress is not None else None
    cb_ptr = ctypes.cast(cb, ctypes.c_void_p) if cb is not None else ctypes.c_void_p(0)
    rc = LIB.pbf_lookup_nodes_by_ids(
        os.fsencode(str(pbf)),
        ctypes.c_void_p(sids.ctypes.data),
        n,
        _n_threads(),
        cb_ptr,
        ctypes.c_void_p(lat.ctypes.data),
        ctypes.c_void_p(lon.ctypes.data),
    )
    if rc != 0:
        return None
    return lat, lon


def way_box_masks(sorted_ids: np.ndarray, masks: np.ndarray, refs: np.ndarray, way_off: np.ndarray) -> np.ndarray:
    """Compute OR'd exact-box bitmask for each way in a concatenated batch."""
    n_ways = len(way_off) - 1
    out = np.zeros(n_ways, dtype=np.uint32)
    if LIB is None or n_ways <= 0 or len(sorted_ids) == 0:
        return out
    LIB.pbf_way_box_masks(
        ctypes.c_void_p(sorted_ids.ctypes.data),
        ctypes.c_void_p(masks.ctypes.data),
        len(sorted_ids),
        ctypes.c_void_p(refs.ctypes.data),
        ctypes.c_void_p(way_off.ctypes.data),
        n_ways,
        ctypes.c_void_p(out.ctypes.data),
    )
    return out
