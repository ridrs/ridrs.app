# SPDX-License-Identifier: AGPL-3.0-or-later
"""Read a Geofabrik PBF IN PLACE (read-only; never copied) into the same Overpass-JSON element form osmnx builds graphs from.

Same road filter as graph.ROAD_FILTER (re-implemented here because there is no Overpass): highway in ROAD_HIGHWAYS, area != yes,
access != private. A way is kept if ANY of its nodes lies in the bbox (what Overpass `way(bbox)` does); its full geometry is kept.
The subset is cached as JSON under work/osm/cache/ (ODbL, experiment-internal).
"""
from __future__ import annotations

import json
from pathlib import Path

ROAD_HIGHWAYS = {"trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
                 "unclassified", "residential", "living_street"}
TAGS = ("highway", "name", "ref", "oneway", "junction", "tunnel", "bridge", "access", "area", "lanes", "maxspeed", "service", "width")


def read_subset(pbf: Path, bbox: dict, cache: Path | None = None) -> dict:
    import osmium
    if cache is not None and cache.exists():
        return json.loads(cache.read_text())
    ts = osmium.io.Reader(str(pbf)).header().get("osmosis_replication_timestamp")
    W, S, E, N = bbox["west"], bbox["south"], bbox["east"], bbox["north"]
    nodes: dict[int, tuple[float, float]] = {}
    ways = []
    skipped_invalid = 0
    fp = osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY).with_locations().with_filter(osmium.filter.KeyFilter("highway"))
    for w in fp:
        if not w.is_way():
            continue
        t = w.tags
        if t.get("highway") not in ROAD_HIGHWAYS or t.get("area") == "yes" or t.get("access") == "private":
            continue
        try:
            pts = [(n.ref, n.lat, n.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            skipped_invalid += 1
            continue
        if not any(S <= la <= N and W <= lo <= E for _, la, lo in pts):
            continue
        for r, la, lo in pts:
            nodes[r] = (la, lo)
        ways.append({"type": "way", "id": w.id, "nodes": [p[0] for p in pts], "tags": {k: t[k] for k in TAGS if k in t}})
    els = [{"type": "node", "id": i, "lat": la, "lon": lo} for i, (la, lo) in nodes.items()] + ways
    out = {"elements": els, "source": {"pbf": str(pbf), "replication_timestamp": ts, "ways": len(ways), "nodes": len(nodes),
                                       "ways_skipped_invalid_location": skipped_invalid}}
    if cache is not None:
        cache.write_text(json.dumps(out))
    return out
