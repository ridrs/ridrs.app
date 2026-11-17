# SPDX-License-Identifier: AGPL-3.0-or-later
"""Candidate-path files and loader.

work/osm/<slug>/paths_L<metres>.npz  (+ paths_L<metres>.meta.json), all arrays flat with offset vectors (CSR):
  edges int32 [sum]        directed edge ids of every path, concatenated (index into network.npz edge arrays)
  off int64 [n+1]          path i uses edges[off[i]:off[i+1]]
  total_len float64 [n]    full length of those edges, m (>= L; the polyline/turn sequence is cut at exactly L)
  turn_off int64 [n+1]     path i has turns turn_*[turn_off[i]:turn_off[i+1]]
  turn_sign int8, turn_angle_deg f32 (signed, left +), turn_len_m, turn_s0_m, turn_s1_m, turn_peak_deg_per_m f32, turn_clipped bool
meta: L, n_enumerated, n_stored, sampling ("all" | "paths" | "starts"), seed, turn_params, expansions, seconds, ...
Distances are metres along the path from its start NODE (arc length of the UTM polyline), left turn positive, rsm convention.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from rsm.odometry.turns import Turn

from .graph import NetGraph
from .paths import path_polyline

TURN_FIELDS = (("turn_sign", np.int8), ("turn_angle_deg", np.float32), ("turn_len_m", np.float32), ("turn_s0_m", np.float32),
               ("turn_s1_m", np.float32), ("turn_peak_deg_per_m", np.float32), ("turn_clipped", np.bool_))


def save_paths(path: Path, L: float, edges, off, total_len, turns_per_path: list[list[Turn]], meta: dict) -> None:
    toff = np.zeros(len(turns_per_path) + 1, np.int64)
    toff[1:] = np.cumsum([len(t) for t in turns_per_path])
    flat = [t for ts in turns_per_path for t in ts]
    cols = {
        "turn_sign": [t.sign for t in flat], "turn_angle_deg": [t.angle_deg for t in flat], "turn_len_m": [t.length_m for t in flat],
        "turn_s0_m": [t.s_start for t in flat], "turn_s1_m": [t.s_end for t in flat], "turn_peak_deg_per_m": [t.peak_deg_per_m for t in flat],
        "turn_clipped": [t.clipped for t in flat]}
    arrs = {k: np.array(cols[k], dt) for k, dt in TURN_FIELDS}
    np.savez_compressed(path, edges=np.asarray(edges, np.int32), off=np.asarray(off, np.int64), total_len=np.asarray(total_len), turn_off=toff, **arrs)
    path.with_suffix(".meta.json").write_text(json.dumps({"L": L, **meta}, indent=1))


@dataclass
class PathStore:
    g: NetGraph
    L: float
    slug: str
    z: dict
    meta: dict

    @staticmethod
    def load(folder: Path, L: int, g: NetGraph | None = None) -> "PathStore":
        folder = Path(folder)
        g = g or NetGraph.load(folder / "network.npz")
        f = folder / f"paths_L{int(L)}.npz"
        z = dict(np.load(f))
        return PathStore(g, float(L), folder.name, z, json.loads(f.with_suffix(".meta.json").read_text()))

    def __len__(self) -> int:
        return len(self.z["off"]) - 1

    def edges(self, i: int) -> np.ndarray:
        return self.z["edges"][self.z["off"][i]:self.z["off"][i + 1]]

    def way_ids(self, i: int) -> list[int]:
        w = self.g.edge_way[self.edges(i)]
        return [int(x) for k, x in enumerate(w) if k == 0 or x != w[k - 1]]

    def turns(self, i: int) -> list[dict]:
        a, b = self.z["turn_off"][i], self.z["turn_off"][i + 1]
        return [{"sign": int(self.z["turn_sign"][j]), "angle_deg": float(self.z["turn_angle_deg"][j]), "length_m": float(self.z["turn_len_m"][j]),
                 "s_start": float(self.z["turn_s0_m"][j]), "s_end": float(self.z["turn_s1_m"][j]), "clipped": bool(self.z["turn_clipped"][j])}
                for j in range(a, b)]

    def polyline(self, i: int) -> np.ndarray:
        """(N,2) UTM metres, cut at exactly L (for matching: translate/rotate freely, it is a local metric frame)."""
        return path_polyline(self.g, self.edges(i), self.L)

    def get(self, i: int) -> dict:
        return {"id": f"{self.slug}-L{int(self.L)}-{i:07d}", "way_ids": self.way_ids(i), "edges": self.edges(i).tolist(), "length_m": self.L,
                "edges_length_m": float(self.z["total_len"][i]), "turns": self.turns(i)}
