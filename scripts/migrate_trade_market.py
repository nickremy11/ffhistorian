#!/usr/bin/env python3
"""
Propagate the Trade Market feature from pages/ncfl/index.html to the other
league pages. The feature lives in 4 contiguous regions; since every target
page is byte-identical to ncfl's pre-feature state in those regions, we extract
each region's old/new text from ncfl (pre-feature vs current) and swap it in.

Run from anywhere; uses git to read ncfl's pre-feature version.

    python3 scripts/migrate_trade_market.py            # dry run (report only)
    python3 scripts/migrate_trade_market.py --write     # apply
"""

import argparse
import os
import subprocess
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
PAGES = os.path.join(ROOT, "pages")
NCFL = os.path.join(PAGES, "ncfl", "index.html")

TARGETS = ["2wayinsanity1", "2wayinsanity2", "bblucky14", "dynasty1point0",
           "emmys", "fugazi", "lateroundmusic", "sickos", "souschefs"]

# Each region is [start_marker, end_marker(exclusive)] — end searched AFTER start.
# Tight markers around the two pick-helper edits avoid league-specific lines
# (e.g. dynasty1point0's rookie-draft year filter) that sit in the same function.
REGIONS = [
    ("let playerMap = {};", "// INIT"),                          # state vars + FC/trade-value loaders
    ("const drafted = pick.player_id", "\n      });"),           # pick -> pid storage
    ("  // Fallback if draft_order wasn't available", "\nfunction playerName"),  # resolvePickPid
    ("// TRADES", "// LEAGUE RECORDS"),                          # helpers + loadTrades (render/winner/values)
    (".trade-arrow { align-self: center", "/* ── RECORDS TAB ── */"),  # market CSS
]


def slice_region(text, start, end, where):
    i = text.find(start)
    j = text.find(end, i + len(start)) if i >= 0 else -1
    if i < 0 or j < 0 or j <= i:
        sys.exit(f"FATAL: region [{start!r}..{end!r}] not found in {where}")
    return text[i:j]


def ncfl_pre_feature():
    commit = subprocess.run(
        ["git", "-C", ROOT, "log", "--oneline", "--all", "--grep=trade market calc", "--format=%H"],
        capture_output=True, text=True).stdout.split()
    if not commit:
        sys.exit("FATAL: could not find the 'trade market calc' commit")
    old = subprocess.run(["git", "-C", ROOT, "show", f"{commit[0]}^:pages/ncfl/index.html"],
                         capture_output=True, text=True)
    if old.returncode != 0:
        sys.exit("FATAL: could not read pre-feature ncfl")
    return old.stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="apply changes (default: dry run)")
    args = ap.parse_args()

    old_ncfl = ncfl_pre_feature()
    with open(NCFL) as f:
        new_ncfl = f.read()

    swaps = []  # (old_text, new_text)
    for start, end in REGIONS:
        o = slice_region(old_ncfl, start, end, "ncfl(pre)")
        n = slice_region(new_ncfl, start, end, "ncfl(now)")
        if o == n:
            sys.exit(f"FATAL: region [{start!r}] identical old vs new — feature not in ncfl?")
        swaps.append((o, n))

    print(f"Extracted {len(swaps)} region swaps from ncfl.\n")

    for t in TARGETS:
        path = os.path.join(PAGES, t, "index.html")
        with open(path) as f:
            content = f.read()
        if "trade-market-src" in content:
            print(f"  ⊘ {t}: already migrated, skipping")
            continue
        ok = True
        out = content
        for (o, n) in swaps:
            if out.count(o) != 1:
                print(f"  ✗ {t}: region anchor matched {out.count(o)}x (expected 1) — SKIPPED")
                ok = False
                break
            out = out.replace(o, n)
        if not ok:
            continue
        if args.write:
            with open(path, "w") as f:
                f.write(out)
            print(f"  ✓ {t}: migrated")
        else:
            print(f"  • {t}: ready (dry run)")

    if not args.write:
        print("\nDry run only. Re-run with --write to apply.")


if __name__ == "__main__":
    main()
