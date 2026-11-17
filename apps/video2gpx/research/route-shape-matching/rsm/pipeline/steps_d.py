# SPDX-License-Identifier: AGPL-3.0-or-later
"""Worker of step 7 and the retime command: driving line, GPX (1 point per second), route_points.json (rsm.bench.verify_map), project.json."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import sys
from pathlib import Path
from xml.sax.saxutils import escape

import numpy as np

from . import VERSION, config as C, lane as LN, offset as O, verdict as V
from .common import Worker, code_hash, frozen_info, jdump, jload
from .traffic import traffic_side

EPOCH = "2000-01-01T00:00:00Z"
ATTRIB = "(c) OpenStreetMap contributors, ODbL"
RULE = ("driving line: approximation. The OSM centre line of the decoded road is shifted sideways by a fixed offset ({off:.1f} m to the {side} of travel, 0 m on one-way roads, "
        "smoothed kink-free offset curve); the lane position is not measured from the video (refinement planned).")
RULE_MODEL = ("driving line: model, not measured from the video. Lane position of a {vehicle} from the OSM cross-section (tagged width or lanes, else a default width "
              "per road class; {tagged:.0f} % of the route has tagged width or lanes){l2}, {side}-hand traffic; typical uncertainty +-{sd:.1f} m.")
L2_TEXT = "; through bends the line is flattened inside the road as the measured speed suggests"


def line_layer(P: dict) -> str:
    """'fixed' (constant offset, the rule before the lane model) or 'model' (L1 lane model, plus L2 if C.LINE_L2_ON). --offset-m implies fixed."""
    if P.get("offset_m") is not None:
        return "fixed"
    ln = P.get("line") or "auto"
    return C.LINE_DEFAULT if ln == "auto" else ln


def parse_time(s: str | None) -> datetime:
    s = s or EPOCH
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def fmt(dt: datetime) -> str:
    """ISO time in UTC; whole seconds as before, a sub-second time (standstill edges) with milliseconds"""
    if dt.microsecond:
        return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def still_state(R, n: int) -> tuple[np.ndarray, list[tuple[float, float, float, float, float, float]]]:
    """(per point: inside a sure standstill, [(t0, t1, s0, s1, sd, conf)]) from refine/result.npz; old results have none"""
    if "in_still" not in R.files:
        return np.zeros(n, bool), []
    return R["in_still"].astype(bool), [tuple(float(x) for x in r) for r in zip(R["still_t0"], R["still_t1"], R["still_s0"], R["still_s1"], R["still_sd"], R["still_conf"])]


def with_edges(pts: list[dict], stills: list[dict]) -> list[dict]:
    """the points plus one point at the start and one at the end of every sure standstill (same position, rsm:edge), in time order; an edge on a whole second
    already present is not doubled"""
    have = {round(p["t"], 3) for p in pts}
    extra = []
    for x in stills:
        base = {k: v for k, v in x.items() if k not in ("t0", "t1")}
        for t, kind in ((x["t0"], "standstill_start"), (x["t1"], "standstill_end")):
            if round(t, 3) not in have:
                extra.append(dict(base, t=float(t), in_gap=False, extrapolated=False, motion_state="standstill", edge=kind))
    return sorted(pts + extra, key=lambda p: p["t"])


def motion_state(in_still: bool, in_gap: bool) -> str:
    return "standstill" if in_still else ("gap" if in_gap else "driving")


def hints_xml(h) -> str:
    """GPX metadata of a run with area hints: 'with route hint' etc., so that results with hints can be told from blind ones"""
    if not h:
        return ""
    box = lambda b: ",".join(f"{x:.6f}" for x in b)
    x = ["<rsm:with_hints>1</rsm:with_hints>"]
    if h.get("route_hint_applied") or h.get("hint_file"):
        x.append(f'<rsm:route_hint file="{escape(str(h.get("hint_file")))}" buffer_m="{h.get("buffer_m"):.0f}" applied="{int(bool(h.get("route_hint_applied")))}" fallback_used="{int(bool(h.get("fallback_used")))}"/>')
    if h.get("start_bbox"):
        x.append(f'<rsm:start_frame bbox="{box(h["start_bbox"])}" tol_m="{h.get("tol_m"):.0f}" applied="{int(bool(h.get("frames_applied")))}"/>')
    if h.get("end_bbox"):
        x.append(f'<rsm:end_frame bbox="{box(h["end_bbox"])}" tol_m="{h.get("tol_m"):.0f}" applied="{int(bool(h.get("frames_applied")))}"/>')
    return "".join(x)


def pipe_xml(p) -> str:
    return f'<rsm:pipeline_hash>{p}</rsm:pipeline_hash>' if p else ""


def cuts_xml(c) -> str:
    """GPX metadata of an edited video (rsm.pipeline.cuts): the cut times (video seconds) and the skipped intro; nothing for a video without cuts"""
    if not c:
        return ""
    intro = f' intro_skipped_s="{c["intro_end"]:.2f}"' if c.get("intro_end") is not None else ""
    return f'<rsm:cuts n="{len(c["times"])}"{intro}>' + " ".join(f"{t:.2f}" for t in c["times"]) + "</rsm:cuts>"


def cut_plan(d: Path) -> dict | None:
    """cuts of the run for the GPX: {times, intro_end, breaks}; breaks = video seconds at which a new <trkseg> starts (the position jumps there). None: no cuts"""
    f = d / "rotation" / "cuts.json"
    if not f.exists():
        return None
    c = jload(f)
    if not c.get("cut_times") and c.get("intro_end") is None:      # an intro set by hand counts without cuts
        return None
    rs = jload(d / "refine" / "summary.json") if (d / "refine" / "summary.json").exists() else {}
    out = dict(times=[float(t) for t in c["cut_times"]], intro_end=c.get("intro_end"), breaks=[float(sp[1]) for sp in rs.get("cut_spans", [])])
    if c.get("intro_source") == "user":
        out["intro_source"] = "user"
    return out


def apply_cut_plan(pts: list[dict], c: dict | None) -> list[dict]:
    """start rule: points up to the end of a skipped intro are not part of the route (the video time stays the time base)"""
    if not c or c.get("intro_end") is None:
        return pts
    return [p for p in pts if p["t"] > c["intro_end"]]


def _segments(pts: list[dict], breaks) -> list[list[dict]]:
    out, cur, bi = [], [], sorted(breaks or [])
    k = 0
    for p in pts:
        while k < len(bi) and bi[k] <= p["t"]:
            if cur:
                out.append(cur); cur = []
            k += 1
        cur.append(p)
    if cur or not out:
        out.append(cur)
    return out


def write_gpx(path: Path, pts: list[dict], start: datetime, meta: dict) -> None:
    h = (f'<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="rsm.pipeline {VERSION}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:rsm="https://ridrs.org/rsm/1">\n'
         f'<metadata><name>{escape(meta["name"])}</name><desc>{escape(meta["rule"])} Map data {ATTRIB}.</desc>'
         f'<copyright author="OpenStreetMap contributors"><year>2026</year><license>https://opendatacommons.org/licenses/odbl/</license></copyright>'
         f'<time>{fmt(start)}</time>'
         f'<extensions><rsm:verdict>{meta["verdict"]}</rsm:verdict><rsm:verdict_basis>{meta["basis"]}</rsm:verdict_basis><rsm:driving_line>{meta.get("line", "approximation")}</rsm:driving_line><rsm:offset_m>{meta["offset_m"]}</rsm:offset_m>'
         f'<rsm:traffic_side>{meta["side"]}</rsm:traffic_side><rsm:vehicle>{meta["vehicle"]}</rsm:vehicle>{hints_xml(meta.get("hints"))}{cuts_xml(meta.get("cuts"))}{pipe_xml(meta.get("pipeline"))}<rsm:attribution>{escape(ATTRIB)}</rsm:attribution></extensions></metadata>\n'
         f'<trk><name>{escape(meta["name"])}</name><trkseg>\n')
    row = lambda p: (f'<trkpt lat="{p["lat"]:.7f}" lon="{p["lon"]:.7f}"><time>{fmt(start + timedelta(seconds=round(p["t"], 3)))}</time>'
                     f'<extensions><rsm:confidence>{p["confidence"]:.3f}</rsm:confidence><rsm:in_gap>{int(p["in_gap"])}</rsm:in_gap><rsm:extrapolated>{int(p["extrapolated"])}</rsm:extrapolated>'
                     + (f'<rsm:state>{p["motion_state"]}</rsm:state>' if "motion_state" in p else "") + (f'<rsm:edge>{p["edge"]}</rsm:edge>' if "edge" in p else "")
                     + '</extensions></trkpt>')
    # one <trkseg> per piece between scene cuts (GPX: a new segment where the track is not continuous); a video without cuts has exactly one, as before
    segs = _segments(pts, (meta.get("cuts") or {}).get("breaks"))
    body = "\n</trkseg><trkseg>\n".join("\n".join(row(p) for p in sg) for sg in segs)
    Path(path).write_text(h + body + "\n</trkseg></trk></gpx>\n")


def gpx_step(d: Path, P: dict, W: Worker):
    from pyproj import Transformer
    R = np.load(d / "refine" / "result.npz")
    fin = jload(d / "route_search" / "vehicle_final.json")
    veh = fin["vehicle"]
    bb = P["bbox"]
    side, region = (P["traffic_side"], "override") if P.get("traffic_side", "auto") != "auto" else traffic_side(0.5 * (bb["west"] + bb["east"]), 0.5 * (bb["south"] + bb["north"]))
    layer = line_layer(P)
    off = P["offset_m"] if P.get("offset_m") is not None else C.OFFSET_M[veh]
    sg, xy = R["sg"], R["xy"]
    W.progress(5.0, "lane", force=True)
    l2 = False
    if layer == "model":
        M = LN.model(R, veh)
        dm = M["d"]
        if C.LINE_L2_ON:
            W.progress(15.0, "line", force=True)
            dm = O.solve_line(xy, M["d"], M["lo"], M["hi"], O.speed_on_path(R["t"][~R["extrap"]], R["s"][~R["extrap"]], sg), side, M["roundabout"])
            l2 = True
        PL, dl, g = O.driving_line(xy, dm, side, None)
        loops = O.has_loops(PL, xy)
        if loops and l2:                                                      # safety net: L2 made a loop -> L1 alone
            W.log("warn", "driving line: the flattened line (L2) made a loop; the lane model alone (L1) is used")
            PL, dl, g = O.driving_line(xy, M["d"], side, None)
            loops, l2 = O.has_loops(PL, xy), False
        sd_m = M["sd"]
        tagged = float((M["src"] < 2).mean() * 100) if len(M["src"]) else 0.0
        rule = RULE_MODEL.format(vehicle=veh, tagged=tagged, l2=L2_TEXT if l2 else "", side=side, sd=float(np.median(sd_m)) if len(sd_m) else 1.2)
        off = round(float(np.median(np.abs(dl))), 2) if len(dl) else 0.0
    else:
        PL, dl, g = O.driving_line(xy, off, side, R["oneway"])
        loops = O.has_loops(PL, xy)
        sd_m, tagged, rule = np.full(len(xy), np.nan), None, RULE.format(off=off, side=side)
    line_txt = "model" if layer == "model" else "approximation"
    W.progress(30.0, "offset", force=True)
    comp = O.compass(PL)
    s = R["s"]
    px = np.interp(s, sg, PL[:, 0]); py = np.interp(s, sg, PL[:, 1])
    tr = Transformer.from_crs(str(R["crs"]), 4326, always_xy=True)
    lon, lat = tr.transform(px, py)
    hd = np.interp(s, sg, comp)
    dd = np.interp(s, sg, dl)
    osd = np.interp(s, sg, sd_m)
    if P.get("decoys", 0) > 0 and (d / "plausibility" / "summary.json").exists():
        summ = jload(d / "plausibility" / "summary.json")
    else:
        summ = V.verdict_nodecoy(d)
    verdict, basis = summ["verdict"], summ["basis"]
    in_still, still = still_state(R, len(R["t"]))
    pts = [dict(t=float(t), lat=round(float(a), 7), lon=round(float(b), 7), heading=round(float(h), 1), confidence=round(float(c), 4), in_gap=bool(ig), extrapolated=bool(ex),
                sd_m=round(float(sd), 1), arc_m=round(float(ss), 1), offset_m=round(float(o), 2), line_source=layer, motion_state=motion_state(bool(si), bool(ig)),
                **({} if not np.isfinite(q) else dict(offset_sd_m=round(float(q), 1))))
           for t, a, b, h, c, ig, ex, sd, ss, o, q, si in zip(R["t"], lat, lon, hd, R["conf"], R["in_gap"], R["extrap"], R["s_sd"], s, dd, osd, in_still)]
    # sure standstills: one extra point at the exact start and end (sub-second video time), so the GPX stands still exactly when the video does
    stills = []
    for t0, t1, s0, _s1, sdv, cv in still:
        if not np.isfinite(s0):
            continue
        ex_, ey_ = np.interp(s0, sg, PL[:, 0]), np.interp(s0, sg, PL[:, 1])
        elon, elat = tr.transform(ex_, ey_)
        stills.append(dict(t0=round(float(t0), 3), t1=round(float(t1), 3), lat=round(float(elat), 7), lon=round(float(elon), 7), heading=round(float(np.interp(s0, sg, comp)), 1),
                           confidence=round(float(cv), 4), sd_m=round(float(sdv), 1), arc_m=round(float(s0), 1), offset_m=round(float(np.interp(s0, sg, dl)), 2), line_source=layer))
    cp = cut_plan(d)
    pts = apply_cut_plan(pts, cp)
    if cp and cp.get("intro_end") is not None:
        stills = [x for x in stills if x["t0"] > cp["intro_end"]]
    gpx_pts = with_edges(pts, stills)
    hu = jload(d / "route_search" / "hints.json") if (d / "route_search" / "hints.json").exists() else None
    pipe = frozen_info()["code_hash"]
    meta = dict(name=Path(P["video"]).stem, verdict=verdict, basis=basis, offset_m=off, side=side, vehicle=veh, rule=rule, hints=hu, pipeline=pipe, line=line_txt, cuts=cp)
    start = parse_time(P.get("start_time"))
    write_gpx(d / "route.gpx", gpx_pts, start, meta)
    jdump(d / "route_points.json", dict(meta=f"{meta['name']}: rsm.pipeline {VERSION}; verdict {verdict}; t = video seconds, one point per second for the whole video; lat/lon on the driving line "
                                          f"({meta['rule']}); heading = compass degrees clockwise from north; confidence = forward-backward posterior of the decoded edge (0 and extrapolated=true outside "
                                          f"the decoded span, where the position is clamped to the route end); in_gap = inside a vms gap (distance estimated); sd_m = along-track sd of the smoother; "
                                          f"arc_m = distance along the centre line; offset_m = lateral offset applied (+ = right of travel); line_source = fixed (constant offset) or model (lane model, "
                                          f"not measured); offset_sd_m = its typical uncertainty; motion_state = driving, standstill (a SURE standstill: the camera stands, the "
                                          f"position is held) or gap (the distance is estimated, not measured). standstills = the sure standstills with their exact start and "
                                          f"end (t0, t1, video seconds); route.gpx carries an extra point at each (rsm:edge)."
                                          + ("" if not cp else f" The video is edited: {len(cp['times'])} scene cuts (cuts.times, video seconds); the position jumps at each "
                                             f"(a new GPX track segment starts at cuts.breaks)" + ("" if cp.get("intro_end") is None else
                                             f"; the intro up to {cp['intro_end']:.1f} s ({'set by hand' if cp.get('intro_source') == 'user' else f'the last cut of the first {C.CUT_INTRO_S / 60:.0f} minutes'}) is not part of the route, so "
                                             f"the points start there") + ".") + f" {ATTRIB}",
                                          verdict=verdict, verdict_basis=basis, driving_line=line_txt, points=pts, standstills=stills, **({} if not cp else dict(cuts=cp))))
    W.progress(90.0, "write", force=True)
    # in the bundled app the sources are not on disk (PyInstaller archive): the frozen hash is the code hash there
    ch = pipe if (getattr(sys, "frozen", False) and pipe) else code_hash()[0]
    steps = {}
    for sid in C.STEPS:
        f = d / "steps" / f"{sid}.done.json"
        if f.exists():
            steps[sid] = jload(f)
    proj = dict(version=VERSION, params=P, effective=dict(vehicle=veh, vehicle_from_kappa=fin["from_kappa"], traffic_side=side, traffic_region=region, offset_m=off, start_time=fmt(start)),
                verdict=verdict, verdict_basis=basis, verdict_detail=summ, code_hash=ch, pipeline_hash=pipe, hints_used=hu, steps=steps, outputs=dict(gpx="route.gpx", route_points="route_points.json"),
                driving_line=dict(rule=meta["rule"], layer=layer, l2=l2, source=line_txt, tagged_share=tagged, min_length_element=float(g.min()), max_abs_delta_m=float(np.abs(dl).max()),
                                  has_loops=bool(loops), video_measured_share=0.0))
    jdump(d / "project.json", proj)
    W.progress(100.0, "done", force=True)
    return dict(points=len(pts), standstills=len(stills), offset_m=off, side=side, verdict=verdict, min_g=float(g.min()), loops=bool(loops), line=layer, l2=l2)


def retime(d: Path, start_time: str) -> dict:
    """rewrite the <time> of route.gpx from route_points.json (no recompute)"""
    d = Path(d)
    rp = jload(d / "route_points.json")
    proj = jload(d / "project.json")
    start = parse_time(start_time)
    eff = proj["effective"]
    meta = dict(name=Path(proj["params"]["video"]).stem, verdict=rp["verdict"], basis=rp.get("verdict_basis", ""), offset_m=eff["offset_m"], side=eff["traffic_side"], vehicle=eff["vehicle"], rule=proj["driving_line"]["rule"], hints=proj.get("hints_used"), pipeline=proj.get("pipeline_hash"), line=rp.get("driving_line", "approximation"), cuts=rp.get("cuts"))
    write_gpx(d / "route.gpx", with_edges(rp["points"], rp.get("standstills") or []), start, meta)
    proj["effective"]["start_time"] = fmt(start)
    proj["params"]["start_time"] = start_time
    jdump(d / "project.json", proj)
    return dict(gpx=str(d / "route.gpx"), start_time=fmt(start), points=len(rp["points"]))
