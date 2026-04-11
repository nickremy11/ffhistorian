#!/usr/bin/env python3
"""
FF Historian — League Updater
Applies common changes across all Sleeper league index.html files.

Usage:
    python3 update_leagues.py
"""

import os
import re
from datetime import datetime

# ─── CONFIG ────────────────────────────────────────────────────────────────────
PAGES_DIR = os.path.join(os.path.dirname(__file__), "..", "pages")
LOG_FILE  = os.path.join(os.path.dirname(__file__), "..", "logs", "update_log.txt")

# ESPN leagues and any other folders to always skip
SKIP_FOLDERS = {"eliteffl", "wolfpack", "assets", "_redirects"}

# ─── HELPERS ───────────────────────────────────────────────────────────────────

def get_league_folders():
    """Return sorted list of Sleeper league folder names."""
    folders = []
    for name in sorted(os.listdir(PAGES_DIR)):
        if name in SKIP_FOLDERS:
            continue
        path = os.path.join(PAGES_DIR, name, "index.html")
        if not os.path.isfile(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        if "const LEAGUE_CONFIG" not in content:
            continue
        folders.append(name)
    return folders


def read_file(folder):
    path = os.path.join(PAGES_DIR, folder, "index.html")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write_file(folder, content):
    path = os.path.join(PAGES_DIR, folder, "index.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def show_preview(changes):
    """
    changes: list of { folder, description, before_line, after_line }
    Returns True if user confirms, False otherwise.
    """
    if not changes:
        print("\n  No changes to make.")
        return False

    print("\n── Preview ────────────────────────────────────────────────")
    for c in changes:
        print(f"\n  [{c['folder']}]  {c['description']}")
        print(f"    BEFORE: {c['before_line'].strip()}")
        print(f"    AFTER:  {c['after_line'].strip()}")
    print("\n────────────────────────────────────────────────────────────")

    answer = input("\nApply these changes? (y/n): ").strip().lower()
    return answer == "y"


def log_run(changes, update_type):
    """Append a run record to update_log.txt."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = [f"\n[{timestamp}]  {update_type}"]
    if not changes:
        lines.append("  No changes applied.")
    else:
        for c in changes:
            lines.append(f"  [{c['folder']}]  {c['description']}")
            lines.append(f"    BEFORE: {c['before_line'].strip()}")
            lines.append(f"    AFTER:  {c['after_line'].strip()}")
    lines.append("-" * 60)

    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


# ─── UPDATE FUNCTIONS ──────────────────────────────────────────────────────────

def add_season(folders):
    """Add a new year: leagueId entry to LEAGUE_CONFIG.seasons in each file."""
    year = input("\nEnter the season year to add (e.g. 2026): ").strip()
    if not year.isdigit():
        print("  Invalid year.")
        return

    print(f"\nEnter the Sleeper league ID for {year} in each league.")
    print("Press Enter to skip a league.\n")

    per_league = {}
    for folder in folders:
        lid = input(f"  {folder}: ").strip()
        if lid:
            per_league[folder] = lid

    if not per_league:
        print("  No IDs entered, nothing to do.")
        return

    changes = []
    contents = {}

    for folder, lid in per_league.items():
        content = read_file(folder)
        contents[folder] = content

        # Find the last entry in the seasons block and insert after it
        # Matches lines like:    2025: "123456",
        pattern = r'((\s+)(\d{4}):\s*"[^"]+",?\s*\n)(\s*},\s*\n\s*(?:draftIds|hasDivisions))'
        match = re.search(pattern, content)
        if not match:
            print(f"  [{folder}] Could not find seasons block — skipping.")
            continue

        last_season_line = match.group(1)
        indent = match.group(2)
        new_line = f'{indent}{year}: "{lid}",\n'
        before_line = last_season_line
        after_line = last_season_line + new_line

        changes.append({
            "folder": folder,
            "description": f"Add season {year}: {lid}",
            "before_line": before_line.rstrip(),
            "after_line": after_line.rstrip(),
            "pattern": last_season_line,
            "replacement": last_season_line + new_line,
        })

    if not show_preview(changes):
        log_run([], f"Add season {year} — cancelled")
        return

    for c in changes:
        contents[c["folder"]] = contents[c["folder"]].replace(
            c["pattern"], c["replacement"], 1
        )
        write_file(c["folder"], contents[c["folder"]])

    print(f"\n  ✅ Applied {len(changes)} change(s).")
    log_run(changes, f"Add season {year}")


def add_draft_id(folders):
    """Add a new year: draftId entry to LEAGUE_CONFIG.draftIds in each file."""
    year = input("\nEnter the draft year to add (e.g. 2026): ").strip()
    if not year.isdigit():
        print("  Invalid year.")
        return

    print(f"\nEnter the Sleeper draft ID for {year} in each league.")
    print("Press Enter to skip a league.\n")

    per_league = {}
    for folder in folders:
        did = input(f"  {folder}: ").strip()
        if did:
            per_league[folder] = did

    if not per_league:
        print("  No IDs entered, nothing to do.")
        return

    changes = []
    contents = {}

    for folder, did in per_league.items():
        content = read_file(folder)
        contents[folder] = content

        # Find the draftIds block and insert the new entry before the closing brace
        # Matches the closing },  of draftIds followed by hasDivisions or end of config
        pattern = r'((\s+)(\d{4}):\s*"[^"]+",?\s*\n)(\s*},?\s*\n\s*hasDivisions)'
        match = re.search(pattern, content)
        if not match:
            # draftIds block might be empty or have different structure
            # Try to find an empty draftIds block
            empty_pattern = r'(draftIds:\s*\{\s*\n)(\s*\},)'
            empty_match = re.search(empty_pattern, content)
            if empty_match:
                indent = "    "
                new_line = f'{indent}{year}: "{did}",\n'
                before_line = empty_match.group(0)
                after_line = empty_match.group(1) + new_line + empty_match.group(2)
                changes.append({
                    "folder": folder,
                    "description": f"Add draft ID {year}: {did}",
                    "before_line": before_line.strip(),
                    "after_line": after_line.strip(),
                    "pattern": before_line,
                    "replacement": after_line,
                })
            else:
                print(f"  [{folder}] Could not find draftIds block — skipping.")
            continue

        last_draft_line = match.group(1)
        indent = match.group(2)
        new_line = f'{indent}{year}: "{did}",\n'
        before_line = last_draft_line
        after_line = last_draft_line + new_line

        changes.append({
            "folder": folder,
            "description": f"Add draft ID {year}: {did}",
            "before_line": before_line.rstrip(),
            "after_line": after_line.rstrip(),
            "pattern": last_draft_line,
            "replacement": last_draft_line + new_line,
        })

    if not show_preview(changes):
        log_run([], f"Add draft ID {year} — cancelled")
        return

    for c in changes:
        contents[c["folder"]] = contents[c["folder"]].replace(
            c["pattern"], c["replacement"], 1
        )
        write_file(c["folder"], contents[c["folder"]])

    print(f"\n  ✅ Applied {len(changes)} change(s).")
    log_run(changes, f"Add draft ID {year}")


def update_banner(folders):
    """Append a new year to the banner-seasons line in each file."""
    new_year = input("\nEnter the year to append to the banner (e.g. 2026): ").strip()
    if not new_year.isdigit():
        print("  Invalid year.")
        return

    changes = []
    contents = {}

    for folder in folders:
        content = read_file(folder)
        contents[folder] = content

        # Find the banner-seasons line e.g. <p class="banner-seasons">2022 · 2023 · 2025</p>
        match = re.search(r'(<p class="banner-seasons">)(.*?)(</p>)', content)
        if not match:
            print(f"  [{folder}] Could not find banner-seasons line — skipping.")
            continue

        current = match.group(2).strip()

        # Skip if year already present
        if new_year in current:
            continue

        new_content = f'{match.group(1)}{current} · {new_year}{match.group(3)}'
        before_line = match.group(0)
        after_line = new_content

        changes.append({
            "folder": folder,
            "description": f"Append {new_year} to banner",
            "before_line": before_line,
            "after_line": after_line,
            "pattern": before_line,
            "replacement": after_line,
        })

    if not show_preview(changes):
        log_run([], f"Update banner to add {new_year} — cancelled")
        return

    for c in changes:
        contents[c["folder"]] = contents[c["folder"]].replace(
            c["pattern"], c["replacement"], 1
        )
        write_file(c["folder"], contents[c["folder"]])

    print(f"\n  ✅ Applied {len(changes)} change(s).")
    log_run(changes, f"Update banner — appended {new_year}")


def find_and_replace(folders):
    """Generic find & replace across all league files."""
    print("\nEnter the exact string to find (use \\n for newline):")
    search  = input("  Find:    ").replace("\\n", "\n")
    print("Enter the replacement string (use \\n for newline):")
    replace = input("  Replace: ").replace("\\n", "\n")

    if not search:
        print("  Nothing to search for.")
        return

    changes = []
    contents = {}

    for folder in folders:
        content = read_file(folder)
        contents[folder] = content

        if search not in content:
            continue

        # Find the line containing the search string for preview
        for line in content.splitlines():
            if search.splitlines()[0] in line:
                before_line = line
                break
        else:
            before_line = search[:80]

        after_line = before_line.replace(search.splitlines()[0], replace.splitlines()[0])

        changes.append({
            "folder": folder,
            "description": "Find & replace",
            "before_line": before_line,
            "after_line": after_line,
            "pattern": search,
            "replacement": replace,
        })

    if not show_preview(changes):
        log_run([], "Find & replace — cancelled")
        return

    for c in changes:
        contents[c["folder"]] = contents[c["folder"]].replace(
            c["pattern"], c["replacement"]
        )
        write_file(c["folder"], contents[c["folder"]])

    print(f"\n  ✅ Applied {len(changes)} change(s).")
    log_run(changes, f"Find & replace: '{search[:40]}' → '{replace[:40]}'")


# ─── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    print("╔══════════════════════════════════════╗")
    print("║   FF Historian — League Updater      ║")
    print("╚══════════════════════════════════════╝")

    folders = get_league_folders()
    if not folders:
        print(f"\n  No Sleeper league files found in {PAGES_DIR}")
        return

    print(f"\n  Found {len(folders)} Sleeper league(s): {', '.join(folders)}")

    print("""
What would you like to update?

  1. Add new season (league ID)
  2. Add new draft ID
  3. Update banner seasons (append year)
  4. Find & replace
  0. Exit
""")

    choice = input("Choose an option: ").strip()

    if choice == "1":
        add_season(folders)
    elif choice == "2":
        add_draft_id(folders)
    elif choice == "3":
        update_banner(folders)
    elif choice == "4":
        find_and_replace(folders)
    elif choice == "0":
        print("  Bye!")
    else:
        print("  Invalid option.")


if __name__ == "__main__":
    main()
