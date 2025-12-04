"""Minimal Flask app factory for CodeCrafter2."""

from flask import Flask, jsonify


def create_app() -> Flask:
    app = Flask(__name__)

    from .routes.imports import bp as imports_bp
    from .routes.runs import bp as runs_bp

    app.register_blueprint(imports_bp)
    app.register_blueprint(runs_bp)

    @app.get("/healthz")
    def healthcheck():
        return jsonify({"ok": True})

    return app
