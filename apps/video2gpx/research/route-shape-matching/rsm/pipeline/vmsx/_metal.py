# SPDX-License-Identifier: AGPL-3.0-or-later
"""Optional macOS Metal GPU backend for forward-backward pyramidal Lucas-Kanade optical flow.

Read-only loader for `_lk_metal_<arch>.so` (compiled by dev.sh / scripts/build-sidecar.sh): never writes
or compiles at import time (preserves `test_lean_environment_imports_and_writes_nothing`).
Falls back transparently to OpenCV CPU when unavailable, non-macOS, or `RSM_NO_METAL=1`.
"""
from __future__ import annotations

import ctypes
import os
import platform
import sys
from collections import OrderedDict
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve().parent
_ARCH = platform.machine()
_SO = _HERE / f"_lk_metal_{_ARCH}.so"

_LIB = None
_TRIED = False
_AVAIL: bool | None = None

_c_void_p = ctypes.c_void_p
_c_int = ctypes.c_int
_c_float = ctypes.c_float
_c_int32_p = ctypes.POINTER(ctypes.c_int32)
_c_float_p = ctypes.POINTER(ctypes.c_float)
_c_u8_pp = ctypes.POINTER(ctypes.c_void_p)


def _load():
    global _LIB, _TRIED
    if _TRIED:
        return _LIB
    _TRIED = True
    if sys.platform != "darwin" or not _SO.exists():
        return None
    try:
        lib = ctypes.CDLL(str(_SO))
        lib.rsm_metal_available.argtypes = []
        lib.rsm_metal_available.restype = _c_int

        lib.rsm_metal_create.argtypes = [_c_int, _c_int, _c_int, _c_int, _c_int]
        lib.rsm_metal_create.restype = _c_void_p

        lib.rsm_metal_destroy.argtypes = [_c_void_p]
        lib.rsm_metal_destroy.restype = None

        lib.rsm_metal_run_batch.argtypes = [
            _c_void_p,   # handle
            _c_int,      # n_upload
            _c_u8_pp,    # upload_ptrs
            _c_int32_p,  # upload_slots
            _c_int,      # n_pairs
            _c_int32_p,  # slot_a
            _c_int32_p,  # slot_b
            _c_int32_p,  # pt_off
            _c_int32_p,  # pt_cnt
            _c_int,      # total_pts
            _c_float_p,  # pts_xy
            _c_int,      # half_win
            _c_int,      # max_level
            _c_int,      # max_iter
            _c_float,    # eps2
            _c_float_p,  # out_flow_fb
        ]
        lib.rsm_metal_run_batch.restype = _c_int
        _LIB = lib
    except OSError:
        _LIB = None
    return _LIB


def supports_params(lk_params: dict) -> bool:
    """True when the Metal shader supports the given OpenCV LK_PARAMS dict."""
    win = lk_params.get("winSize", (15, 15))
    lvl = int(lk_params.get("maxLevel", 3))
    return (
        len(win) == 2
        and win[0] == win[1]
        and win[0] % 2 == 1
        and 3 <= win[0] <= 21
        and 0 <= lvl <= 4
    )


def available(lk_params: dict | None = None) -> bool:
    """True when Metal GPU LK is built, enabled (`RSM_NO_METAL != 1`), and a Metal device exists."""
    global _AVAIL
    if os.environ.get("RSM_NO_METAL") == "1":
        return False
    if lk_params is not None and not supports_params(lk_params):
        return False
    if _AVAIL is None:
        lib = _load()
        _AVAIL = bool(lib is not None and lib.rsm_metal_available() == 1)
    return _AVAIL


class MetalLKSession:
    """Batched forward-backward pyramidal LK tracker with LRU frame-pyramid slot caching.

    Each frame is identified by a hashable `frame_key` (e.g. `("des", j)` or `("raw", j)`).
    Frames already resident in a GPU pyramid slot are never re-uploaded or re-downsampled.
    """

    def __init__(self, width: int, height: int, lk_params: dict, n_slots: int = 32):
        lib = _load()
        if lib is None or not supports_params(lk_params):
            raise RuntimeError("Metal LK backend is not available")
        win = lk_params["winSize"]
        crit = lk_params["criteria"]
        self._lib = lib
        self.width = int(width)
        self.height = int(height)
        self.half_win = int(win[0]) // 2
        self.max_level = int(lk_params["maxLevel"])
        self.max_iter = int(crit[1])
        self.eps2 = float(crit[2]) * float(crit[2])
        self.n_slots = int(n_slots)
        self._handle = lib.rsm_metal_create(self.width, self.height, self.max_level, self.n_slots, 16384)
        if not self._handle:
            raise RuntimeError("rsm_metal_create failed")
        self._key_to_slot: OrderedDict[object, int] = OrderedDict()
        self._free_slots: list[int] = list(range(self.n_slots - 1, -1, -1))

    def close(self) -> None:
        if self._handle:
            self._lib.rsm_metal_destroy(self._handle)
            self._handle = None
            self._key_to_slot.clear()
            self._free_slots.clear()

    def __enter__(self) -> MetalLKSession:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __del__(self) -> None:
        self.close()

    def _alloc_slot(self, key: object, pinned: set[object]) -> tuple[int, bool]:
        """Return (slot_index, needs_upload). Evicts the least-recently-used unpinned slot if full."""
        slot = self._key_to_slot.get(key)
        if slot is not None:
            self._key_to_slot.move_to_end(key)
            return slot, False
        if self._free_slots:
            slot = self._free_slots.pop()
            self._key_to_slot[key] = slot
            return slot, True
        for old_key, old_slot in list(self._key_to_slot.items()):
            if old_key not in pinned:
                del self._key_to_slot[old_key]
                self._key_to_slot[key] = old_slot
                return old_slot, True
        raise RuntimeError(f"MetalLKSession out of pyramid slots (n_slots={self.n_slots}, pinned={len(pinned)})")

    def run_batch(
        self,
        pairs: list[tuple[object, np.ndarray, object, np.ndarray, np.ndarray]],
    ) -> list[tuple[np.ndarray, np.ndarray, np.ndarray]]:
        """Track a batch of `(key_a, frame_a, key_b, frame_b, pts)` in a single GPU command buffer.

        Returns a list of `(flow (n, 2) float64, fb (n,) float64, ok (n,) bool)` matching `extract.track()`.
        """
        if not pairs:
            return []
        pinned: set[object] = set()
        for ka, _, kb, _, _ in pairs:
            pinned.add(ka)
            pinned.add(kb)

        upload_arrays: list[np.ndarray] = []
        upload_slots: list[int] = []
        slot_a: list[int] = []
        slot_b: list[int] = []
        pt_off: list[int] = []
        pt_cnt: list[int] = []
        pts_chunks: list[np.ndarray] = []
        total_pts = 0

        for ka, fa, kb, fb, pts in pairs:
            sa, up_a = self._alloc_slot(ka, pinned)
            if up_a:
                arr_a = np.ascontiguousarray(fa, dtype=np.uint8)
                upload_arrays.append(arr_a)
                upload_slots.append(sa)
            sb, up_b = self._alloc_slot(kb, pinned)
            if up_b:
                arr_b = np.ascontiguousarray(fb, dtype=np.uint8)
                upload_arrays.append(arr_b)
                upload_slots.append(sb)
            slot_a.append(sa)
            slot_b.append(sb)
            n = len(pts)
            pt_off.append(total_pts)
            pt_cnt.append(n)
            if n > 0:
                pts_chunks.append(np.ascontiguousarray(pts, dtype=np.float32).reshape(n, 2))
                total_pts += n

        n_up = len(upload_arrays)
        up_ptrs_arr = (ctypes.c_void_p * max(1, n_up))(*(a.ctypes.data for a in upload_arrays))
        up_slots_np = np.array(upload_slots, dtype=np.int32)
        sa_np = np.array(slot_a, dtype=np.int32)
        sb_np = np.array(slot_b, dtype=np.int32)
        off_np = np.array(pt_off, dtype=np.int32)
        cnt_np = np.array(pt_cnt, dtype=np.int32)
        pts_np = np.concatenate(pts_chunks, axis=0) if pts_chunks else np.zeros((0, 2), dtype=np.float32)
        out_np = np.empty((total_pts, 4), dtype=np.float32)

        rc = self._lib.rsm_metal_run_batch(
            self._handle,
            n_up,
            up_ptrs_arr,
            up_slots_np.ctypes.data_as(_c_int32_p) if n_up else None,
            len(pairs),
            sa_np.ctypes.data_as(_c_int32_p),
            sb_np.ctypes.data_as(_c_int32_p),
            off_np.ctypes.data_as(_c_int32_p),
            cnt_np.ctypes.data_as(_c_int32_p),
            total_pts,
            pts_np.ctypes.data_as(_c_float_p) if total_pts else None,
            self.half_win,
            self.max_level,
            self.max_iter,
            self.eps2,
            out_np.ctypes.data_as(_c_float_p) if total_pts else None,
        )
        if rc != 0:
            raise RuntimeError(f"rsm_metal_run_batch failed with code {rc}")

        results: list[tuple[np.ndarray, np.ndarray, np.ndarray]] = []
        for off, cnt in zip(pt_off, pt_cnt):
            if cnt == 0:
                results.append((np.zeros((0, 2), dtype=np.float64), np.zeros(0, dtype=np.float64), np.zeros(0, dtype=bool)))
            else:
                sl = out_np[off:off + cnt]
                results.append((sl[:, :2].astype(np.float64), sl[:, 2].astype(np.float64), sl[:, 3] > 0.5))
        return results
