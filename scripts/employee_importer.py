from __future__ import annotations

"""Helpers to import employees from a CSV file."""

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from flask_sqlalchemy import SQLAlchemy

from app import Employee, app, db, ensure_employee_table


@dataclass
class ImportResult:
    processed: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "processed": self.processed,
            "created": self.created,
            "updated": self.updated,
            "skipped": self.skipped,
        }


def _parse_int(value: str | None) -> int | None:
    if value is None:
        return None

    value = str(value).strip()
    if value == "":
        return None

    return int(value)


def import_employees_from_csv(path: str | Path, *, session: SQLAlchemy | None = None) -> dict:
    """Import employees from the provided CSV path.

    The import is idempotent and keyed on the ``code`` column. Invalid rows are
    skipped without aborting the entire run.
    """

    session = session or db.session
    ensure_employee_table()

    result = ImportResult()
    csv_path = Path(path)
    if not csv_path.exists():
        raise FileNotFoundError(csv_path)

    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)

        for row in reader:
            code_raw = (row.get("code") or "").strip()
            if not code_raw:
                continue

            result.processed += 1
            code = code_raw.upper().replace(" ", "")

            weekly_hours_raw = row.get("weekly_hours_target", "")
            try:
                weekly_hours_target = _parse_int(weekly_hours_raw)
            except ValueError:
                app.logger.warning(
                    "[employee import] Skipping %s: invalid weekly_hours_target=%s",
                    code,
                    weekly_hours_raw,
                )
                result.skipped += 1
                continue

            existing = Employee.query.filter(Employee.code == code).first()
            if existing:
                existing.name = (row.get("name") or "").strip() or None
                existing.role = (row.get("role") or "").strip() or None
                existing.employment_type = (row.get("employment_type") or "").strip() or None
                existing.weekly_hours_target = weekly_hours_target
                existing.notes = (row.get("notes") or "").strip() or None
                existing.is_active = True
                result.updated += 1
            else:
                emp = Employee(
                    code=code,
                    name=(row.get("name") or "").strip() or None,
                    role=(row.get("role") or "").strip() or None,
                    employment_type=(row.get("employment_type") or "").strip() or None,
                    weekly_hours_target=weekly_hours_target,
                    notes=(row.get("notes") or "").strip() or None,
                    is_active=True,
                )
                session.add(emp)
                result.created += 1

    session.commit()
    return result.as_dict()


def format_import_summary(summary: dict[str, int]) -> str:
    return (
        "Processed: {processed}, Created: {created}, Updated: {updated}, Skipped: {skipped}".format(
            **summary
        )
    )


__all__: Iterable[str] = ["import_employees_from_csv", "format_import_summary"]
