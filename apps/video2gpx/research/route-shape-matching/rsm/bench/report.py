# SPDX-License-Identifier: AGPL-3.0-or-later
"""Markdown rendering of the benchmark results (metric tables only, no coordinates)."""
from __future__ import annotations

import json
from pathlib import Path

from ..core.matcher import StatusThresholds
from . import real_video, tracks as T
from .benchmark import KEYS

SHORT = {"rmse_rel": "RMSE", "frechet_rel": "Frechet", "hausdorff_rel": "Hausdorff", "dtw_rel": "DTW", "heading": "heading sig.", "combo": "sqrt(RMSE*heading)"}


def pct(x) -> str:
    return "n/a" if x != x else f"{100 * x:.0f}"


def render(res: dict, out_dir: Path, run_real: bool = True) -> str:
    L: list[str] = []
    em = res["error_model"]
    if em["source"] != "calibrated":
        L.append("> **WARNING: error model is ASSUMED, not calibrated** (`work/error_model.json` missing). Numbers below are not Phase 2 evidence.\n")
    if any(t["name"].endswith("_standin") for t in res["tracks"]):
        L.append("> **WARNING: stand-in tracks** (in-repository fixture GPX, not the FR_* tracks of the brief). Harness validation only.\n")
    L.append(f"tracks: {', '.join(f'{t['name']} [{t['role']}] {t['length_km']} km' for t in res['tracks'])}")
    L.append(f"error model ({em['source']}): " + ", ".join(f"{k}={v}" for k, v in em.items() if k not in ('notes', 'source')))
    L.append(f"library size per query length: {res['library_size']}; runs: {res['n_runs']}; matching wall {res['wall_s_matching']:.0f} s on {res['config']['workers']} workers; total {res['wall_s_total']:.0f} s")
    L.append(f"chosen ranking score (dev rule): **{res['chosen']}**; tied within 0.5 pp: {res['tuning']['tied']}")
    L.append("")
    L.append("### Status thresholds (from dev only)\n\n| score | gap_ratio | max_score | dev correct | dev pool |\n|---|---|---|---|---|")
    for k in KEYS:
        t = res["tuning"]["thresholds"][k]
        L.append(f"| {k} | {t['gap_ratio']:.4g} | {t['max_score']:.4g} | {t['n_dev_correct']} | {t['n_dev_pool']} |")
    for part in ("dev", "test"):
        for level in sorted({float(c.split('|')[2]) for c in res["tables"][KEYS[0]]["cells"]}):
            L.append(f"\n### Metric comparison: {part}, noise level x{level:g}\n")
            L.append("| score | length m | n | top1 % | top5 % | top20 % | median rank | not found % | confident % | confident-wrong % | time/query s |\n|---|---|---|---|---|---|---|---|---|---|---|")
            for k in KEYS:
                for c, v in res["tables"][k]["cells"].items():
                    p, length, lv = c.split("|")
                    if p != part or float(lv) != level:
                        continue
                    tq = res["timing_s_per_query"].get(length, {}).get(k)
                    L.append(f"| {SHORT[k]} | {length} | {v['n']} | {pct(v['top1'])} | {pct(v['top5'])} | {pct(v['top20'])} | {v['median_rank']:g} | {pct(v['not_found'])} | "
                             f"{pct(v['confident'])} | {pct(v['confident_wrong'])} | {'' if tq is None else f'{tq:.3f}'} |")
    ch = res["chosen"]
    L.append(f"\n### Hard negatives (ranking score {ch}, thresholds from dev)\n\n| split | kind | n | confident % | ambiguous % | no_match % | confident-wrong % | extra |\n|---|---|---|---|---|---|---|---|")
    for c, v in res["tables"][ch]["hard"].items():
        part, kind = c.split("|")
        if v["n"] == 0:
            L.append(f"| {part} | {kind} | 0 | | | | | |")
            continue
        extra = ", ".join(f"{k}={pct(x)}" for k, x in v.items() if k in ("confident_at_original_location", "top1"))
        L.append(f"| {part} | {kind} | {v['n']} | {pct(v['confident'])} | {pct(v['ambiguous'])} | {pct(v['no_match'])} | {pct(v.get('confident_wrong', float('nan')))} | {extra} |")
    L.append(f"\n### Where it fails: top-1 % (n) by total absolute turning of the true cut, level x1, ranking score {ch}\n")
    bt = res["tables"][ch]["by_turn"]
    lens = sorted({int(c.split("|")[1]) for c in bt})
    bins = sorted({c.split("|")[2] for c in bt}, key=lambda b: float(b.split("-")[0]))
    L.append("| split | turning deg | " + " | ".join(f"{l} m" for l in lens) + " |\n|---|---|" + "---|" * len(lens))
    for part in ("dev", "test"):
        for b in bins:
            cells = [bt.get(f"{part}|{l}|{b}") for l in lens]
            if any(cells):
                L.append(f"| {part} | {b} | " + " | ".join("" if c is None else f"{pct(c['top1'])} ({c['n']}; conf {pct(c['confident'])}, conf-wrong {pct(c['confident_wrong'])})" for c in cells) + " |")
    L.append("\n### Tier-1 prefilter (heading signature of the coarse windows, keep best 50)\n")
    for length, v in res["prefilter"].items():
        L.append(f"- {length} m: truth retained {v['truth_retained']}/{v['truth_retained_of']} (n={v['n']}), time ratio {v['time_ratio']:.2f}, library {res['library_size'][length]}")
    L.append("\n### Time per query (s, serial, alignment search + that score's components)\n\n| length | library | " + " | ".join(SHORT[k] for k in KEYS) + " |\n|---|---|" + "---|" * len(KEYS))
    for length, v in res["timing_s_per_query"].items():
        L.append(f"| {length} | {v['library']} | " + " | ".join(f"{v[k]:.3f}" for k in KEYS) + " |")
    if run_real:
        tr = T.available_tracks(res["config"]["standin"])
        th = {k: StatusThresholds(max(res["tuning"]["thresholds"][k]["gap_ratio"], 1.0), res["tuning"]["thresholds"][k]["max_score"]) for k in KEYS}
        rv = real_video.run(tr, KEYS, th, ch)
        res["real_video"] = rv
        (out_dir / "bench_results.json").write_text(json.dumps(res, indent=1))
        L.append("\n### Real video queries (circular calibration: see FINDINGS)\n")
        for n in rv["not_run"]:
            L.append(f"- NOT RUN: {n}")
        for q in rv["queries"]:
            if q["mode"] == "truth":
                L.append(f"\n{q['route']}: query {q['query_length_m']:.0f} m, truth {q['truth']['length_m']:.0f} m on {q['truth']['track']}, library {q['library_size']}\n")
            else:
                L.append(f"\n{q['route']}: query {q['query_length_m']:.0f} m, NEGATIVE CONTROL (its road is not in the library; library {q['library_size']}): any confident answer is wrong\n")
            L.append("| score | truth rank | n distinct | best | second | gap ratio | status | best scale | clamped | best overlaps truth |\n|---|---|---|---|---|---|---|---|---|---|")
            f4 = lambda x: "" if x is None else f"{x:.4g}"
            for k, v in q["per_key"].items():
                L.append(f"| {SHORT[k]} | {v['truth_rank']} | {v['n_distinct']} | {f4(v['best_score'])} | {f4(v['second_score'])} | {f4(v['gap_ratio'])} | {v['status']} | "
                         f"{v['best_scale']:.3f} | {v['best_scale_clamped']} | {f4(v['best_overlap_with_truth'])} |")
    return "\n".join(L) + "\n"
