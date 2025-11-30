"""Runs API routes for Code_Crafter2."""
from __future__ import annotations

from datetime import datetime

from flask import Blueprint, jsonify, request

from ..office_adapter import fetch_office_runs_for_date, use_office_db

bp = Blueprint("runs", __name__)


@bp.route("/api/runs", methods=["GET"])
def list_runs():
    """Return runs for a given date, optionally sourcing from the Office DB."""
    date_str = request.args.get("date")
    if not date_str:
        return jsonify({"ok": False, "error": "Query param 'date' is required"}), 400

    try:
        day = datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        return jsonify({"ok": False, "error": "Invalid date format (use YYYY-MM-DD)"}), 400

    if use_office_db():
        try:
            runs = fetch_office_runs_for_date(day)
            return jsonify({"ok": True, "date": day.isoformat(), "runs": runs}), 200
        except Exception as exc:  # noqa: BLE001
            return (
                jsonify({"ok": False, "error": f"Office DB runs query failed: {exc}"}),
                502,
            )

    return jsonify({"ok": False, "error": "ORM-backed runs not implemented"}), 501
