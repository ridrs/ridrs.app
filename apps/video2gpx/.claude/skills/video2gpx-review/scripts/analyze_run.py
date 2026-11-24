#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Analyse a finished video2gpx run: run summary, weak stretches with their measured causes (rsm.pipeline inspect-series),
OSM plausibility checks of the decoded path, and a ranked list of spots to check against the video.

    $PY analyze_run.py <youtube-id | video2gpx-runs/<id>> [--rsm DIR] [--max-spots 20] [--controls 3]

Writes <id>/review/series.json, analysis.json, analysis.md. Read only on the run itself.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from _lib import Path1D, fmt_t, jdump, jload, rsm_dir, run_dir, transformer  # noqa: E402

VMAX = dict(bike=25.0, motorcycle=50.0, car=50.0)
MINOR = {"residential", "living_street", "service", "unclassified", "track"}
NOT_FOR_MOTOR = {"cycleway", "footway", "path", "pedestrian", "steps", "bridleway"}
NOT_FOR_BIKE = {"motorway", "motorway_link", "trunk", "trunk_link"}


def runs(mask: np.ndarray, t: np.ndarray, min_len: int = 1):
    """contiguous True runs of a per-second mask -> [(t0, t1, i0, i1)]"""
    out, i, n = [], 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j + 1 < n and mask[j + 1]:
                j += 1
            if j - i + 1 >= min_len:
                out.append((float(t[i]), float(t[j]), i, j))
            i = j + 1
        else:
            i += 1
    return out


def edge_segments(G):
    """every straight piece of every OSM edge: start xy, direction (unit), length, edge index"""
    off, geom = G["edge_off"], G["edge_geom"]
    a, b, e = [], [], []
    for k in range(len(off) - 1):
        g = geom[off[k]:off[k + 1]]
        if len(g) >= 2:
            a.append(g[:-1]); b.append(g[1:]); e.append(np.full(len(g) - 1, k))
    a, b, e = np.vstack(a), np.vstack(b), np.concatenate(e)
    d = b - a
    ln = np.hypot(d[:, 0], d[:, 1])
    ok = ln > 0.05
    return a[ok], d[ok] / ln[ok, None], ln[ok], e[ok]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--rsm", default=None)
    ap.add_argument("--max-spots", type=int, default=20)
    ap.add_argument("--controls", type=int, default=3, help="confident stretches with turns to check as a control sample")
    a = ap.parse_args()
    rd = run_dir(a.run)
    run, rev = rd / "run", rd / "review"
    rev.mkdir(exist_ok=True)
    rsm = rsm_dir(a.rsm)
    py = rsm / ".venv/bin/python"

    # -- series and weak stretches (the pipeline's own read-only analysis)
    subprocess.run([str(py), "-m", "rsm.pipeline", "inspect-series", "--out", str(run), "--dest", str(rev / "series.json")],
                   cwd=rsm, check=True, stdout=subprocess.DEVNULL)
    S = jload(rev / "series.json")
    Pj = jload(run / "project.json")
    R = np.load(run / "refine" / "result.npz")
    G = np.load(run / "map" / "graph_real.npz")
    crs = str(R["crs"])
    to_wgs = transformer(crs)
    eff = Pj.get("effective", {})
    vehicle = eff.get("vehicle", "car")
    path = Path1D(R["sg"], R["xy"])

    t, s, conf = R["t"], R["s"], R["conf"]
    extrap, in_still = R["extrap"], R["in_still"]
    dec = ~extrap
    xy = path.xy_at(s)
    lon, lat = to_wgs.transform(xy[:, 0], xy[:, 1])
    v = np.gradient(s, t)
    flags = []

    def flag(t0, t1, check, text, value=None, limit=None, weight=1.0):
        flags.append(dict(t0=float(t0), t1=float(t1), check=check, text=text, value=value, limit=limit, weight=weight))

    # 1 speed and acceleration (Incyclist turns speed jumps into fast-forward / slow motion)
    vmax = VMAX.get(vehicle, 50.0)
    for t0, t1, i, j in runs(dec & (v > vmax), t):
        flag(t0, t1, "speed", f"Geschwindigkeit bis {v[i:j + 1].max() * 3.6:.0f} km/h > {vmax * 3.6:.0f} km/h ({vehicle})", float(v[i:j + 1].max()), vmax, 2.0)
    vs = np.convolve(v, np.ones(3) / 3, mode="same")
    acc = np.gradient(vs, t)
    for t0, t1, i, j in runs(dec & (np.abs(acc) > 6.0), t, 2):
        flag(t0, t1, "accel", f"Beschleunigung {np.abs(acc[i:j + 1]).max():.1f} m/s² über 2 s+ (> 6)", float(np.abs(acc[i:j + 1]).max()), 6.0, 1.0)

    # 2 road class along the path vs the vehicle; fast on minor roads
    hw = R["highway"]
    sg = R["sg"]
    hw_t = hw[np.clip(np.searchsorted(sg, s), 0, len(sg) - 1)]
    bad = NOT_FOR_BIKE if vehicle == "bike" else NOT_FOR_MOTOR
    for t0, t1, i, j in runs(dec & np.isin(hw_t, list(bad)), t, 3):
        flag(t0, t1, "road_class", f"Straßenklasse {hw_t[i]} passt nicht zum Fahrzeug {vehicle}", None, None, 2.0)
    if vehicle != "bike":
        for t0, t1, i, j in runs(dec & np.isin(hw_t, list(MINOR)) & (vs > 22.0), t, 5):
            flag(t0, t1, "minor_fast", f"{vs[i:j + 1].max() * 3.6:.0f} km/h auf {hw_t[i]} (Nebenstraße)", float(vs[i:j + 1].max()), 22.0, 1.0)

    # 3 wrong way on one-way edges, and U-turns on the path (outside roundabouts)
    A, D, L, E = edge_segments(G)
    from scipy.spatial import cKDTree
    tree = cKDTree(A + D * (L[:, None] / 2))
    s_grid = np.arange(sg[0], sg[-1], 5.0)
    pg = path.xy_at(s_grid)
    hd = path.heading_at(s_grid)
    dirv = np.column_stack([np.sin(np.radians(hd)), np.cos(np.radians(hd))])
    dist, k = tree.query(pg, k=4, distance_upper_bound=8.0)
    wrong = np.zeros(len(s_grid), bool)
    for c in range(4):
        okc = np.isfinite(dist[:, c])
        kk = np.where(okc, k[:, c], 0)
        one = okc & G["edge_oneway"][E[kk]]
        dot = (D[kk] * dirv).sum(1)
        wrong |= one & (dot < -0.7) & (dist[:, c] < 5.0)
    s2t = lambda x: float(np.interp(x, s, t))
    for i0, i1 in [(r[2], r[3]) for r in runs(wrong, s_grid, 6)]:
        flag(s2t(s_grid[i0]), s2t(s_grid[i1]), "oneway", f"Pfad {s_grid[i1] - s_grid[i0]:.0f} m gegen eine Einbahnstraße (OSM-Richtung prüfen)", None, None, 2.0)
    rb = R["roundabout"][np.clip(np.searchsorted(sg, s_grid), 0, len(sg) - 1)]
    dh = np.abs((np.roll(hd, -8) - hd + 180) % 360 - 180)            # heading change over 40 m
    for i0, i1 in [(r[2], r[3]) for r in runs((dh > 150) & ~rb, s_grid)]:
        flag(s2t(s_grid[i0]), s2t(s_grid[min(i1 + 8, len(s_grid) - 1)]), "uturn", "Wende (> 150° auf 40 m) außerhalb eines Kreisverkehrs", float(dh[i0:i1 + 1].max()), 150.0, 1.5)

    # 3b turn excess: the path turns far more than the video in 12 s. It catches loops through split carriageways and junction triangles that
    # the chord test misses, when the way out and the way back lie 10-25 m apart (Nice-Monaco 39:26, 2026-11-19). Real U-turns are not hit,
    # because the video turns as well.
    tS = np.asarray(S.get("t", []), float)
    yaw = np.nan_to_num(np.asarray([np.nan if v_ is None else v_ for v_ in S.get("yaw", [])], float))
    if len(tS) == len(yaw) and len(tS):
        g1 = np.arange(sg[0], sg[-1], 1.0)
        dh1 = np.degrees(np.diff(np.unwrap(np.radians(path.heading_at(g1, 2.0)))))
        cabs = np.concatenate([[0.0], np.cumsum(np.abs(dh1))])
        hits = []
        for a0 in np.arange(t[0], t[-1] - 12, 2.0):
            i0, i1 = np.searchsorted(g1, np.interp([a0, a0 + 12], t, s))
            pa = cabs[min(i1, len(cabs) - 1)] - cabs[min(i0, len(cabs) - 1)]
            # the video's TOTAL turn (sum of |yaw| per second), not its net turn: on a roundabout left and right cancel in the net and the
            # check fired on correct roundabouts (Nice-Monaco 59:30, 1:09:54; 2026-11-19)
            va = np.abs(yaw[(tS >= a0) & (tS < a0 + 12)]).sum()
            if pa >= 170 and pa - va >= 150:
                hits.append((a0, pa, va))
        merged = []
        for h_ in hits:
            if merged and h_[0] <= merged[-1][1] + 4:
                merged[-1][1] = h_[0] + 12
                merged[-1][2] = max(merged[-1][2], h_[1] - h_[2])
            else:
                merged.append([h_[0], h_[0] + 12, h_[1] - h_[2]])
        for a0, a1, ex in merged:
            flag(a0, a1, "turn_excess", f"Pfad dreht {ex:.0f}° mehr als das Video in 12 s (Gesamtdrehung; Schleife oder Wende ohne Gegenstück im Video)", float(ex), 150.0, 2.5)

    # 4 curves of the video vs the map at HIGH confidence: the main sign of a confident but wrong route
    C = S.get("cells") or {}
    for i in range(len(C.get("s", []))):
        tv, tm = abs(C["turn_v"][i]), abs(C["turn_m"][i])
        c0, c1 = C["t0"][i], C["t1"][i]
        sel = (t >= c0) & (t <= c1)
        cm = float(conf[sel].mean()) if sel.any() else 0.0
        if cm >= 0.9 and abs(tv - tm) > max(45.0, 0.5 * max(tv, tm)):
            flag(c0, c1, "curve_conf", f"Kurven passen nicht trotz Sicherheit {cm:.2f}: Video {tv:.0f}°, Karte {tm:.0f}° auf 100 m", abs(tv - tm), 45.0, 2.5)

    # 5 distance to the route hint (an approximate atlas / user route: weak evidence)
    hu = Pj.get("hints_used") or {}
    hint = hu.get("hint_file") or Pj.get("params", {}).get("hint")
    if hint and Path(hint).exists():
        import re
        txt = Path(hint).read_text(errors="ignore")
        pts = np.array([(float(b), float(a)) for a, b in re.findall(r'lat="([-\d.]+)"\s+lon="([-\d.]+)"', txt)] or
                       [(float(b), float(a)) for b, a in re.findall(r'lon="([-\d.]+)"\s+lat="([-\d.]+)"', txt)])
        if len(pts) > 1:
            hx, hy = transformer(crs, to_wgs=False).transform(pts[:, 0], pts[:, 1])
            hp = np.column_stack([hx, hy])
            seg = np.linspace(0, 1, 20)[:, None, None]
            dense = (hp[:-1] + seg * (hp[1:] - hp[:-1])).reshape(-1, 2)
            dh_m = cKDTree(dense).query(xy)[0]
            for t0, t1, i, j in runs(dec & (dh_m > 500), t, 30):
                flag(t0, t1, "hint_far", f"bis {dh_m[i:j + 1].max():.0f} m neben der Routen-Vorlage (Vorlage ist nur ungefähr)", float(dh_m[i:j + 1].max()), 500.0, 1.0)

    # 6 standstill on a motorway (possible, but worth a look)
    for t0, t1, i, j in runs(dec & in_still & np.isin(hw_t, ["motorway", "trunk"]), t, 10):
        flag(t0, t1, "still_fast_road", f"Stillstand {t1 - t0:.0f} s auf {hw_t[i]}", None, None, 0.5)

    # -- spots: weak stretches + flags, merged when closer than 15 s
    items = []
    for st in S.get("stretches", []):
        items.append(dict(t0=st["t0"], t1=st["t1"], src="stretch", kind=st["kind"], causes=st["causes"], conf_min=st.get("conf_min"),
                          weight=(2.0 if st["kind"] == "none" else 1.0) + min(st["dur"], 120) / 60))
    for f in flags:
        items.append(dict(t0=f["t0"], t1=f["t1"], src="flag", flag=f, weight=f["weight"]))
    items.sort(key=lambda x: x["t0"])
    spots = []
    for it in items:
        if spots and it["t0"] <= spots[-1]["t1"] + 15:
            sp = spots[-1]
            sp["t1"] = max(sp["t1"], it["t1"]); sp["items"].append(it); sp["weight"] += it["weight"]
        else:
            spots.append(dict(t0=it["t0"], t1=it["t1"], items=[it], weight=it["weight"]))

    # control sample: confident stretches with clear turns, to estimate the share of confident-but-wrong
    ctrl = []
    if C.get("s"):
        cand = [i for i in range(len(C["s"])) if min(abs(C["turn_v"][i]), abs(C["turn_m"][i])) > 45]
        cand = [i for i in cand if all(not (C["t0"][i] <= sp["t1"] + 30 and C["t1"][i] >= sp["t0"] - 30) for sp in spots)]
        for i in [cand[int(q)] for q in np.linspace(0, len(cand) - 1, min(a.controls, len(cand)))] if cand else []:
            ctrl.append(dict(t0=C["t0"][i], t1=C["t1"][i], items=[], weight=0.0, control=True))

    def describe(sp):
        sel = (t >= sp["t0"]) & (t <= sp["t1"])
        mid = int(np.clip(np.searchsorted(t, (sp["t0"] + sp["t1"]) / 2), 0, len(t) - 1))
        names = sorted({str(n) for n in G["edge_name"][E[tree.query(path.xy_at(np.linspace(s[sel].min(), s[sel].max(), 8)))[1]]] if str(n)}) if sel.any() else []
        sp.update(conf_min=float(conf[sel].min()) if sel.any() else None, conf_mean=float(conf[sel].mean()) if sel.any() else None,
                  lat=float(lat[mid]), lon=float(lon[mid]), s0=float(s[sel].min()) if sel.any() else None, s1=float(s[sel].max()) if sel.any() else None,
                  roads=names[:6], extrapolated=bool(extrap[sel].any()) if sel.any() else False)
        return sp

    # stable ids: a re-analysis must not renumber spots that evidence folders, verdicts.json and the report already refer to.
    # Known spots (previous analysis.json, verdicts.json) keep their id, matched by time overlap. A known spot that the new ranking would
    # drop is kept (its review exists). New spots get the next free number. Known control spots are kept as they are.
    prev = {}
    for f_ in (rev / "analysis.json", rev / "verdicts.json"):
        if f_.exists():
            try:
                d_ = jload(f_)
            except ValueError:
                continue
            for x in (d_.get("spots", []) + d_.get("controls", [])) if isinstance(d_, dict) else d_:
                k = x.get("id") or x.get("spot")
                if k and k[0] in "SK":
                    prev[k] = (float(x["t0"]), float(x["t1"]))
    ov = lambda sp, w: min(sp["t1"], w[1] + 5) - max(sp["t0"], w[0] - 5)
    checked, used = [], set()
    for k, w in sorted(prev.items()):
        if k[0] != "S":
            continue
        best = max((sp for sp in spots if id(sp) not in used), key=lambda sp: ov(sp, w), default=None)
        if best is not None and ov(best, w) > 0:
            used.add(id(best)); best["id"] = k; checked.append(best)
        else:
            checked.append(dict(t0=w[0], t1=w[1], items=[], weight=0.0, id=k, kept=True))
    rest = sorted((sp for sp in spots if id(sp) not in used), key=lambda x: -x["weight"])
    nxt = max([int(k[1:]) for k in prev if k[0] == "S"] or [0]) + 1
    for sp in rest[:max(0, a.max_spots - len(checked))]:
        sp["id"] = f"S{nxt:02d}"; nxt += 1; checked.append(sp)
    rest = rest[max(0, a.max_spots - len(checked)):] if len(checked) < a.max_spots else [sp for sp in rest if "id" not in sp]
    # a new spot with a strong flag (turn_excess, curve_conf, oneway, road_class) is always listed, even beyond max_spots
    for sp in list(rest):
        if any(it["src"] == "flag" and it["flag"]["check"] in ("turn_excess", "curve_conf", "oneway", "road_class") for it in sp["items"]):
            sp["id"] = f"S{nxt:02d}"; nxt += 1; checked.append(sp); rest.remove(sp)
    checked.sort(key=lambda x: x["t0"])
    for sp in checked:
        describe(sp)
    kprev = sorted((k, w) for k, w in prev.items() if k[0] == "K")
    if kprev:
        ctrl = [dict(t0=w[0], t1=w[1], items=[], weight=0.0, control=True, id=k) for k, w in kprev]
    for n, sp in enumerate(ctrl, 1):
        sp.setdefault("id", f"K{n:02d}")
        describe(sp)

    rs = Pj.get("steps", {})
    summary = dict(
        run=str(run), video=Pj["params"]["video"], pipeline_hash=Pj.get("pipeline_hash"), verdict=Pj.get("verdict"),
        verdict_detail=Pj.get("verdict_detail"), effective=eff, params={k: Pj["params"].get(k) for k in ("bbox", "vehicle", "hint", "start_bbox", "end_bbox", "intro_end", "anchors")},
        hints_used=hu, decoded_s=float(dec.sum()), duration_s=float(t[-1] - t[0]), route_km=float((s[dec].max() - s[dec].min()) / 1000) if dec.any() else 0,
        conf_mean=float(conf[dec].mean()) if dec.any() else 0, conf_below_half=float((conf[dec] < 0.5).mean()) if dec.any() else 0,
        steps={k: dict(seconds=v.get("seconds"), peak_gb=v.get("peak_gb"), statuses=[(x.get("signal"), x.get("level"), x.get("message")) for x in v.get("statuses", [])]) for k, v in rs.items()},
        n_stretches=len(S.get("stretches", [])), n_flags=len(flags), odofail_spans=S.get("odofail_spans"), cuts=S.get("cuts"), f_eff=S.get("f_eff"), kappa=S.get("kappa"))
    jdump(dict(summary=summary, spots=checked, controls=ctrl, unchecked=[dict(t0=x["t0"], t1=x["t1"], weight=x["weight"]) for x in rest], flags=flags), rev / "analysis.json")

    # -- markdown overview for the reviewer
    L = [f"# Analyse {rd.name}", "", f"- Video: `{summary['video']}`", f"- Pipeline {summary['pipeline_hash']}, Urteil **{summary['verdict']}**"
         f" ({'; '.join((summary['verdict_detail'] or {}).get('reasons', [])) or '-'})",
         f"- Fahrzeug {eff.get('vehicle')}, Verkehrsseite {eff.get('traffic_side')}, f_eff {summary['f_eff']}, kappa {summary['kappa']}",
         f"- Dekodiert {summary['decoded_s'] / 60:.1f} von {summary['duration_s'] / 60:.1f} min, Route {summary['route_km']:.1f} km, "
         f"mittlere Sicherheit {summary['conf_mean']:.2f}, {summary['conf_below_half'] * 100:.0f} % unter 0.5",
         f"- {summary['n_stretches']} schwache Abschnitte, {summary['n_flags']} Plausibilitäts-Hinweise, {len(checked)} Prüfstellen (+{len(rest)} nicht geprüft), {len(ctrl)} Kontrollstellen", "",
         "## Schritte", "", "| Schritt | s | GB | Status |", "|---|---|---|---|"]
    for k, v in summary["steps"].items():
        L.append(f"| {k} | {v['seconds'] or 0:.0f} | {v['peak_gb'] or 0} | " + "<br>".join(f"{sg_}: {lv} – {m}" for sg_, lv, m in v["statuses"]) + " |")
    L += ["", "## Prüfstellen", "", "| Id | Zeit | Dauer | Sicherheit min/mittel | Straßen | Gründe |", "|---|---|---|---|---|---|"]
    for sp in checked + ctrl:
        why = []
        for it in sp["items"]:
            if it["src"] == "stretch":
                why += [f"[{it['kind']}] {c['text']}" for c in it["causes"]]
            else:
                why.append(f"[{it['flag']['check']}] {it['flag']['text']}")
        if sp.get("control"):
            why = ["Kontrolle: sichere Stelle mit Kurven"]
        L.append(f"| {sp['id']} | {fmt_t(sp['t0'])}–{fmt_t(sp['t1'])} | {sp['t1'] - sp['t0']:.0f} s | {sp['conf_min'] or 0:.2f}/{sp['conf_mean'] or 0:.2f} | "
                 f"{', '.join(sp['roads'][:3])} | " + "<br>".join(dict.fromkeys(why)) + " |")
    (rev / "analysis.md").write_text("\n".join(L) + "\n")
    print(f"{rev / 'analysis.md'}: {len(checked)} spots, {len(ctrl)} controls, {len(flags)} flags, {len(S.get('stretches', []))} weak stretches")


if __name__ == "__main__":
    main()
