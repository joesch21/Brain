"""Populate the office manager tables with demo data.

Run with:
    python scripts/seed_office_data.py

It respects the DATABASE_URL environment variable already used by the Flask app.
"""

import datetime as dt

from app import AuditLog, Employee, Flight, MaintenanceItem, app, db


EMPLOYEES = [
    {"name": "Alice Green", "role": "Supervisor", "shift": "Day", "base": "SYD", "active": True},
    {"name": "Bob Smith", "role": "Refueler", "shift": "Night", "base": "SYD", "active": True},
    {"name": "Chris Lee", "role": "Driver", "shift": "Day", "base": "MEL", "active": True},
    {"name": "Dana Kapoor", "role": "Refueler", "shift": "Day", "base": "MEL", "active": False},
]


def seed_employees():
    created = 0
    for data in EMPLOYEES:
        emp = Employee.query.filter_by(name=data["name"]).first()
        if emp:
            emp.role = data["role"]
            emp.shift = data["shift"]
            emp.base = data["base"]
            emp.active = data["active"]
        else:
            emp = Employee(**data)
            db.session.add(emp)
            created += 1
    return created


def seed_flights():
    today = dt.date.today()
    flights = [
        {
            "flight_number": "QF101",
            "date": today + dt.timedelta(days=1),
            "origin": "SYD",
            "destination": "AKL",
            "eta_local": dt.time(9, 15),
            "etd_local": dt.time(10, 0),
            "tail_number": "VH-QFA",
            "truck_assignment": "Truck-1",
            "status": "On Time",
            "notes": "Morning crossing",
        },
        {
            "flight_number": "EK414",
            "date": today + dt.timedelta(days=2),
            "origin": "DXB",
            "destination": "SYD",
            "eta_local": dt.time(6, 30),
            "etd_local": dt.time(8, 0),
            "tail_number": "A6-ECA",
            "truck_assignment": "Truck-2",
            "status": "Delayed",
            "notes": "Overnight arrival",
        },
        {
            "flight_number": "JQ517",
            "date": today + dt.timedelta(days=1),
            "origin": "BNE",
            "destination": "SYD",
            "eta_local": dt.time(14, 45),
            "etd_local": dt.time(15, 25),
            "tail_number": "VH-VGZ",
            "truck_assignment": "Truck-3",
            "status": "On Time",
            "notes": "Standard turnaround",
        },
    ]

    created = 0
    for data in flights:
        existing = Flight.query.filter_by(
            flight_number=data["flight_number"], date=data["date"]
        ).first()
        if existing:
            existing.origin = data["origin"]
            existing.destination = data["destination"]
            existing.eta_local = data["eta_local"]
            existing.etd_local = data["etd_local"]
            existing.tail_number = data["tail_number"]
            existing.truck_assignment = data["truck_assignment"]
            existing.status = data["status"]
            existing.notes = data["notes"]
        else:
            db.session.add(Flight(**data))
            created += 1
    return created


def seed_maintenance_items():
    today = dt.date.today()
    items = [
        {
            "item_name": "Truck-1 – 5k service",
            "due_date": today + dt.timedelta(days=3),
            "status": "Scheduled",
            "priority": "Medium",
            "notes": "Oil + filters",
        },
        {
            "item_name": "Truck-2 – Brake inspection",
            "due_date": today + dt.timedelta(days=1),
            "status": "Due",
            "priority": "High",
            "notes": "Pads reported worn",
        },
        {
            "item_name": "Fuel bay pump calibration",
            "due_date": today + dt.timedelta(days=7),
            "status": "Planned",
            "priority": "Low",
            "notes": "Coordinate with vendor",
        },
    ]

    created = 0
    for data in items:
        existing = MaintenanceItem.query.filter_by(item_name=data["item_name"]).first()
        if existing:
            existing.due_date = data["due_date"]
            existing.status = data["status"]
            existing.priority = data["priority"]
            existing.notes = data["notes"]
        else:
            db.session.add(MaintenanceItem(**data))
            created += 1
    return created


def seed_audit_logs():
    if AuditLog.query.count() > 0:
        return 0

    now = dt.datetime.utcnow()
    entries = [
        AuditLog(
            entity_type="Employee",
            entity_id=1,
            action="create",
            description="Seeded initial supervisor and refueler crew.",
            actor_name="Seeder",
            actor_role="system",
            timestamp=now - dt.timedelta(minutes=3),
        ),
        AuditLog(
            entity_type="Flight",
            entity_id=1,
            action="create",
            description="Added first wave of scheduled flights.",
            actor_name="Seeder",
            actor_role="system",
            timestamp=now - dt.timedelta(minutes=2),
        ),
        AuditLog(
            entity_type="MaintenanceItem",
            entity_id=1,
            action="create",
            description="Loaded maintenance backlog.",
            actor_name="Seeder",
            actor_role="system",
            timestamp=now - dt.timedelta(minutes=1),
        ),
    ]
    db.session.add_all(entries)
    return len(entries)


def main():
    with app.app_context():
        db.create_all()

        new_employees = seed_employees()
        new_flights = seed_flights()
        new_maintenance = seed_maintenance_items()
        new_audit = seed_audit_logs()

        db.session.commit()

        print(
            f"Seed complete: {new_employees} employees, {new_flights} flights, "
            f"{new_maintenance} maintenance items, {new_audit} audit rows created or updated."
        )


if __name__ == "__main__":
    main()
