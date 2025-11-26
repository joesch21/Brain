# Code_Crafter2

Clean Apple-style UI (dark + green) with Build/Fix/Know flows on Flask.
- Install: `pip install -r requirements.txt`
- Run: `python app.py` then open http://localhost:5000

Database configuration:
- Local development defaults to SQLite at `cc_office.db`.
- To use Postgres (e.g., on Render), set `DATABASE_URL` to the connection string and run `python scripts/seed_office_data.py` once to create and seed the tables.

Swap stubs with your AI tooling in `services/`.

## Office Manager data and pages

1. Ensure `DATABASE_URL` is set (defaults to SQLite locally).
2. Seed demo data:
   ```bash
   python scripts/seed_office_data.py
   ```
3. Start the app with `python app.py` and open:
   - `/roster` for employees and their shifts
   - `/schedule` for flight listings
   - `/maintenance` for maintenance tasks
   - `/machine-room` for counts and recent activity across employees, flights, maintenance, and audit logs

On Render, run the same seed command from the shell or add it to a deploy script to pre-populate the database.
