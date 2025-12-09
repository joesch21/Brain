# Code_Crafter2

Clean Apple-style UI (dark + green) with Build/Fix/Know flows on Flask.
- Install: `pip install -r requirements.txt`
- Run: `python app.py` then open http://localhost:5000

Database configuration:
- Local development defaults to SQLite at `cc_office.db`.
- To use Postgres (e.g., on Render), set `DATABASE_URL` to the connection string and run `python scripts/seed_office_data.py` once to create and seed the tables.

Swap stubs with your AI tooling in `services/`.

## Frontend SPA (Planner + Machine Room)

- Build the React frontend (outputs to `frontend_dist/`):
  ```bash
  npm run build
  ```
- Run Flask and load the SPA at `/planner` or `/machine-room`:
  ```bash
  python app.py
  # then visit http://localhost:5000/planner or /machine-room
  ```
- Local dev (React + Flask separately):
  ```bash
  python app.py           # Flask API + auth on :5000
  npm run dev             # Vite dev server on :5173
  # open http://localhost:5173/planner or /machine-room
  ```
  Configure your API calls to hit `http://localhost:5000` (e.g., via `VITE_API_BASE`).

SPA details:
- The built assets live in `frontend_dist/` and are served by Flask.
- `/planner` and `/machine-room` now return the React SPA entry HTML; React Router picks the page.
- Legacy Jinja templates remain available at `/legacy/planner` and `/legacy/machine-room` for fallback access.

### Seeding demo data (recommended for office/ops UI)

On a fresh clone, after installing dependencies:

```bash
python dev_seed_all.py
```

This will:

- create demo users (supervisor, refueler) with known passwords
- seed Employees, Flights, Roster entries, Maintenance items, and an AuditLog entry

Then start the app:

```bash
python app.py
```

Log in as supervisor and visit:

- `/roster` – roster view
- `/schedule` – flight schedule view
- `/maintenance` – maintenance items
- `/machine-room` – DB + audit overview

---

## 3) How you actually use it now

From the **Brain repo root**:

```bash
# 1. Ensure dependencies are installed
pip install -r requirements.txt

# 2. Seed everything
python dev_seed_all.py

# 3. Run the app
python app.py
```

Then in the browser:

Log in as supervisor (password from seed_db.py – currently superpass123).

Use the nav/Home cards to open:

- Roster → see Alice/Bob rostered
- Schedule → see QF / SQ flights
- Maintenance → see Truck-1/2/3 items
- Machine Room → see counts and recent rows

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

## Backend wiring test (Ops API)

To quickly check that the Ops backend endpoints used by The Brain are alive after a deploy, run:

```powershell
pwsh scripts/test_backend_wiring.ps1
```

By default this targets `https://brain-lbaj.onrender.com`. You can override the base URL:

```powershell
pwsh scripts/test_backend_wiring.ps1 -BaseUrl "https://your-staging-url.onrender.com"
```
