"""Flight run API routes.

This module keeps app-level imports inside request handlers to avoid circular
imports when Flask initializes the application.
"""

from flask import Blueprint, jsonify, request

flight_runs_bp = Blueprint("flight_runs_api", __name__, url_prefix="/api")


@flight_runs_bp.route("/flight_runs/<int:flight_run_id>", methods=["PUT"])
def update_flight_run(flight_run_id):
    """Update editable fields on a FlightRun row (bay, rego, on_time, status, start_figure, uplift)."""
    # Local import to avoid circular dependency during app startup
    from app import FlightRun, db

    payload = request.get_json(silent=True) or {}

    fr = FlightRun.query.get(flight_run_id)
    if fr is None:
        return jsonify({"error": "FlightRun not found"}), 404

    if "bay" in payload:
        fr.bay = payload["bay"] or None
    if "rego" in payload:
        fr.rego = payload["rego"] or None
    if "on_time" in payload:
        fr.on_time = bool(payload["on_time"])
    if "status" in payload:
        fr.status = payload["status"] or "planned"
    if "start_figure" in payload:
        fr.start_figure = (
            int(payload["start_figure"]) if payload["start_figure"] not in (None, "") else None
        )
    if "uplift" in payload:
        fr.uplift = int(payload["uplift"]) if payload["uplift"] not in (None, "") else None

    db.session.commit()

    return jsonify(
        {
            "id": fr.id,
            "run_id": fr.run_id,
            "flight_id": fr.flight_id,
            "bay": fr.bay,
            "rego": fr.rego,
            "on_time": fr.on_time,
            "status": fr.status,
            "start_figure": fr.start_figure,
            "uplift": fr.uplift,
        }
    )
