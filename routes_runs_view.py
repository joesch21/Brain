from flask import Blueprint, render_template, current_app

bp_runs_view = Blueprint("bp_runs_view", __name__)


@bp_runs_view.route("/runs")
def runs_view():
    """Render the runs overview page; data is loaded via JS from CodeCrafter2."""
    api_base = current_app.config.get("CODE_CRAFTER2_API_BASE", "")
    return render_template("runs.html", api_base_url=api_base)
