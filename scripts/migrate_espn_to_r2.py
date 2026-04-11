#!/usr/bin/env python3
"""
FF Historian — ESPN to R2 Migration Script
Fetches all seasons for Elite FFL (2013-2025) and uploads to R2.

Usage:
    python3 migrate_espn_to_r2.py

Requirements:
    pip3 install requests boto3
"""
    

R2_ACCESS_KEY_ID= "REPLACE"
R2_SECRET_ACCESS_KEY= "REPLACE"
R2_ENDPOINT= "REPLACE"

import requests
import json
import os
import sys
import time
import urllib3
import boto3
from botocore.config import Config

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ── CONFIG ──────────────────────────────────────────────────
LEAGUE_ID  = 330437
LEAGUE_KEY = "eliteffl"   # R2 path prefix: espn/eliteffl/YYYY.json

# Update these with your current cookies
ESPN_S2   = "AEBJ20pAnQwAJynysuacsjRjJ5UwELE7FbpiHOWfgSxgJIYVu8aWYRPSGMvNxIm7IYhhnbkTNFK63SP35wYYQzeOg9W0%2BYKgUGooI76R5BA4PkVS7txx%2BF1q42iDEVGEeP78Ij1WboF1siRJBHigtztYsOWLMBhNi3nih3V%2BqCiH9SstsrmgfvDxW8CdEIRn2rGsWiX3HKHIGds%2BWcP9Y8kcbuqut096hbvXon4YcEgKWwRRrjPmtIpB%2F7QFoEK7ZCR1sCjwtSTsY7bTWzRj60Pk7WLUPhu7RV169NAsL%2FWTUQrtizEPoI1o3J0nkHXM5SfixWh%2BI2xer9DdyDTTxK%2Fs"
SWID    = "{2BA44886-18D3-4188-B900-0A6D78249655}"

SEASONS_LEGACY  = list(range(2013, 2018))  # leagueHistory endpoint
SEASONS_MODERN  = list(range(2018, 2026))  # standard seasons endpoint
ALL_SEASONS     = SEASONS_LEGACY + SEASONS_MODERN

COOKIES = {"espn_s2": ESPN_S2, "SWID": SWID}
HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}

# ── R2 CLIENT ───────────────────────────────────────────────
def get_r2_client():
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )

BUCKET = "ff-historian-espn"

# ── ESPN FETCHERS ────────────────────────────────────────────
def fetch_espn(url):
    r = requests.get(url, cookies=COOKIES, headers=HEADERS, verify=False, timeout=15)
    if r.status_code != 200:
        return None, r.status_code
    return r.json(), 200

def fetch_season(year):
    """Fetch all views for a season and merge into one object."""
    print(f"\n  Fetching {year}...")

    if year <= 2017:
        base = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/{LEAGUE_ID}?seasonId={year}"
        def get(view):
            data, status = fetch_espn(f"{base}&view={view}")
            if data is None:
                return None, status
            # leagueHistory returns a list with one item
            return (data[0] if isinstance(data, list) else data), 200
    else:
        base = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{year}/segments/0/leagues/{LEAGUE_ID}"
        def get(view):
            return fetch_espn(f"{base}?view={view}")

    # Fetch each view
    team_data,     s1 = get("mTeam")
    matchup_data,  s2 = get("mMatchupScore")
    standing_data, s3 = get("mStandings")

    if not team_data:
        print(f"    ❌ mTeam failed ({s1})")
        return None

    members = team_data.get("members", [])
    teams   = team_data.get("teams", [])
    status  = team_data.get("status", {})
    schedule = matchup_data.get("schedule", []) if matchup_data else []

    print(f"    ✅ {len(members)} members, {len(teams)} teams, {len(schedule)} matchups")

    return {
        "seasonId": year,
        "members":  members,
        "teams":    teams,
        "schedule": schedule,
        "status":   status,
    }

# ── R2 UPLOAD ────────────────────────────────────────────────
def upload_season(client, year, data):
    key  = f"espn/{LEAGUE_KEY}/{year}.json"
    body = json.dumps(data, separators=(",", ":"))
    client.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=body.encode("utf-8"),
        ContentType="application/json",
    )
    size_kb = len(body) / 1024
    print(f"    ✅ Uploaded → {key} ({size_kb:.1f} KB)")

def upload_trades_placeholder(client):
    """Upload an empty trades file — populate manually later."""
    key  = f"espn/{LEAGUE_KEY}/trades.json"
    body = json.dumps([], separators=(",", ":"))
    client.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=body.encode("utf-8"),
        ContentType="application/json",
    )
    print(f"    ✅ Uploaded placeholder → {key}")

# ── MAIN ─────────────────────────────────────────────────────
def main():
    print("╔══════════════════════════════════════════╗")
    print("║  FF Historian — ESPN → R2 Migration      ║")
    print(f"║  League: Elite FFL ({LEAGUE_ID})          ║")
    print("╚══════════════════════════════════════════╝")

    # Validate cookies are set
    if "PASTE_" in ESPN_S2 or "PASTE_" in SWID:
        print("\n❌ Please update ESPN_S2 and SWID in the script before running.")
        sys.exit(1)

    print("\nConnecting to R2...")
    client = get_r2_client()
    print("✅ R2 connected")

    failed  = []
    success = []

    for year in ALL_SEASONS:
        data = fetch_season(year)
        if data is None:
            failed.append(year)
            continue
        try:
            upload_season(client, year, data)
            success.append(year)
        except Exception as e:
            print(f"    ❌ Upload failed: {e}")
            failed.append(year)
        time.sleep(0.5)  # be polite to ESPN API

    # Upload empty trades placeholder
    print("\n  Uploading trades placeholder...")
    try:
        upload_trades_placeholder(client)
    except Exception as e:
        print(f"  ❌ Trades placeholder failed: {e}")

    print(f"\n{'='*50}")
    print(f"✅ Success: {len(success)} seasons — {success}")
    if failed:
        print(f"❌ Failed:  {len(failed)} seasons — {failed}")
    print("Migration complete.")

if __name__ == "__main__":
    main()