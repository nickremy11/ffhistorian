#!/usr/bin/env python3
"""
List all unique ESPN members across all seasons 2013-2025.
Use this to build the nickname mapper.
"""

import requests
import json
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

LEAGUE_ID = 330437
# UPDATE THESE with your new cookies after rotating
ESPN_S2   = "AEBJ20pAnQwAJynysuacsjRjJ5UwELE7FbpiHOWfgSxgJIYVu8aWYRPSGMvNxIm7IYhhnbkTNFK63SP35wYYQzeOg9W0%2BYKgUGooI76R5BA4PkVS7txx%2BF1q42iDEVGEeP78Ij1WboF1siRJBHigtztYsOWLMBhNi3nih3V%2BqCiH9SstsrmgfvDxW8CdEIRn2rGsWiX3HKHIGds%2BWcP9Y8kcbuqut096hbvXon4YcEgKWwRRrjPmtIpB%2F7QFoEK7ZCR1sCjwtSTsY7bTWzRj60Pk7WLUPhu7RV169NAsL%2FWTUQrtizEPoI1o3J0nkHXM5SfixWh%2BI2xer9DdyDTTxK%2Fs"
SWID      = "{2BA44886-18D3-4188-B900-0A6D78249655}"

COOKIES = {"espn_s2": ESPN_S2, "SWID": SWID}
HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}

def fetch_members(year):
    if year <= 2017:
        url = (
            f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
            f"/leagueHistory/{LEAGUE_ID}?seasonId={year}&view=mTeam"
        )
        r = requests.get(url, cookies=COOKIES, headers=HEADERS, verify=False, timeout=10)
        if r.status_code != 200:
            return []
        data = r.json()
        data = data[0] if isinstance(data, list) else data
    else:
        url = (
            f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
            f"/seasons/{year}/segments/0/leagues/{LEAGUE_ID}?view=mTeam"
        )
        r = requests.get(url, cookies=COOKIES, headers=HEADERS, verify=False, timeout=10)
        if r.status_code != 200:
            return []
        data = r.json()

    return data.get("members", [])

# Collect all unique members across all seasons
# Key by ESPN user ID so dupes across seasons are collapsed
all_members = {}  # id → { displayName, firstName, lastName, seasons }

print("Fetching members from all seasons...")
for year in range(2013, 2026):
    members = fetch_members(year)
    if not members:
        print(f"  {year}: no members found")
        continue
    print(f"  {year}: {len(members)} members")
    for m in members:
        mid = m.get("id", "")
        if mid not in all_members:
            all_members[mid] = {
                "displayName": m.get("displayName", ""),
                "firstName":   m.get("firstName", ""),
                "lastName":    m.get("lastName", ""),
                "seasons": []
            }
        all_members[mid]["seasons"].append(year)

print(f"\n{'='*60}")
print(f"UNIQUE MEMBERS ({len(all_members)} total)")
print(f"{'='*60}")
print(f"{'ESPN ID':<45} {'Display Name':<25} {'First':<12} {'Last':<15} Seasons")
print("-" * 120)

for mid, m in sorted(all_members.items(), key=lambda x: x[1]["displayName"].lower()):
    seasons_str = f"{min(m['seasons'])}–{max(m['seasons'])}" if m["seasons"] else "?"
    print(f"{mid:<45} {m['displayName']:<25} {m['firstName']:<12} {m['lastName']:<15} {seasons_str}")

print(f"\n{'='*60}")
print("Copy the ESPN IDs above to build your nickname mapper.")
print("Format will be:")
print('  "ESPN_USER_ID": "Nickname",')