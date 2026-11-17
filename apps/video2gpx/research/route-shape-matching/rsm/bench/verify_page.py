# SPDX-License-Identifier: AGPL-3.0-or-later
"""Side-by-side check page: video frame next to Google Street View at the position the tracker predicts for that video time.

Usage:
  python -m rsm.bench.verify_page --route work/track/res/v2_dev_vallee-de-roanne.pkl --video <video> --crs EPSG:32631 -o work/verify/roanne
  python -m rsm.bench.verify_page --points pts.json --video <video> -o work/verify/amalfi      # pts.json: [{"t": s, "lat": .., "lon": .., "heading": deg}, ...]

Writes <out>/index.html plus <out>/frames/*.jpg (video-derived: keep under work/, never publish).
The page stores the user's verdicts (same / different / unclear) in the browser and can export them as JSON.
"""
from __future__ import annotations

import argparse
import html
import json
import pickle
import subprocess
from pathlib import Path

import numpy as np


def lead_route(pkl: Path, pool: str = "P1_decisions"):
    d = pickle.load(open(pkl, "rb"))
    t_lead = d["consensus"][pool]["lead_anchor_t"]
    rows = d["groups"]["dec"]["rows"]
    r = min(rows, key=lambda r: abs(r["anchor"]["t"] - t_lead))["route"]
    return d, r


def points_from_route(route, crs: str, n: int, every_s: float | None, min_move_m: float = 3.0) -> list[dict]:
    from pyproj import Transformer

    t, xy = np.asarray(route.t, float), np.asarray(route.xy, float)
    ok = np.isfinite(xy).all(axis=1)
    t, xy = t[ok], xy[ok]
    if every_s:
        ts = np.arange(t[0] + every_s / 2, t[-1], every_s)
    else:
        ts = np.linspace(t[0], t[-1], n + 2)[1:-1]
    tr = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    out = []
    for tq in ts:
        i = int(np.clip(np.searchsorted(t, tq), 1, len(t) - 1))
        p = xy[i]
        # heading of travel: look ahead along the route until the position moved a few metres
        j = i
        while j < len(t) - 1 and np.hypot(*(xy[j] - p)) < 15:
            j += 1
        k = i
        while k > 0 and np.hypot(*(xy[k] - p)) < 15 and j == len(t) - 1:
            k -= 1
        d = (xy[j] - p) if np.hypot(*(xy[j] - p)) >= min_move_m else (p - xy[k])
        heading = float(np.degrees(np.arctan2(d[0], d[1])) % 360)  # compass, 0 = north
        lon, lat = tr.transform(p[0], p[1])
        out.append(dict(t=float(t[i]), lat=float(lat), lon=float(lon), heading=round(heading, 1)))
    return out


def grab_frames(video: Path, pts: list[dict], out: Path, vf: str) -> None:
    (out / "frames").mkdir(parents=True, exist_ok=True)
    for p in pts:
        f = out / "frames" / f"t{p['t']:08.1f}.jpg"
        p["frame"] = f"frames/{f.name}"
        if f.exists():
            continue
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{p['t']:.2f}", "-i", str(video), "-frames:v", "1", "-vf", vf, "-q:v", "3", str(f)],
                       check=True)


def fmt_t(s: float) -> str:
    s = int(round(s))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


PAGE = """<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
:root {{ --bg:#fafaf8; --fg:#1d1d1b; --muted:#6b6b66; --line:#ddd; --ok:#1f8a4c; --bad:#c2410c; --unk:#8a7a1f; --card:#fff; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#161615; --fg:#ecece8; --muted:#a3a39c; --line:#333; --card:#1f1f1d; }} }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--fg); font:15px/1.45 -apple-system,system-ui,sans-serif; }}
header {{ position:sticky; top:0; z-index:5; background:var(--bg); border-bottom:1px solid var(--line); padding:10px 16px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; }}
h1 {{ font-size:17px; margin:0; }}
.sum {{ color:var(--muted); font-size:13px; }}
button {{ font:inherit; border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:6px; padding:4px 10px; cursor:pointer; }}
main {{ padding:12px 16px 60px; max-width:1500px; margin:0 auto; }}
.row {{ background:var(--card); border:1px solid var(--line); border-radius:10px; margin:0 0 14px; padding:10px; }}
.row.ok {{ border-left:6px solid var(--ok); }} .row.bad {{ border-left:6px solid var(--bad); }} .row.unk {{ border-left:6px solid var(--unk); }}
.meta {{ display:flex; gap:14px; flex-wrap:wrap; align-items:center; font-size:13px; color:var(--muted); margin-bottom:8px; }}
.meta b {{ color:var(--fg); }}
.pair {{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }}
.pair > * {{ width:100%; aspect-ratio:16/9; border:0; border-radius:6px; background:#000; object-fit:contain; }}
@media (max-width:800px) {{ .pair {{ grid-template-columns:1fr; }} }}
.verdict button.sel[data-v=ok] {{ background:var(--ok); color:#fff; }}
.verdict button.sel[data-v=bad] {{ background:var(--bad); color:#fff; }}
.verdict button.sel[data-v=unk] {{ background:var(--unk); color:#fff; }}
a {{ color:inherit; }}
</style></head><body>
<header><h1>{title}</h1><span class="sum" id="sum"></span>
<button id="exp">Ergebnis kopieren (JSON)</button>
<span class="sum">Links: Videobild. Rechts: Street View an der vorhergesagten Stelle, Blick in Fahrtrichtung. Street View kann ein paar Meter oder Jahre abweichen.</span></header>
<main>{rows}</main>
<script>
const KEY = {key};
let st = {{}};
try {{ st = JSON.parse(localStorage.getItem(KEY) || "{{}}"); }} catch (e) {{}}
function save() {{ try {{ localStorage.setItem(KEY, JSON.stringify(st)); }} catch (e) {{}} render(); }}
function render() {{
  let c = {{ok:0, bad:0, unk:0}};
  document.querySelectorAll(".row").forEach(r => {{
    const v = st[r.dataset.t]; r.classList.remove("ok","bad","unk"); if (v) {{ r.classList.add(v); c[v]++; }}
    r.querySelectorAll(".verdict button").forEach(b => b.classList.toggle("sel", b.dataset.v === v));
  }});
  document.getElementById("sum").textContent = `gleich ${{c.ok}} · anders ${{c.bad}} · unklar ${{c.unk}} · offen ${{document.querySelectorAll(".row").length - c.ok - c.bad - c.unk}}`;
}}
document.querySelectorAll(".verdict button").forEach(b => b.onclick = () => {{
  const t = b.closest(".row").dataset.t; st[t] = st[t] === b.dataset.v ? undefined : b.dataset.v; save();
}});
document.getElementById("exp").onclick = async () => {{
  const pts = {pts};
  const out = pts.map(p => ({{...p, verdict: st[p.t.toFixed(1)] || null}}));
  const txt = JSON.stringify(out, null, 1);
  try {{ await navigator.clipboard.writeText(txt); alert("In die Zwischenablage kopiert"); }} catch (e) {{ prompt("JSON kopieren:", txt); }}
}};
render();
</script></body></html>
"""

ROW = """<section class="row" data-t="{tkey}">
<div class="meta"><b>#{i} · Video {tv}</b><span>{lat:.5f}, {lon:.5f}</span><span>Richtung {hd:.0f}°</span>
<a href="{gm}" target="_blank" rel="noopener">Street View öffnen</a><a href="{osm}" target="_blank" rel="noopener">Karte</a>
<span class="verdict"><button data-v="ok">gleich</button> <button data-v="bad">anders</button> <button data-v="unk">unklar</button></span></div>
<div class="pair"><img src="{frame}" alt="Videobild {tv}" loading="lazy">
<iframe src="{sv}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe></div>
</section>"""


def write_page(pts: list[dict], out: Path, title: str) -> Path:
    import base64

    rows = []
    for i, p in enumerate(pts, 1):
        la, lo, h = p["lat"], p["lon"], p["heading"]
        # frames are inlined so the page is one self-contained file
        img = "data:image/jpeg;base64," + base64.b64encode((out / p["frame"]).read_bytes()).decode()
        rows.append(ROW.format(
            i=i, tkey=f"{p['t']:.1f}", tv=fmt_t(p["t"]), lat=la, lon=lo, hd=h, frame=img,
            sv=html.escape(f"https://maps.google.com/maps?q=&layer=c&cbll={la:.6f},{lo:.6f}&cbp=11,{h:.0f},0,0,0&output=svembed"),
            gm=html.escape(f"https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={la:.6f},{lo:.6f}&heading={h:.0f}&pitch=0&fov=90"),
            osm=html.escape(f"https://www.openstreetmap.org/?mlat={la:.6f}&mlon={lo:.6f}#map=17/{la:.6f}/{lo:.6f}")))
    light = [{k: p[k] for k in ("t", "lat", "lon", "heading")} for p in pts]
    page = PAGE.format(title=html.escape(title), rows="\n".join(rows), key=json.dumps("verify:" + title), pts=json.dumps(light))
    (out / "index.html").write_text(page, encoding="utf-8")
    (out / "points.json").write_text(json.dumps(light, indent=1))
    return out / "index.html"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--route", help="tracker result pickle (work/track/res/*.pkl); uses the lead route of the best cluster")
    ap.add_argument("--points", help="JSON list of {t, lat, lon, heading} instead of --route")
    ap.add_argument("--crs", default="EPSG:32631", help="projected CRS of the route xy")
    ap.add_argument("--video", required=True)
    ap.add_argument("-n", type=int, default=24, help="number of check points, evenly over the route")
    ap.add_argument("--every", type=float, default=None, help="seconds between check points (overrides -n)")
    ap.add_argument("--vf", default="scale=960:-2", help="ffmpeg filter for the frames (e.g. add a tonemap for HDR)")
    ap.add_argument("--title", default=None)
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.points:
        pts = json.loads(Path(a.points).read_text())
        title = a.title or out.name
    else:
        d, r = lead_route(Path(a.route))
        pts = points_from_route(r, a.crs, a.n, a.every)
        title = a.title or f"{d['video']}: Video gegen Street View"
    grab_frames(Path(a.video), pts, out, a.vf)
    print(write_page(pts, out, title))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
