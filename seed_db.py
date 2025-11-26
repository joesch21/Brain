from datetime import datetime, timedelta

from app import User, app, db, Employee, Flight


def seed():
    with app.app_context():
        db.create_all()

        if not User.query.filter_by(username="supervisor").first():
            sup = User(username="supervisor", role="supervisor")
            sup.set_password("superpass123")
            db.session.add(sup)

        if not User.query.filter_by(username="operator").first():
            op = User(username="operator", role="operator")
            op.set_password("operator123")
            db.session.add(op)

        if not Employee.query.first():
            crew = [
                Employee(name="Alice", role="Refueler", shift="Day", base="SYD"),
                Employee(name="Bob", role="Supervisor", shift="Night", base="SYD"),
                Employee(name="Charlie", role="Driver", shift="Day", base="SYD"),
            ]
            db.session.add_all(crew)

        if not Flight.query.first():
            flights = [
                Flight(
                    flight_number="QF123",
                    airline="Qantas",
                    eta=datetime.utcnow() + timedelta(hours=1),
                    bay="B12",
                    fuel_tonnes=25.0,
                ),
                Flight(
                    flight_number="EK414",
                    airline="Emirates",
                    eta=datetime.utcnow() + timedelta(hours=2),
                    bay="C3",
                    fuel_tonnes=60.0,
                ),
            ]
            db.session.add_all(flights)

        db.session.commit()


if __name__ == "__main__":
    seed()
