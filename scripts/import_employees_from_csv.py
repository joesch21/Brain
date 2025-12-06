#!/usr/bin/env python
r"""
Import employees from a CSV file into the Brain database.

- Safe to run multiple times (upsert by name and/or code).
- Designed to be run from PowerShell:
    python .\scripts\import_employees_from_csv.py .\data\employees.csv
"""

import csv
import os
import sys
from dataclasses import dataclass
from typing import Optional


# --- Database bootstrap (mirrors scripts/seed_office_data.py) -----------------

# Prefer a local SQLite database when no real DATABASE_URL is configured or a placeholder is detected.
placeholder_url = os.getenv("DATABASE_URL", "")
if not placeholder_url:
    os.environ["DATABASE_URL"] = "sqlite:///cc_office.db"
elif "@host:" in placeholder_url or placeholder_url.startswith("postgres://user:password@host"):
    os.environ["DATABASE_URL"] = "sqlite:///cc_office.db"

# Ensure the project root (where app.py lives) is on sys.path
ROOT = os.path.dirname(os.path.dirname(__file__))
if ROOT not in sys.path:
    sys.path.append(ROOT)

# Import app + models
from app import (  # type: ignore  # noqa: E402
    Employee,
    db,
    app,
)

# Staff model is optional; if present we also upsert into Staff.
try:  # noqa: E402
    from app import Staff  # type: ignore
except Exception:  # pragma: no cover
    Staff = None  # type: ignore


# --- Data structures ----------------------------------------------------------


@dataclass
class EmployeeRow:
    name: str
    role: Optional[str] = None
    shift: Optional[str] = None
    base: Optional[str] = None
    active: Optional[bool] = None
    code: Optional[str] = None
    employment_type: Optional[str] = None
    weekly_hours_target: Optional[int] = None
    notes: Optional[str] = None


# --- Helpers ------------------------------------------------------------------


def _to_bool(value: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    v = value.strip().lower()
    if v in ("1", "true", "yes", "y", "active"):
        return True
    if v in ("0", "false", "no", "n", "inactive"):
        return False
    return None


def _to_int(value: Optional[str]) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


def _safe_get(row: dict, key: str) -> Optional[str]:
    # Case-insensitive column lookup
    for k, v in row.items():
        if k.strip().lower() == key.lower():
            return v.strip() if isinstance(v, str) else v
    return None


def _parse_employee_row(row: dict) -> Optional[EmployeeRow]:
    """
    Parse a CSV row into EmployeeRow.

    Required: name or code. If both missing, row is ignored.
    """
    name = _safe_get(row, "name")
    code = _safe_get(row, "code")

    if not name and not code:
        return None

    role = _safe_get(row, "role")
    shift = _safe_get(row, "shift")
    base = _safe_get(row, "base")
    notes = _safe_get(row, "notes")

    active_raw = _safe_get(row, "active")
    active = _to_bool(active_raw)

    employment_type = _safe_get(row, "employment_type")
    weekly_hours = _to_int(_safe_get(row, "weekly_hours_target"))

    if code:
        code = code.strip().upper()

    return EmployeeRow(
        name=name or code or "",
        role=role,
        shift=shift,
        base=base,
        active=active,
        code=code,
        employment_type=employment_type,
        weekly_hours_target=weekly_hours,
        notes=notes,
    )


# --- Core import logic --------------------------------------------------------


def import_employees_from_csv(path: str) -> dict:
    """
    Import employees from a CSV file.

    Upsert rules:
    - If 'code' is present and Employee has a matching attribute, upsert by code.
    - Else upsert by name.
    - If Staff model exists and 'code' is present, create/update Staff as well.

    Returns summary dict: {processed, created, updated, skipped}.
    """
    processed = created = updated = skipped = 0

    if not os.path.isfile(path):
        raise FileNotFoundError(f"CSV file not found: {path}")

    with app.app_context():
        # Open CSV with universal newline support
        with open(path, mode="r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            for raw_row in reader:
                processed += 1
                try:
                    emp_row = _parse_employee_row(raw_row)
                    if not emp_row:
                        skipped += 1
                        continue

                    # ----- Upsert into Employee --------------------------------
                    # Prefer matching by code if Employee has a code field.
                    employee = None
                    has_code_attr = hasattr(Employee, "code")

                    if has_code_attr and emp_row.code:
                        employee = Employee.query.filter_by(code=emp_row.code).first()

                    if not employee and emp_row.name:
                        employee = Employee.query.filter_by(name=emp_row.name).first()

                    is_new = employee is None
                    if is_new:
                        employee = Employee()  # type: ignore

                    # Assign basic fields; only touch attributes that exist on the model.
                    if hasattr(employee, "name") and emp_row.name:
                        employee.name = emp_row.name  # type: ignore
                    if has_code_attr and emp_row.code:
                        employee.code = emp_row.code  # type: ignore
                    if hasattr(employee, "role") and emp_row.role:
                        employee.role = emp_row.role  # type: ignore
                    if hasattr(employee, "shift") and emp_row.shift:
                        employee.shift = emp_row.shift  # type: ignore
                    if hasattr(employee, "base") and emp_row.base:
                        employee.base = emp_row.base  # type: ignore
                    if hasattr(employee, "notes") and emp_row.notes:
                        employee.notes = emp_row.notes  # type: ignore
                    if hasattr(employee, "employment_type") and emp_row.employment_type:
                        employee.employment_type = emp_row.employment_type  # type: ignore
                    if hasattr(employee, "weekly_hours_target") and emp_row.weekly_hours_target is not None:
                        employee.weekly_hours_target = emp_row.weekly_hours_target  # type: ignore
                    if hasattr(employee, "active"):
                        # If CSV specifies active explicitly, use it; otherwise default True for new employees.
                        if emp_row.active is not None:
                            employee.active = emp_row.active  # type: ignore
                        elif is_new:
                            employee.active = True  # type: ignore

                    if is_new:
                        db.session.add(employee)

                    # ----- Optional: upsert into Staff -------------------------
                    if Staff is not None and emp_row.code:
                        staff = Staff.query.filter_by(code=emp_row.code).first()  # type: ignore
                        staff_is_new = staff is None
                        if staff_is_new:
                            staff = Staff(code=emp_row.code, name=emp_row.name)  # type: ignore

                        if hasattr(staff, "name") and emp_row.name:
                            staff.name = emp_row.name  # type: ignore
                        if hasattr(staff, "employment_type") and emp_row.employment_type:
                            staff.employment_type = emp_row.employment_type  # type: ignore
                        if hasattr(staff, "weekly_hours_target") and emp_row.weekly_hours_target is not None:
                            staff.weekly_hours_target = emp_row.weekly_hours_target  # type: ignore
                        if hasattr(staff, "notes") and emp_row.notes:
                            staff.notes = emp_row.notes  # type: ignore
                        if hasattr(staff, "active"):
                            if emp_row.active is not None:
                                staff.active = emp_row.active  # type: ignore
                            elif staff_is_new:
                                staff.active = True  # type: ignore

                        if staff_is_new:
                            db.session.add(staff)

                    if is_new:
                        created += 1
                    else:
                        updated += 1

                except Exception as exc:
                    # Log and skip bad rows without crashing the whole import
                    skipped += 1
                    print(f"[WARN] Skipping row #{processed} due to error: {exc!r}")

            db.session.commit()

    summary = {
        "processed": processed,
        "created": created,
        "updated": updated,
        "skipped": skipped,
    }
    print(
        f"Import complete. Processed={processed}, created={created}, "
        f"updated={updated}, skipped={skipped}"
    )
    return summary


# --- CLI entrypoint -----------------------------------------------------------


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Usage: python scripts/import_employees_from_csv.py <path-to-csv>")
        return 1

    csv_path = argv[1]
    try:
        summary = import_employees_from_csv(csv_path)
        print("Summary:", summary)
        return 0
    except FileNotFoundError as e:
        print(f"[ERROR] {e}")
        return 2
    except Exception as e:
        print(f"[ERROR] Unexpected error: {e!r}")
        return 3


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
