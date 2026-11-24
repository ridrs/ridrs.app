#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Evidence for one spot of analysis.json, to compare the decoded route with the video.

    $PY evidence.py <run> spot S03 [--pad 10] [--frames 12] [--video HD.mp4]   frames.jpg, map.png, series.png, nodes.json
    $PY evidence.py <run> frames 351,352,353.5 [--name x]                           extra frames at exact video seconds
    $PY evidence.py <run> overlay 352 [--name x]                                    motion / far-feature points on the frame (inspect-frame)
    $PY evidence.py <run> window 580 640 [--name x]                                 like `spot`, for any window (video seconds)

Writes <run>/review/evidence/<spot or name>/. Video-derived: stays local, never published.
Map legend (turn quanta of the 100 m cells, inspect-series): green = turn in video and map, orange = map turn without video turn,
purple = video turn without map turn.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from _lib import Path1D, ffmpeg, fmt_t, jdump, jload, rsm_dir, run_dir, transformer, video_of  # noqa: E402

import matplotlib  # noqa: E402
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

TURN = 20.0   # degrees per 100 m cell that count as a turn quantum


def grab(video: Path, times, width=480):
    """one JPEG per exact video second -> list of image arrays"""
    imgs = []
    with tempfile.TemporaryDirectory() as td:
        for i, tt in enumerate(times):
            f = Path(td) / f"{i}.jpg"
            try:
                ffmpeg("-ss", f"{max(tt, 0):.3f}", "-i", str(video), "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "3", str(f))
            except subprocess.CalledProcessError:
                pass                                      # past the end of the video: the tile stays empty
            imgs.append(plt.imread(f) if f.exists() else None)
    return imgs


def contact(imgs, times, labels, dest: Path, cols=4):
    rows = int(np.ceil(len(imgs) / cols))
    fig, axs = plt.subplots(rows, cols, figsize=(cols * 4.2, rows * 2.6), squeeze=False)
    for ax in axs.flat:
        ax.axis("off")
    for ax, im, tt, lb in zip(axs.flat, imgs, times, labels):
        if im is not None:
            ax.imshow(im)
        ax.set_title(f"{fmt_t(tt)} ({tt:.1f} s) {lb}", fontsize=8)
    fig.tight_layout()
    fig.savefig(dest, dpi=110)
    plt.close(fig)


class Run:
    def __init__(self, rd: Path):
        self.rd, self.run, self.rev = rd, rd / "run", rd / "review"
        self.R = np.load(self.run / "refine" / "result.npz")
        self.G = np.load(self.run / "map" / "graph_real.npz")
        self.S = jload(self.rev / "series.json")
        self.A = jload(self.rev / "analysis.json")
        self.path = Path1D(self.R["sg"], self.R["xy"])
        self.crs = str(self.R["crs"])
        self.to_wgs = transformer(self.crs)

    def pos(self, tt):
        return self.path.xy_at(np.interp(tt, self.R["t"], self.R["s"]))

    def spot(self, sid):
        for sp in self.A["spots"] + self.A["controls"]:
            if sp["id"] == sid:
                return sp
        sys.exit(f"no spot {sid} in analysis.json")


def draw_map(r: Run, t0, t1, dest: Path, title: str):
    R, G = r.R, r.G
    t = R["t"]
    sel = (t >= t0) & (t <= t1)
    tt = t[sel]
    p = r.pos(tt)
    lo, hi = p.min(0) - 250, p.max(0) + 250
    fig, ax = plt.subplots(figsize=(9, 9))
    off, geom = G["edge_off"], G["edge_geom"]
    major = {"motorway", "trunk", "primary", "secondary", "motorway_link", "trunk_link", "primary_link"}
    for k in range(len(off) - 1):
        g = geom[off[k]:off[k + 1]]
        if len(g) < 2 or (g[:, 0].max() < lo[0] or g[:, 0].min() > hi[0] or g[:, 1].max() < lo[1] or g[:, 1].min() > hi[1]):
            continue
        h = str(G["edge_highway"][k])
        ax.plot(g[:, 0], g[:, 1], color="#555" if h in major else "#aaa", lw=2.2 if h in major else 1.0, zorder=1)
        if G["edge_oneway"][k] and len(g) >= 2:
            m = len(g) // 2
            a, b = g[max(m - 1, 0)], g[m]
            ax.annotate("", xy=b, xytext=a, arrowprops=dict(arrowstyle="->", color="#999", lw=0.8), zorder=1)
    # the whole decoded path near the spot
    pg = r.path.xy
    near = (pg[:, 0] > lo[0]) & (pg[:, 0] < hi[0]) & (pg[:, 1] > lo[1]) & (pg[:, 1] < hi[1])
    ax.plot(np.where(near, pg[:, 0], np.nan), np.where(near, pg[:, 1], np.nan), color="#1f6feb", lw=1.2, alpha=0.6, zorder=2, label="dekodierter Pfad")
    sc = ax.scatter(p[:, 0], p[:, 1], c=R["conf"][sel], cmap="RdYlGn", vmin=0, vmax=1, s=18, zorder=4, edgecolor="k", lw=0.3)
    step = max(1, int(round(len(tt) / 14)))
    for i in range(0, len(tt), step):
        ax.annotate(fmt_t(tt[i]), p[i], fontsize=7, xytext=(4, 4), textcoords="offset points", zorder=5)
    # turn quanta of the 100 m cells inside the window
    C = r.S.get("cells") or {}
    done = set()
    for i in range(len(C.get("s", []))):
        if C["t1"][i] < t0 or C["t0"][i] > t1:
            continue
        v, m = abs(C["turn_v"][i]) > TURN, abs(C["turn_m"][i]) > TURN
        if not (v or m):
            continue
        c, lab = ("#2da44e", "Kurve Video + Karte") if v and m else (("#fb8500", "Kurve nur Karte") if m else ("#8250df", "Kurve nur Video"))
        q = r.pos((C["t0"][i] + C["t1"][i]) / 2)[0]
        ax.scatter([q[0]], [q[1]], s=140, color=c, alpha=0.55, zorder=3, label=None if lab in done else lab)
        done.add(lab)
        ax.annotate(f"V{C['turn_v'][i]:.0f}°/K{C['turn_m'][i]:.0f}°", q, fontsize=6, color=c, xytext=(-10, -12), textcoords="offset points")
    hint = (r.A["summary"].get("hints_used") or {}).get("hint_file") or (r.A["summary"]["params"] or {}).get("hint")
    if hint and Path(hint).exists():
        import re
        pts = np.array([(float(b), float(a)) for a, b in re.findall(r'lat="([-\d.]+)"\s+lon="([-\d.]+)"', Path(hint).read_text(errors="ignore"))])
        if len(pts):
            hx, hy = transformer(r.crs, to_wgs=False).transform(pts[:, 0], pts[:, 1])
            ax.plot(hx, hy, "--", color="#cf222e", lw=0.8, alpha=0.6, zorder=2, label="Routen-Vorlage")
    ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_aspect("equal")
    lon, lat = r.to_wgs.transform((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2)
    ax.set_title(f"{title}\nMitte {lat:.5f}, {lon:.5f}; Punkte = Position je Sekunde (Farbe = Sicherheit)", fontsize=9)
    ax.legend(loc="lower left", fontsize=7)
    fig.colorbar(sc, ax=ax, shrink=0.5, label="Sicherheit")
    fig.tight_layout(); fig.savefig(dest, dpi=110); plt.close(fig)


def draw_series(r: Run, t0, t1, dest: Path, title: str):
    S = r.S
    t = np.asarray(S["t"], float)
    sel = (t >= t0) & (t <= t1)
    g = lambda k: np.asarray([np.nan if x is None else x for x in S[k]], float)[sel] if k in S and S[k] is not None and len(S[k]) == len(t) else None
    tt = t[sel]
    # map-implied yaw rate from the decoded path
    s_t = np.interp(tt, r.R["t"], r.R["s"])
    hd = r.path.heading_at(s_t)
    yaw_map = np.gradient(np.unwrap(np.radians(hd)), tt) * 180 / np.pi if len(tt) > 2 else None
    fig, ax = plt.subplots(4, 1, figsize=(11, 9), sharex=True)
    for k, lab in (("speed_fused", "Geschw. fusioniert"), ("speed_vms", "Geschw. vms (nominal)")):
        y = g(k)
        if y is not None:
            ax[0].plot(tt, y, label=lab)
    ax[0].set_ylabel("m/s"); ax[0].legend(fontsize=7)
    for k, lab in (("yaw_vms", "Gier vms"), ("yaw_far", "Gier Fernmerkmale"), ("yaw", "Gier genutzt")):
        y = g(k)
        if y is not None:
            ax[1].plot(tt, y, label=lab, lw=1)
    if yaw_map is not None:
        # compass heading grows clockwise; the video yaw is positive to the left, so the map yaw is negated
        ax[1].plot(tt, -yaw_map, "k--", lw=1, label="Gier aus Karte (Pfad)")
    ax[1].axhline(0, color="#ccc", lw=0.5)
    ax[1].set_ylabel("°/s (links +)"); ax[1].legend(fontsize=7)
    for k, lab in (("conf", "Sicherheit"), ("p_search", "Routensuche")):
        y = g(k)
        if y is not None:
            ax[2].plot(tt, y, label=lab)
    y = g("s_sd")
    if y is not None:
        a2 = ax[2].twinx(); a2.plot(tt, y, color="#999", lw=0.8); a2.set_ylabel("s_sd m", fontsize=7)
    ax[2].set_ylim(-0.05, 1.05); ax[2].legend(fontsize=7)
    y = g("inliers")
    if y is not None:
        ax[3].plot(tt, y, color="#1f6feb", lw=1, label="Inlier (Anzahl, links)")
    ax[3].set_ylabel("Inlier")
    a3 = ax[3].twinx()
    for k, lab, c in (("usable", "Bewegung nutzbar", "#2da44e"), ("far_ok", "Fernmerkmale ok", "#fb8500")):
        y = g(k)
        if y is not None:
            a3.plot(tt, y, label=lab, lw=1, color=c)
    for k, c in (("in_gap", "#fb8500"), ("tunnel", "#555"), ("cut", "#cf222e"), ("odofail", "#8250df")):
        y = g(k)
        if y is not None and np.nansum(y) > 0:
            a3.fill_between(tt, 0, np.nan_to_num(y) > 0, color=c, alpha=0.15, step="mid", label=k)
    a3.set_ylim(-0.05, 1.05)
    ax[3].legend(fontsize=7, loc="upper left"); a3.legend(fontsize=7, ncol=3, loc="upper right")
    ax[3].set_xlabel("Videosekunde")
    ax[0].set_title(f"{title}  (Vorzeichen der Gier: prüfen, ob Video- und Kartengier gleich gerichtet sind)", fontsize=9)
    fig.tight_layout(); fig.savefig(dest, dpi=100); plt.close(fig)


def nodes_near(r: Run, t0, t1, dest: Path, radius=60.0):
    """OSM junction nodes (degree >= 3) near the decoded positions, with street names and the second the route passes them:
    candidates for checkpoints (place checkpoints on these nodes, as in regress_landmarks.json)"""
    G = r.G
    deg = np.bincount(np.concatenate([G["edge_u"], G["edge_v"]]), minlength=len(G["node_xy"]))
    t = r.R["t"]
    tt = t[(t >= t0) & (t <= t1)]
    p = r.pos(tt)
    from scipy.spatial import cKDTree
    d, i = cKDTree(p).query(G["node_xy"], distance_upper_bound=radius)
    out = []
    for n in np.where(np.isfinite(d) & (deg >= 3))[0]:
        names = sorted({str(G["edge_name"][e]) for e in np.where((G["edge_u"] == n) | (G["edge_v"] == n))[0] if str(G["edge_name"][e])})
        hws = sorted({str(G["edge_highway"][e]) for e in np.where((G["edge_u"] == n) | (G["edge_v"] == n))[0]})
        lon, lat = r.to_wgs.transform(*G["node_xy"][n])
        out.append(dict(osm_node=int(G["node_osm"][n]), lat=round(lat, 6), lon=round(lon, 6), degree=int(deg[n]), streets=names, highway=hws,
                        route_t=float(tt[i[n]]), route_dist_m=round(float(d[n]), 1)))
    out.sort(key=lambda x: x["route_t"])
    jdump(out, dest)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("what", choices=["spot", "frames", "overlay", "window"])
    ap.add_argument("args", nargs="+")
    ap.add_argument("--pad", type=float, default=10.0)
    ap.add_argument("--frames", type=int, default=12)
    ap.add_argument("--video", default=None, help="another copy of the same video (e.g. HD) for sharper frames; same timing")
    ap.add_argument("--name", default=None)
    ap.add_argument("--rsm", default=None)
    a = ap.parse_args()
    rd = run_dir(a.run)
    r = Run(rd)
    video = Path(a.video) if a.video else video_of(rd)

    if a.what in ("spot", "window"):
        if a.what == "spot":
            sp = r.spot(a.args[0]); name = a.name or sp["id"]; t0, t1 = sp["t0"] - a.pad, sp["t1"] + a.pad
        else:
            t0, t1 = float(a.args[0]), float(a.args[1]); name = a.name or f"w{int(t0)}-{int(t1)}"
        t0, t1 = max(t0, float(r.R["t"][0])), min(t1, float(r.R["t"][-1]))
        out = r.rev / "evidence" / name
        out.mkdir(parents=True, exist_ok=True)
        times = list(np.linspace(t0, t1, a.frames))
        conf = np.interp(times, r.R["t"], r.R["conf"])
        contact(grab(video, times), times, [f"conf {c:.2f}" for c in conf], out / "frames.jpg")
        title = f"{rd.name} {name} {fmt_t(t0)}–{fmt_t(t1)}"
        draw_map(r, t0, t1, out / "map.png", title)
        draw_series(r, t0, t1, out / "series.png", title)
        nodes = nodes_near(r, t0, t1, out / "nodes.json")
        jdump(dict(name=name, t0=t0, t1=t1, frame_times=times, video=str(video), junctions=len(nodes)), out / "info.json")
        print(json.dumps(dict(dir=str(out), files=["frames.jpg", "map.png", "series.png", "nodes.json"], junctions=len(nodes))))
    elif a.what == "frames":
        times = [float(x) for x in ",".join(a.args).split(",") if x]
        out = r.rev / "evidence" / (a.name or "extra")
        out.mkdir(parents=True, exist_ok=True)
        dest = out / f"frames_{int(times[0])}-{int(times[-1])}.jpg"
        conf = np.interp(times, r.R["t"], r.R["conf"])
        contact(grab(video, times, 640), times, [f"conf {c:.2f}" for c in conf], dest, cols=min(4, len(times)))
        print(dest)
    else:
        tt = float(a.args[0])
        rsm = rsm_dir(a.rsm)
        res = subprocess.run([str(rsm / ".venv/bin/python"), "-m", "rsm.pipeline", "inspect-frame", "--out", str(r.run), "--t", str(tt)],
                             cwd=rsm, capture_output=True, text=True)
        ev = [json.loads(x) for x in res.stdout.splitlines() if x.startswith("{")]
        ev = next((x for x in ev if x.get("type") == "result"), None)
        if not ev:
            sys.exit(f"inspect-frame failed: {res.stderr[-500:]}")
        out = r.rev / "evidence" / (a.name or "extra")
        out.mkdir(parents=True, exist_ok=True)
        W, H = ev["frame_width"], ev["frame_height"]
        im = grab(Path(ev.get("video") or video), [tt], W)[0]
        fig, ax = plt.subplots(figsize=(10, 10 * H / W))
        if im is not None:
            ax.imshow(im, extent=(0, W, H, 0))
        m = ev.get("motion") or {}
        cols = {0: "#cf222e", 1: "#2da44e", 2: "#d63384"}
        for x, y, dx, dy, *rest in m.get("points", []):
            st = int(rest[0]) if rest else 1
            ax.arrow(x, y, dx * 4, dy * 4, color=cols.get(st, "#999"), width=0.6, head_width=3)
        if m.get("horizon"):
            ax.axhline(m["horizon"], color="#fb8500", lw=1, ls="--")
        for b in (ev.get("rotation") or {}).get("bands", []):
            for pnt in b.get("points", []):
                ax.plot(pnt[0], pnt[1], "o", ms=3, color="#1f6feb" if b.get("ok") else "#8b949e")
        fit = m.get("fit") or {}
        ax.set_title(f"{fmt_t(tt)}: Bewegung {m.get('tracked')} Punkte, Inlier {fit.get('inliers')}, rms {fit.get('rms')}, "
                     f"{fit.get('speed_ms')} m/s nominal, Gier {fit.get('yaw_deg_s')} °/s; Verkehr {((m.get('traffic') or {}).get('state'))}; "
                     f"Fernbänder ok: {[b.get('ok') for b in (ev.get('rotation') or {}).get('bands', [])]} ({[b.get('why') for b in (ev.get('rotation') or {}).get('bands', [])]})",
                     fontsize=8)
        ax.set_xlim(0, W); ax.set_ylim(H, 0); ax.axis("off")
        dest = out / f"overlay_{tt:.1f}.png"
        fig.tight_layout(); fig.savefig(dest, dpi=110); plt.close(fig)
        jdump(ev, out / f"overlay_{tt:.1f}.json")
        print(dest)


if __name__ == "__main__":
    main()
