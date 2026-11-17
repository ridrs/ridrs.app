# SPDX-License-Identifier: AGPL-3.0-or-later
"""Search area from a video NAME only.

RULE (fixed before any result was looked at):
  1. Geocode the name once with Nominatim (if the literal name returns nothing, the local-language spelling of the same name in
     VARIANTS is tried, one request each, >= 1.1 s apart; the variant used is reported) (top-ranked hit, limit=5 requested only to log the alternatives); the answer is cached in
     work/osm/cache/geocode/<slug>.json and never requested again.
  2. Assumption: the route passes within the road length of the geocoded point (a "pass" video drives over/near the pass).
  3. R = SCALE_MAX * L_nominal, with L_nominal = the vms dead-reckoned path length of the decodable video (4122 m Gotthard for
     964 s, 14833 m Cayolle for 5889 s; FINDINGS "Odometry vs COLMAP") and SCALE_MAX = 2.0 (the stated up-to-2x scale uncertainty).
     Straight-line distance <= road length, so a ball of radius R around the point contains every point of a route of that length
     that contains the point.
  4. Area = the square of half-width R around the point, in WGS84 (bbox = the Overpass query), in one query.
No on-screen hint, no GPS, no frame was used.
"""
from __future__ import annotations

import json
import math
import re
import time
from pathlib import Path

import requests

WORK = Path(__file__).resolve().parents[2] / "work" / "osm"
USER_AGENT = "ridrs-rsm-experiment/0.1 (non-commercial research, route shape matching; python-requests)"
SCALE_MAX = 2.0
VARIANTS = {"Gotthard Pass": ["Gotthard Pass", "Gotthardpass"], "Cayolle Pass": ["Cayolle Pass", "Col de Cayolle"]}  # literal name first
VIDEOS = {  # name from the file name; nominal length from work/odometry/<id>/segments.json total_length_nominal_m
    "Gotthard Pass": {"id": "gotthard", "analysed_s": 964.24, "nominal_m": 4122.0},
    "Cayolle Pass": {"id": "cayolle", "analysed_s": 5889.24, "nominal_m": 14833.5},
}


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def geocode(name: str, cache_dir: Path = WORK / "cache" / "geocode") -> dict:
    """One Nominatim request per name, cached. Returns the full cached record {query, fetched, results:[...]}."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    f = cache_dir / f"{slug(name)}.json"
    if f.exists():
        return json.loads(f.read_text())
    r = requests.get("https://nominatim.openstreetmap.org/search", params={"q": name, "format": "jsonv2", "limit": 5, "addressdetails": 0},
                     headers={"User-Agent": USER_AGENT}, timeout=60)
    r.raise_for_status()
    rec = {"query": name, "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "url": r.url, "results": r.json()}
    f.write_text(json.dumps(rec, indent=1, ensure_ascii=False))
    return rec


def area_for(name: str) -> dict:
    v = VIDEOS[name]
    for q in VARIANTS[name]:
        fresh = not (WORK / "cache" / "geocode" / f"{slug(q)}.json").exists()
        rec = geocode(q)
        if fresh:
            time.sleep(1.1)
        if rec["results"]:
            break
    else:
        raise RuntimeError(f"Nominatim returned no result for {VARIANTS[name]}")
    top = rec["results"][0]
    lat, lon = float(top["lat"]), float(top["lon"])
    R = SCALE_MAX * v["nominal_m"]
    dlat = math.degrees(R / 6371008.8)
    dlon = dlat / math.cos(math.radians(lat))
    north, south, east, west = lat + dlat, lat - dlat, lon + dlon, lon - dlon
    return {"name": name, "query_used": rec["query"], "slug": slug(name), "id": v["id"], "geocoded": {"lat": lat, "lon": lon, "display_name": top.get("display_name"),
            "osm_type": top.get("osm_type"), "osm_id": top.get("osm_id"), "category": top.get("category"), "type": top.get("type")},
            "alternatives": [(r.get("display_name"), r.get("lat"), r.get("lon"), r.get("category"), r.get("type")) for r in rec["results"][1:]],
            "nominal_m": v["nominal_m"], "scale_max": SCALE_MAX, "radius_m": R,
            "bbox": {"north": north, "south": south, "east": east, "west": west},
            "area_km2": (2 * R / 1000) ** 2}


if __name__ == "__main__":
    out = {}
    for n in VIDEOS:
        a = area_for(n)
        out[a["slug"]] = a
        print(json.dumps(a, indent=1, ensure_ascii=False))
    (WORK / "areas.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
