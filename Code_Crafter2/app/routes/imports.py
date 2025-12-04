"""Import endpoints for CodeCrafter2."""

from flask import Blueprint, jsonify

from ..services.jq_live_import import run_jq_live_import

bp = Blueprint("imports", __name__)


@bp.route("/api/import/jq_live", methods=["POST"])
def import_jq_live():
    """Trigger Jetstar live import for today + next configured days."""

    summary = run_jq_live_import()
    days = summary.get("days", [])
    any_ok = any(day.get("ok") for day in days)
    status_code = 200 if any_ok else 502
    return jsonify({"ok": any_ok, "summary": summary}), status_code
