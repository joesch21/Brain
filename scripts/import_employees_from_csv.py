"""CLI helper to import employees from a CSV file."""

import sys
from pathlib import Path

from app import app
from scripts.employee_importer import format_import_summary, import_employees_from_csv


def main(argv: list[str] | None = None) -> int:
    argv = argv or sys.argv[1:]

    if not argv:
        print("Usage: python scripts/import_employees_from_csv.py path/to/file.csv")
        return 1

    csv_path = Path(argv[0])

    with app.app_context():
        summary = import_employees_from_csv(csv_path)
    print(format_import_summary(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
