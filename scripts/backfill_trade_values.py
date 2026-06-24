#!/usr/bin/env python3
"""
FF Historian — Historical Trade Value Backfill (DynastyProcess)

Computes approximate "day-of" trade values for trades made BEFORE the
FantasyCalc cutoff (2026-07-01), using the git history of the public
dynastyprocess/data repo (each commit of values-players.csv is a dated
snapshot). Writes the same trade-values/{leagueId}.json shape the Worker
uses, MERGING into whatever already exists (so it never clobbers the
FantasyCalc freeze-on-read entries for post-cutoff trades).

DP values are a different model than FantasyCalc — absolute numbers differ.
The point is relative "was this trade good at the time" sentiment. Player
values match by sleeper_id when present, else by name. Pick values are
approximated at the (year, round) level (DP pick slots averaged per round).

Usage:
    python3 backfill_trade_values.py            # build files into ./out, print upload cmds
    python3 backfill_trade_values.py --upload   # also run wrangler r2 uploads
    python3 backfill_trade_values.py --league ncfl

Requires: git CLI, wrangler (only for --upload). Stdlib only otherwise.
"""

import argparse
import csv
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone

# ─── CONFIG ────────────────────────────────────────────────────────────────────
# Trades on/after this freeze FantasyCalc (handled by the Worker, not this script).
CUTOFF = datetime(2026, 7, 1, tzinfo=timezone.utc)
CUTOFF_MS = int(CUTOFF.timestamp() * 1000)

WORKER_BASE = "https://ffhistorian.com/api/league"
R2_BUCKET   = "ff-historian-espn"          # shared R2 bucket (trade-values/ prefix)
DP_REPO        = "https://github.com/dynastyprocess/data.git"
DP_PLAYER_PATHS = ["files/values-players.csv", "files/values.csv"]  # players carry value_2qb
DP_PICK_PATHS   = ["files/values-picks.csv"]                        # picks carry only ECR — converted below

OUT_DIR = os.path.join(os.path.dirname(__file__), "out", "trade-values")

# League id maps. Add other leagues here (folder -> {year: sleeper_league_id}).
LEAGUES = {
    "ncfl": {
        2022: "834179031011287040",
        2023: "917118347102236672",
        2024: "1050188337924902912",
        2025: "1180232430068178944",
        2026: "1312218053051678720",
    },
}

# ─── HTTP ──────────────────────────────────────────────────────────────────────

def get_json(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))

# ─── DP git-history snapshots (cached per date) ────────────────────────────────

class DPHistory:
    def __init__(self, repo_dir):
        self.repo = repo_dir
        self.cache = {}  # "YYYY-MM-DD" -> {"players": {pid|name: value}, "picks": {(year,round): value}}

    def _git(self, *args):
        return subprocess.run(
            ["git", "-C", self.repo, *args],
            capture_output=True, text=True
        )

    def _commit_before(self, date_str, path):
        r = self._git("log", "--before", f"{date_str} 23:59:59",
                      "-1", "--format=%H", "--", path)
        h = r.stdout.strip()
        return h or None

    def _file_at(self, commit, path):
        r = self._git("show", f"{commit}:{path}")
        return r.stdout if r.returncode == 0 else None

    def snapshot_for(self, date_str, name_to_pid):
        """Return DP value maps as of date_str (nearest commit <= date)."""
        if date_str in self.cache:
            return self.cache[date_str]

        players_csv = self._first_available(date_str, DP_PLAYER_PATHS)
        if not players_csv:
            print(f"  ! no DP player snapshot on/before {date_str}")
            self.cache[date_str] = {"players": {}, "picks": {}}
            return self.cache[date_str]

        players, ecr_curve = self._parse_players(players_csv, name_to_pid)

        picks = {}
        picks_csv = self._first_available(date_str, DP_PICK_PATHS)
        if picks_csv and ecr_curve:
            picks = self._parse_picks(picks_csv, ecr_curve)

        snap = {"players": players, "picks": picks}
        self.cache[date_str] = snap
        return snap

    def _first_available(self, date_str, paths):
        for path in paths:
            commit = self._commit_before(date_str, path)
            if not commit:
                continue
            text = self._file_at(commit, path)
            if text:
                return text
        return None

    @staticmethod
    def _pick_col(fieldnames, candidates):
        low = {f.lower(): f for f in fieldnames}
        for c in candidates:
            if c in low:
                return low[c]
        return None

    def _parse_players(self, text, name_to_pid):
        """players: {pid: value_2qb};  ecr_curve: sorted [(ecr_2qb, value)] for pick conversion."""
        reader = csv.DictReader(io.StringIO(text))
        fns = reader.fieldnames or []
        # Superflex/2QB to match the FantasyCalc 2QB feed; fall back to 1QB on very old files.
        val_col  = self._pick_col(fns, ["value_2qb", "value_sf", "sf_value", "value", "value_1qb"])
        ecr_col  = self._pick_col(fns, ["ecr_2qb", "ecr_sf", "ecr_1qb"])
        name_col = self._pick_col(fns, ["player", "merge_name", "player_name", "name"])
        id_col   = self._pick_col(fns, ["sleeper_id", "sleeperid", "sleeper"])  # absent in current files
        if not val_col or not name_col:
            print(f"  ! unexpected DP player columns: {fns}")
            return {}, []

        players = {}
        curve = []  # (ecr, value)
        for row in reader:
            try:
                val = float(row.get(val_col) or 0)
            except ValueError:
                continue
            if val <= 0:
                continue
            name = (row.get(name_col) or "").strip()
            pid = (row.get(id_col) or "").strip() if id_col else ""
            if not pid:
                pid = name_to_pid.get(_norm_name(name))
            if pid:
                players[str(pid)] = round(val)
            if ecr_col:
                try:
                    curve.append((float(row[ecr_col]), val))
                except (ValueError, TypeError, KeyError):
                    pass

        curve.sort(key=lambda t: t[0])
        return players, curve

    def _parse_picks(self, text, ecr_curve):
        """picks: {(year, round): value} — pick ECR mapped onto the player value scale."""
        reader = csv.DictReader(io.StringIO(text))
        fns = reader.fieldnames or []
        ecr_col  = self._pick_col(fns, ["ecr_2qb", "ecr_sf", "ecr_1qb"])
        name_col = self._pick_col(fns, ["player", "name"])
        if not ecr_col or not name_col:
            print(f"  ! unexpected DP pick columns: {fns}")
            return {}

        round_vals = {}  # (year, round) -> [values]
        for row in reader:
            name = (row.get(name_col) or "").strip()
            ym = re.search(r"20(\d\d)", name)
            rnd = _round_from_name(name)
            if not ym or not rnd:
                continue
            try:
                ecr = float(row[ecr_col])
            except (ValueError, TypeError, KeyError):
                continue
            year = int("20" + ym.group(1))
            round_vals.setdefault((year, rnd), []).append(_ecr_to_value(ecr, ecr_curve))

        return {k: round(sum(v) / len(v)) for k, v in round_vals.items()}


def _round_from_name(name):
    n = name.lower()
    m = re.search(r"\b([1-6])\.\d", n)        # "1.05" slot form
    if m:
        return int(m.group(1))
    for pat, r in [(r"1st|first", 1), (r"2nd|second", 2), (r"3rd|third", 3),
                   (r"4th|fourth", 4), (r"5th|fifth", 5), (r"6th|sixth", 6)]:
        if re.search(pat, n):
            return r
    m = re.search(r"round\s*([1-6])", n)
    return int(m.group(1)) if m else 0


def _norm_name(name):
    return re.sub(r"[^a-z]", "", (name or "").lower())


def _ecr_to_value(ecr, curve):
    """Linear-interpolate a value from the players' (ecr, value) curve (ecr ascending)."""
    if not curve:
        return 0.0
    if ecr <= curve[0][0]:
        return curve[0][1]
    if ecr >= curve[-1][0]:
        return curve[-1][1]
    lo, hi = 0, len(curve) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if curve[mid][0] <= ecr:
            lo = mid
        else:
            hi = mid
    (e0, v0), (e1, v1) = curve[lo], curve[hi]
    if e1 == e0:
        return v0
    return v0 + (v1 - v0) * (ecr - e0) / (e1 - e0)

# ─── Backfill ──────────────────────────────────────────────────────────────────

def build_name_to_pid():
    """Sleeper full_name -> player_id, for DP rows lacking a sleeper_id."""
    print("Fetching Sleeper player map…")
    players = get_json("https://ffhistorian.com/api/players")
    out = {}
    for pid, p in players.items():
        nm = p.get("full_name")
        if nm:
            out[_norm_name(nm)] = pid
    return out


def backfill_league(folder, seasons, dp, name_to_pid):
    by_league = {}  # leagueId -> merged frozen dict
    for year, lid in sorted(seasons.items()):
        try:
            trades = get_json(f"{WORKER_BASE}/{lid}/trades")
        except Exception as e:
            print(f"  {year} ({lid}): trades fetch failed: {e}")
            continue

        # Start from whatever's already stored so we never clobber FC entries.
        try:
            existing = get_json(f"{WORKER_BASE}/{lid}/trade-values")
        except Exception:
            existing = {}
        frozen = dict(existing)

        added = 0
        for tx in trades:
            ts = tx.get("status_updated") or 0
            if ts >= CUTOFF_MS:
                continue  # FC handles these
            txid = tx.get("transaction_id")
            if not txid or txid in frozen:
                continue
            date_str = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            snap = dp.snapshot_for(date_str, name_to_pid)

            rec = {"source": "DP", "asOf": date_str, "players": {}, "picks": {}}
            for pid in (tx.get("adds") or {}).keys():
                rec["players"][pid] = snap["players"].get(str(pid), 0)
            for p in (tx.get("draft_picks") or []):
                key = f'{p.get("season")}:{p.get("round")}:{p.get("roster_id")}'
                try:
                    yr, rnd = int(p.get("season")), int(p.get("round"))
                except (TypeError, ValueError):
                    rec["picks"][key] = 0
                    continue
                rec["picks"][key] = snap["picks"].get((yr, rnd), 0)
            frozen[txid] = rec
            added += 1

        if lid in by_league:
            by_league[lid].update(frozen)
        else:
            by_league[lid] = frozen
        print(f"  {year} ({lid}): +{added} DP-valued trades ({len(frozen)} total)")
    return by_league


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--league", help="only this league folder (default: all)")
    ap.add_argument("--upload", action="store_true", help="run wrangler r2 uploads")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    name_to_pid = build_name_to_pid()

    with tempfile.TemporaryDirectory() as tmp:
        repo_dir = os.path.join(tmp, "dp-data")
        print("Cloning dynastyprocess/data (full history, blobless)…")
        subprocess.run(
            ["git", "clone", "--filter=blob:none", DP_REPO, repo_dir],
            check=True
        )
        dp = DPHistory(repo_dir)

        targets = {args.league: LEAGUES[args.league]} if args.league else LEAGUES
        upload_cmds = []
        for folder, seasons in targets.items():
            print(f"\n=== {folder} ===")
            by_league = backfill_league(folder, seasons, dp, name_to_pid)
            for lid, frozen in by_league.items():
                out_path = os.path.join(OUT_DIR, f"{lid}.json")
                with open(out_path, "w") as f:
                    json.dump(frozen, f)
                upload_cmds.append(
                    f'wrangler r2 object put {R2_BUCKET}/trade-values/{lid}.json '
                    f'--file="{out_path}" --content-type=application/json --remote'
                )

    print("\nWrote files to", OUT_DIR)
    print("\nUpload to R2 with:")
    for c in upload_cmds:
        print("  " + c)

    if args.upload:
        print("\nUploading…")
        for c in upload_cmds:
            subprocess.run(c, shell=True, check=False)


if __name__ == "__main__":
    main()
