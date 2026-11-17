# SPDX-License-Identifier: AGPL-3.0-or-later
"""Map check page: the reconstructed route on an OSM map next to the video frame at the same time.

    python -m rsm.bench.verify_map --points work/amalfi_far/route_points.json --video <video> --step 5 -o work/verify/amalfi_map

Click on the route (or use the slider / arrow keys) to jump the frame to that spot of the video. Each spot can be marked
"stimmt" / "weicht ab" / "unklar"; the marks stay in the browser and can be exported as JSON.

Writes <out>/index.html, <out>/route.js and <out>/frames/*.jpg (one frame every --step seconds, one ffmpeg pass).
Video-derived: keep under work/, never publish. Run the frame extraction under tools/memguard.py.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
from pathlib import Path


def load_points(path: Path) -> list[dict]:
    d = json.loads(path.read_text())
    pts = d["points"] if isinstance(d, dict) else d
    out = []
    for p in pts:
        out.append(dict(t=round(float(p["t"]), 2), lat=round(float(p["lat"]), 6), lon=round(float(p["lon"]), 6),
                        h=round(float(p.get("heading", p.get("heading_deg", 0.0))), 1),
                        c=round(float(p.get("posterior", p.get("conf", p.get("confidence", 1.0)))), 3)))
    out.sort(key=lambda p: p["t"])
    return out


def extract_frames(video: Path, out: Path, step: float, vf: str, duration: float | None) -> list[float]:
    """One decoding pass. Picks the first frame at or after every multiple of `step` and records its exact
    presentation time (showinfo), so the page never mislabels a frame (the fps filter rounds by up to step/2)."""
    fdir = out / "frames"
    fdir.mkdir(parents=True, exist_ok=True)
    tfile = out / "frame_times.json"
    if tfile.exists() and len(list(fdir.glob("f*.jpg"))) == len(json.loads(tfile.read_text())):
        return json.loads(tfile.read_text())
    for f in fdir.glob("f*.jpg"):
        f.unlink()
    sel = f"select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{step - 0.02})',showinfo"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info", "-y", "-i", str(video)]
    if duration:
        cmd += ["-t", f"{duration:.1f}"]
    cmd += ["-vf", f"{sel},{vf}", "-fps_mode", "passthrough", "-q:v", "4", str(fdir / "f%05d.jpg")]
    p = subprocess.run(cmd, check=True, capture_output=True, text=True)
    times = [float(m.group(1)) for m in re.finditer(r"pts_time:([0-9.]+)", p.stderr)]
    n = len(list(fdir.glob("f*.jpg")))
    if not n <= len(times) <= n + 1:  # with -t the last selected frame can fall past the cut and is not written
        raise RuntimeError(f"{len(times)} timestamps for {n} frames")
    times = times[:n]
    tfile.write_text(json.dumps(times))
    return times


PAGE = """<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script src="route.js"></script>
<style>
:root {{ --bg:#fafaf8; --fg:#1d1d1b; --muted:#6b6b66; --line:#ddd; --card:#fff; --ok:#1f8a4c; --bad:#c2410c; --unk:#b58a00; --route:#2563eb; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#161615; --fg:#ecece8; --muted:#a3a39c; --line:#333; --card:#1f1f1d; }} }}
* {{ box-sizing:border-box; }}
html, body {{ margin:0; height:100%; background:var(--bg); color:var(--fg); font:14px/1.4 -apple-system,system-ui,sans-serif; }}
header {{ padding:8px 16px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }}
h1 {{ font-size:16px; margin:0; }}
.muted {{ color:var(--muted); font-size:12px; }}
main {{ display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:10px 16px; height:calc(100% - 110px); }}
#map {{ height:100%; min-height:320px; border-radius:8px; border:1px solid var(--line); }}
#right {{ display:flex; flex-direction:column; gap:8px; min-height:0; }}
#frame {{ width:100%; flex:1; min-height:0; object-fit:contain; background:#000; border-radius:8px; }}
.bar {{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }}
button {{ font:inherit; border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:6px; padding:4px 10px; cursor:pointer; }}
button.sel[data-v=ok] {{ background:var(--ok); color:#fff; }} button.sel[data-v=bad] {{ background:var(--bad); color:#fff; }} button.sel[data-v=unk] {{ background:var(--unk); color:#fff; }}
input[type=range] {{ width:100%; }}
#t {{ font-variant-numeric:tabular-nums; font-weight:600; }}
a {{ color:inherit; }}
@media (max-width:820px) {{ main {{ grid-template-columns:1fr; height:auto; }} #map {{ height:55vh; }} #frame {{ max-height:40vh; }} }}
</style></head><body>
<header><h1>{title}</h1><span class="muted" id="sum"></span><button id="exp">Markierungen kopieren (JSON)</button>
<span class="muted">Klick auf die Route springt zur Stelle im Video. Pfeiltasten ← → = ein Bild zurück/vor. Route eingefärbt nach Sicherheit (blau sicher, grau unsicher).</span></header>
<main>
<div id="map"></div>
<div id="right">
  <img id="frame" alt="Videobild">
  <div class="bar"><span id="t"></span><span class="muted" id="pos"></span>
    <a id="sv" target="_blank" rel="noopener">Street View hier</a></div>
  <input id="slider" type="range" min="0" step="1">
  <div class="bar"><button id="prev">◀ zurück</button><button id="play">▶ abspielen</button><button id="next">vor ▶</button>
    <span style="flex:1"></span>
    <span>Diese Stelle:</span><button data-v="ok">stimmt</button><button data-v="bad">weicht ab</button><button data-v="unk">unklar</button></div>
</div>
</main>
<script>
const R = window.ROUTE, NF = R.n_frames, P = R.points, FT = R.frame_t;
function frameAt(t) {{ let lo = 0, hi = NF - 1; while (hi - lo > 1) {{ const m = (lo + hi) >> 1; if (FT[m] < t) lo = m; else hi = m; }} return Math.abs(FT[lo] - t) <= Math.abs(FT[hi] - t) ? lo : hi; }}
const KEY = "verifymap:" + R.title;
let marks = {{}};
try {{ marks = JSON.parse(localStorage.getItem(KEY) || "{{}}"); }} catch (e) {{}}
const map = L.map("map");
L.tileLayer("https://tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png", {{maxZoom: 19, attribution: "&copy; OpenStreetMap contributors (ODbL)"}}).addTo(map);
// route coloured by confidence, drawn as short pieces
const segs = [];
for (let i = 1; i < P.length; i++) {{
  const c = Math.min(P[i-1].c, P[i].c);
  const col = c >= 0.8 ? "#2563eb" : c >= 0.5 ? "#7c93c9" : "#9ca3af";
  segs.push(L.polyline([[P[i-1].lat, P[i-1].lon], [P[i].lat, P[i].lon]], {{color: col, weight: 5, opacity: 0.9}}));
}}
const routeLayer = L.featureGroup(segs).addTo(map);
const fit = () => {{ map.invalidateSize(); map.fitBounds(routeLayer.getBounds(), {{padding: [20, 20]}}); }};
fit(); window.addEventListener("load", () => setTimeout(fit, 100));
const markLayer = L.layerGroup().addTo(map);
const here = L.circleMarker([P[0].lat, P[0].lon], {{radius: 9, color: "#111", weight: 3, fillColor: "#facc15", fillOpacity: 1}}).addTo(map);
const arrow = L.polyline([], {{color: "#111", weight: 3}}).addTo(map);
const slider = document.getElementById("slider");
slider.max = NF - 1;
let cur = 0, timer = null;
function pointAt(t) {{  // route point nearest in time (binary search)
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) {{ const m = (lo + hi) >> 1; if (P[m].t < t) lo = m; else hi = m; }}
  return Math.abs(P[lo].t - t) <= Math.abs(P[hi].t - t) ? P[lo] : P[hi];
}}
function fmt(s) {{ s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); }}
function show(i, pan) {{
  cur = Math.max(0, Math.min(NF - 1, i));
  const t = FT[cur], p = pointAt(t);
  document.getElementById("frame").src = "frames/f" + String(cur + 1).padStart(5, "0") + ".jpg";
  slider.value = cur;
  document.getElementById("t").textContent = "Video " + fmt(t) + " (" + t.toFixed(1) + " s)";
  document.getElementById("pos").textContent = p.lat.toFixed(5) + ", " + p.lon.toFixed(5) + " · Richtung " + Math.round(p.h) + "° · Sicherheit " + Math.round(100 * p.c) + " %";
  document.getElementById("sv").href = "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=" + p.lat + "," + p.lon + "&heading=" + Math.round(p.h) + "&pitch=0&fov=90";
  here.setLatLng([p.lat, p.lon]);
  const d = 0.0004, r = p.h * Math.PI / 180;
  arrow.setLatLngs([[p.lat, p.lon], [p.lat + d * Math.cos(r), p.lon + d * Math.sin(r) / Math.cos(p.lat * Math.PI / 180)]]);
  if (pan && !map.getBounds().pad(-0.15).contains([p.lat, p.lon])) map.panTo([p.lat, p.lon]);
  document.querySelectorAll(".bar button[data-v]").forEach(b => b.classList.toggle("sel", marks[FT[cur]] === b.dataset.v));
}}
function renderMarks() {{
  markLayer.clearLayers();
  const col = {{ok: "#1f8a4c", bad: "#c2410c", unk: "#b58a00"}}, c = {{ok: 0, bad: 0, unk: 0}};
  for (const [t, v] of Object.entries(marks)) {{
    if (!v) continue; c[v]++;
    const p = pointAt(+t);
    L.circleMarker([p.lat, p.lon], {{radius: 6, color: "#fff", weight: 2, fillColor: col[v], fillOpacity: 1}})
      .on("click", () => show(frameAt(+t), false)).addTo(markLayer);
  }}
  document.getElementById("sum").textContent = `stimmt ${{c.ok}} · weicht ab ${{c.bad}} · unklar ${{c.unk}}`;
}}
function save() {{ try {{ localStorage.setItem(KEY, JSON.stringify(marks)); }} catch (e) {{}} renderMarks(); show(cur, false); }}
map.on("click", e => {{  // nearest route point in space
  let best = null, bd = Infinity;
  const kx = Math.cos(e.latlng.lat * Math.PI / 180);
  for (const p of P) {{ const dx = (p.lon - e.latlng.lng) * kx, dy = p.lat - e.latlng.lat, dd = dx * dx + dy * dy; if (dd < bd) {{ bd = dd; best = p; }} }}
  if (best) show(frameAt(best.t), false);
}});
routeLayer.on("click", e => map.fire("click", e));
slider.oninput = () => show(+slider.value, true);
document.getElementById("prev").onclick = () => show(cur - 1, true);
document.getElementById("next").onclick = () => show(cur + 1, true);
document.getElementById("play").onclick = () => {{
  const b = document.getElementById("play");
  if (timer) {{ clearInterval(timer); timer = null; b.textContent = "▶ abspielen"; }}
  else {{ timer = setInterval(() => {{ if (cur >= NF - 1) {{ clearInterval(timer); timer = null; }} show(cur + 1, true); }}, 600); b.textContent = "❚❚ pause"; }}
}};
document.addEventListener("keydown", e => {{ if (e.key === "ArrowLeft") show(cur - 1, true); if (e.key === "ArrowRight") show(cur + 1, true); }});
document.querySelectorAll(".bar button[data-v]").forEach(b => b.onclick = () => {{
  const k = FT[cur]; marks[k] = marks[k] === b.dataset.v ? undefined : b.dataset.v; save(); }});
document.getElementById("exp").onclick = async () => {{
  const out = Object.entries(marks).filter(([, v]) => v).map(([t, v]) => {{ const p = pointAt(+t); return {{t: +t, lat: p.lat, lon: p.lon, verdict: v}}; }}).sort((a, b) => a.t - b.t);
  const txt = JSON.stringify(out, null, 1);
  try {{ await navigator.clipboard.writeText(txt); alert("In die Zwischenablage kopiert"); }} catch (e) {{ prompt("JSON kopieren:", txt); }}
}};
renderMarks(); show(0, false);
</script></body></html>
"""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--points", required=True, help="JSON list (or {points: [...]}) of {t, lat, lon, heading|heading_deg, [posterior|conf]}")
    ap.add_argument("--video", required=True)
    ap.add_argument("--step", type=float, default=5.0, help="seconds between extracted frames")
    ap.add_argument("--vf", default="scale=720:-2", help="ffmpeg filter after the fps filter (add a colour fix for HDR)")
    ap.add_argument("--duration", type=float, default=None, help="only the first N seconds (for a quick test)")
    ap.add_argument("--title", default="Routenkontrolle")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    pts = load_points(Path(a.points))
    times = extract_frames(Path(a.video), out, a.step, a.vf, a.duration)
    route = dict(title=a.title, step=a.step, n_frames=len(times), frame_t=[round(t, 3) for t in times], points=pts)
    (out / "route.js").write_text("window.ROUTE = " + json.dumps(route, separators=(",", ":")) + ";\n")
    (out / "index.html").write_text(PAGE.format(title=html.escape(a.title)), encoding="utf-8")
    print(out / "index.html", len(times), "frames,", len(pts), "route points")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
