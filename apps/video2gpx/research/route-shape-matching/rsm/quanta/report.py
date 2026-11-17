# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tables from the run records: python -m rsm.quanta.report <runs_dir> <title> [--rule work/quanta/rule.json] -> <runs_dir>/tables.md and tables.json"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from . import evalrun as ev
from .area import WORK

LS = ("3", "5", "10", "20", "40")


def _row(recs, rule):
    s = ev.summarize(recs, rule)
    if s["n"] == 0:
        return "| - | - | - | - | - | - | - |"
    return f"| {s['n']} | {s['top1']} | {s['top5']} | {s['confident']} | {s['conf_correct']} | {s['conf_wrong']} | {s['sec_mean']:.2f} |"


def source_table(res: dict, src: str, rule: dict) -> str:
    L = ["| L (quanta) | windows | top-1 | top-5 | confident | conf. correct | conf. wrong | s/window |", "|---|---|---|---|---|---|---|---|"]
    for l in LS:
        recs = res["runs"][src].get(l, [])
        L.append(f"| {l} " + _row(recs, rule))
    return "\n".join(L)


def adjacency(res: dict, rule: dict, vq: dict, ctx_events_mid: np.ndarray, ix_A, ix_B, L: str) -> dict:
    """Consecutive non-overlapping confident windows: is chain 2's first turn where chain 1's last turn plus the video distance (scale 0.6..1.5) allows?"""
    recs = [r for r in res["runs"]["refined"].get(L, []) if ev.confident(r, rule) and r["legs"]]
    dmid = 0.5 * (vq["len1"] + vq["len2"]) + vq["straight"]
    pairs = [(a, b) for a in recs for b in recs if b["lo"] == a["hi"]]
    ok = 0
    ends = [(ctx_events_mid[ix_B[a["legs"][-1][1]]], a["legs"][-1][0]) for a in recs]
    starts = [(ctx_events_mid[ix_A[b["legs"][0][1]]], b["legs"][0][0]) for b in recs]

    def plaus(pe, qe, ps, qs):
        dv = float(dmid[qe + 1:qs].sum()) if qs > qe else 0.0
        return float(np.hypot(*(pe - ps))) <= dv / 0.6 + 150.0

    for a, b in pairs:
        e = (ctx_events_mid[ix_B[a["legs"][-1][1]]], a["legs"][-1][0])
        s = (ctx_events_mid[ix_A[b["legs"][0][1]]], b["legs"][0][0])
        ok += plaus(e[0], e[1], s[0], s[1])
    # null: random end/start pairs of the confident windows with the same video distance but shuffled map positions
    rng = np.random.default_rng(1)
    nul = []
    if len(recs) >= 3 and pairs:
        for _ in range(200):
            i, j = rng.integers(0, len(recs), 2)
            if i == j:
                continue
            a, b = pairs[rng.integers(0, len(pairs))]
            qe, qs = a["legs"][-1][0], b["legs"][0][0]
            dv = float(dmid[qe + 1:qs].sum()) if qs > qe else 0.0
            nul.append(float(np.hypot(*(ends[i][0] - starts[j][0]))) <= dv / 0.6 + 150.0)
    # overlapping windows that are both confident: share a turn event?
    ov = [(a, b) for a in recs for b in recs if a["lo"] < b["lo"] < a["hi"]]
    evs = lambda r: {int(ix_A[l]) for _, l in r["legs"]} | {int(ix_B[l]) for _, l in r["legs"]}
    share = sum(bool(evs(a) & evs(b)) for a, b in ov)
    return dict(L=L, confident=len(recs), consecutive_pairs=len(pairs), plausible_adjacent=ok, null_rate=float(np.mean(nul)) if nul else None,
                overlapping_pairs=len(ov), overlapping_sharing_events=int(share))


def first_confident(res: dict) -> dict:
    f = res.get("first", [])
    got = [x for x in f if x.get("L")]
    out = dict(starts=len(f), reached_confident=len(got), correct=sum(x["ok"] for x in got), wrong=sum(not x["ok"] for x in got))
    if got:
        out["median_quanta_needed"] = float(np.median([x["L"] for x in got]))
        c = [x["L"] for x in got if x["ok"]]
        out["median_quanta_needed_correct"] = float(np.median(c)) if c else None
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("runs")
    ap.add_argument("title")
    ap.add_argument("--rule", default=str(WORK / "rule.json"))
    a = ap.parse_args()
    rule = json.loads(Path(a.rule).read_text())
    md, js = [f"## {a.title}\n"], {}
    for f in sorted(Path(a.runs).glob("*.json")):
        res = json.loads(f.read_text())
        vid = res["video"]
        ctx = ev.load_ctx(vid, float(res.get("thr", 45.0))) if "thr" in res else ev.load_ctx(vid)
        md.append(f"### {vid}\n\nlegs {res['n_legs']}, events {res['n_events']}, index build {res['index_sec']:.1f} s, total {res['seconds']:.0f} s; "
                  f"video quanta (scorable): {res['n_scorable']} of {res['n_quanta']}\n")
        js[vid] = dict(sources={}, controls={})
        for src in ("refined", "baseline", "gps"):
            if src in res["runs"]:
                md.append(f"**{src}**\n\n{source_table(res, src, rule)}\n")
                js[vid]["sources"][src] = {l: ev.summarize(res["runs"][src].get(l, []), rule) for l in LS}
        ctl = [k for k in res["runs"] if k not in ("refined", "baseline", "gps")]
        if ctl:
            md.append("**controls** (windows from the refined quanta; confident / of which correct)\n\n| control | " + " | ".join(f"L={l}" for l in LS) + " |\n|---|" + "---|" * len(LS))
            for k in ctl:
                cells = []
                for l in LS:
                    s = ev.summarize(res["runs"][k].get(l, []), rule)
                    cells.append("-" if s["n"] == 0 else f"{s['n']} win, {s['confident']} conf ({s['conf_correct']} ok)")
                md.append(f"| {k} | " + " | ".join(cells) + " |")
                js[vid]["controls"][k] = {l: ev.summarize(res["runs"][k].get(l, []), rule) for l in LS}
            md.append("")
        if "first" in res:
            fc = first_confident(res)
            md.append(f"**quanta needed until the first confident window** (refined, start every 3rd quantum, window grown 3..40): {json.dumps(fc)}\n")
            js[vid]["first"] = fc
        from .chain import MapIndex, Params
        ix = MapIndex(ctx.m, Params(**res["params"]))
        vq = ev.video_q(vid, "refined", float(res.get("thr", 45.0)))
        adj = [adjacency(res, rule, vq, ctx.m["events"]["mid"], ix.A, ix.B, l) for l in ("5", "10", "20")]
        md.append("**adjacency of consecutive confident windows (refined)**: " + json.dumps(adj) + "\n")
        js[vid]["adjacency"] = adj
    (Path(a.runs) / "tables.md").write_text("\n".join(md))
    (Path(a.runs) / "tables.json").write_text(json.dumps(js, indent=1, default=float))
    print("\n".join(md))


if __name__ == "__main__":
    main()
