# Code_Crafter2

Clean Apple-style UI (dark + green) with Build/Fix/Know flows on Flask.
- Install: `pip install -r requirements.txt`
- Run: `python app.py` then open http://localhost:5000

Database configuration:
- Local development defaults to SQLite at `cc_office.db`.
- To use Postgres (e.g., on Render), set `DATABASE_URL` to the connection string and run `python seed_db.py` once to create and seed the tables.

Swap stubs with your AI tooling in `services/`.
