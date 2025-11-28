from datetime import datetime, timedelta

from app import User, app, db, Employee, Flight, ensure_flight_schema


def seed():
    with app.app_context():
        db.create_all()
        ensure_flight_schema()

        if not User.query.filter_by(username="supervisor").first():
            sup = User(username="supervisor", role="supervisor")
            sup.set_password("superpass123")
            db.session.add(sup)

        if not User.query.filter_by(username="refueler").first():
            refueler = User(username="refueler", role="refueler")
            refueler.set_password("refueler123")
            db.session.add(refueler)

        if not Employee.query.first():
            crew = [
                Employee(name="Alice", role="Refueler", shift="Day", base="SYD"),
                Employee(name="Bob", role="Supervisor", shift="Night", base="SYD"),
                Employee(name="Charlie", role="Driver", shift="Day", base="SYD"),
            ]
            db.session.add_all(crew)

        if not Flight.query.first():
            # Seed a couple of flights using the actual model fields so Machine Room
            # has data to display in development.
            now = datetime.utcnow()

            flights = [
                Flight(
                    flight_number="QF123",
                    operator_code="QF",
                    time_local=(now + timedelta(hours=1)).time(),
                    date=now.date(),
                    origin="MEL",
                    destination="SYD",
                    eta_local=(now + timedelta(hours=1)).time(),
                    etd_local=(now + timedelta(hours=1, minutes=45)).time(),
                    tail_number="VH-QFA",
                    truck_assignment="Truck-1",
                    status="Scheduled",
                    notes="Morning bank",
                ),
                Flight(
                    flight_number="EK414",
                    operator_code="EK",
                    time_local=(now + timedelta(hours=3)).time(),
                    date=now.date(),
                    origin="SYD",
                    destination="DXB",
                    eta_local=(now + timedelta(hours=3)).time(),
                    etd_local=(now + timedelta(hours=4)).time(),
                    tail_number="A6-EKB",
                    truck_assignment="Truck-2",
                    status="Scheduled",
                    notes="Afternoon departure",
                ),
            ]
            db.session.add_all(flights)

        db.session.commit()


if __name__ == "__main__":
    seed()
