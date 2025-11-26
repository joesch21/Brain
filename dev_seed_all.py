"""
dev_seed_all.py

Run both core DB seeding and office data seeding in one go.

Usage:
    python dev_seed_all.py
"""

import os
import sys


ROOT = os.path.dirname(__file__)
if ROOT not in sys.path:
    sys.path.append(ROOT)

# Import the core seed (users + basic flights)
from seed_db import seed as seed_core

# Make sure we can import scripts/seed_office_data.py
SCRIPTS_DIR = os.path.join(ROOT, "scripts")
if SCRIPTS_DIR not in sys.path:
    sys.path.append(SCRIPTS_DIR)

from seed_office_data import seed_office_data  # type: ignore


def main():
    # First: seed core users + basic flights
    print("[dev_seed_all] Seeding core users and flights…")
    seed_core()

    # Then: seed office data (employees, flights, roster, maintenance, audit)
    print("[dev_seed_all] Seeding office data…")
    seed_office_data()

    print("[dev_seed_all] Done. You can now log in as:")
    print("  - supervisor / superpass123")
    print("  - refueler  / refuelpass123  (if defined in seed_db.py)")
    print()
    print("Visit: /roster, /schedule, /maintenance, /machine-room")


if __name__ == "__main__":
    main()
