import os
import sys
from datetime import date, datetime, time, timedelta


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

from app import (  # noqa: E402
    AuditLog,
    Employee,
    Flight,
    MaintenanceItem,
    RosterEntry,
    RosterTemplateDay,
    RosterTemplateWeek,
    Staff,
    SYD_TZ,
    WeeklyRosterTemplate,
    app,
    db,
    ensure_flight_schema,
    ensure_roster_schema,
    log_audit,
)


def seed_office_data():
    """
    Seed local database with sample office data for /roster, /schedule, /maintenance and /machine-room.
    """
    today = date.today()

    with app.app_context():
        db.create_all()
        ensure_flight_schema()
        ensure_roster_schema()

        # Seed employees
        if Employee.query.count() == 0:
            alice = Employee(name="Alice", role="supervisor", shift="Day", base="SYD", active=True)
            bob = Employee(name="Bob", role="refueler", shift="Night", base="SYD", active=True)
            charlie = Employee(name="Charlie", role="refueler", shift="Day", base="SYD", active=True)
            db.session.add_all([alice, bob, charlie])

        # Seed flights
        if Flight.query.count() == 0:
            f1 = Flight(
                flight_number="QF123",
                operator_code="QF",
                time_local=time(9, 30),
                date=today,
                origin="MEL",
                destination="SYD",
                eta_local=datetime.combine(today, time(9, 30), tzinfo=SYD_TZ),
                etd_local=datetime.combine(today, time(10, 15), tzinfo=SYD_TZ),
                tail_number="VH-QFA",
                truck_assignment="Truck-1",
                status="Scheduled",
                notes="Morning bank",
            )
            next_day = today + timedelta(days=1)
            f2 = Flight(
                flight_number="SQ222",
                operator_code="SQ",
                time_local=time(16, 45),
                date=next_day,
                origin="SYD",
                destination="SIN",
                eta_local=datetime.combine(next_day, time(16, 45), tzinfo=SYD_TZ),
                etd_local=datetime.combine(next_day, time(18, 0), tzinfo=SYD_TZ),
                tail_number="9V-SYD",
                truck_assignment="Truck-2",
                status="Scheduled",
                notes="Evening departure",
            )
            db.session.add_all([f1, f2])

        # Seed roster entries (for /roster)
        if RosterEntry.query.count() == 0:
            r1 = RosterEntry(
                date=today,
                employee_name="Alice",
                role="supervisor",
                shift_start=time(6, 0),
                shift_end=time(14, 0),
                truck="Truck-1",
                notes="Day supervisor",
            )
            r2 = RosterEntry(
                date=today,
                employee_name="Bob",
                role="refueler",
                shift_start=time(14, 0),
                shift_end=time(22, 0),
                truck="Truck-2",
                notes="Night refueler",
            )
            db.session.add_all([r1, r2])

        if Staff.query.count() == 0:
            mg = Staff(
                name="Mary Green",
                code="MG",
                employment_type="FT",
                weekly_hours_target=38,
                active=True,
                skills=["domestic"],
            )
            tl = Staff(
                name="Tom Lee",
                code="TL",
                employment_type="FT",
                weekly_hours_target=38,
                active=True,
                skills=["intl"],
            )
            js = Staff(
                name="Jada Singh",
                code="JS",
                employment_type="PT",
                weekly_hours_target=24,
                active=True,
                skills=["domestic", "intl"],
            )
            db.session.add_all([mg, tl, js])
            db.session.flush()

            if RosterTemplateWeek.query.count() == 0:
                default_template = RosterTemplateWeek(
                    name="SYD_JQ_default_week_v1",
                    description="Default rotating roster for SYD JQ operations",
                    is_active=True,
                )
                db.session.add(default_template)
                db.session.flush()

                weekday_pattern = {
                    0: [(mg, "05:00", "15:00", "operator"), (tl, "06:00", "16:00", "supervisor")],
                    1: [(mg, "05:00", "15:00", "operator"), (js, "10:00", "18:00", "operator")],
                    2: [(tl, "06:00", "16:00", "supervisor"), (js, "10:00", "18:00", "operator")],
                    3: [(mg, "05:00", "15:00", "operator")],
                    4: [(tl, "06:00", "16:00", "supervisor"), (mg, "05:00", "15:00", "operator")],
                    5: [(js, "08:00", "16:00", "operator")],
                    6: [(tl, "06:00", "14:00", "supervisor")],
                }

                for weekday, shifts in weekday_pattern.items():
                    for staff_member, start_str, end_str, role in shifts:
                        start_parts = [int(part) for part in start_str.split(":")]
                        end_parts = [int(part) for part in end_str.split(":")]
                        db.session.add(
                            RosterTemplateDay(
                                template_id=default_template.id,
                                weekday=weekday,
                                staff_id=staff_member.id,
                                start_local=time(start_parts[0], start_parts[1]),
                                end_local=time(end_parts[0], end_parts[1]),
                                role=role,
                            )
                        )

        if WeeklyRosterTemplate.query.count() == 0:
            employees = {emp.name: emp for emp in Employee.query.all()}

            def add_template(name: str, weekday: int, role: str, start: time, end: time, truck: str, notes: str):
                emp = employees.get(name)
                if not emp:
                    return
                db.session.add(
                    WeeklyRosterTemplate(
                        employee_id=emp.id,
                        weekday=weekday,
                        role=role,
                        shift_start=start,
                        shift_end=end,
                        truck=truck,
                        notes=notes,
                    )
                )

            for weekday in range(0, 5):
                add_template(
                    "Alice",
                    weekday,
                    "supervisor",
                    time(6, 0),
                    time(14, 0),
                    "Truck-1",
                    "Day supervisor",
                )

            for weekday in range(1, 6):
                add_template(
                    "Bob",
                    weekday,
                    "refueler",
                    time(14, 0),
                    time(22, 0),
                    "Truck-2",
                    "Evening refueler",
                )

            for weekday in (0, 2, 4):
                add_template(
                    "Charlie",
                    weekday,
                    "refueler",
                    time(6, 0),
                    time(14, 0),
                    "Truck-3",
                    "Day refueler",
                )

        # Seed maintenance items
        if MaintenanceItem.query.count() == 0:
            m1 = MaintenanceItem(
                truck_id="Truck-1",
                description="Routine service",
                due_date=today + timedelta(days=3),
                status="OK",
            )
            m2 = MaintenanceItem(
                truck_id="Truck-2",
                description="Brake check",
                due_date=today + timedelta(days=1),
                status="Due",
            )
            m3 = MaintenanceItem(
                truck_id="Truck-3",
                description="Hydraulics inspection",
                due_date=today + timedelta(days=7),
                status="OK",
            )
            db.session.add_all([m1, m2, m3])

        # Simple audit entry so /machine-room has something to show
        if AuditLog.query.count() == 0:
            log_audit("seed", None, "seed", "Initial office data seeded for local testing.")

        db.session.commit()
        print("Office data seeded.")


if __name__ == "__main__":
    seed_office_data()
