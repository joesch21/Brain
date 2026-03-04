from pathlib import Path
from typing import Any, Dict, Optional

from flask import Blueprint, current_app, jsonify, request

from services.capability_registry import CapabilityRegistry
from services.planner import Planner


CAPABILITIES_ROOT = Path(__file__).resolve().parents[1] / "capabilities"


def _json_error(message: str, status_code: int = 500, code: str = "error", detail: Optional[Dict[str, Any]] = None):
    payload: Dict[str, Any] = {
        "ok": False,
        "error": {
            "code": code,
            "message": message,
        },
    }
    if detail:
        payload["error"]["detail"] = detail
    return jsonify(payload), status_code


def create_capabilities_blueprint(registry: CapabilityRegistry, planner: Planner) -> Blueprint:
    bp = Blueprint("api_capabilities", __name__, url_prefix="/api")

    def _refresh_registry(force_reload: bool = False) -> Dict[str, Any]:
        return registry.load_from_dir(str(CAPABILITIES_ROOT), force_reload=force_reload)

    @bp.route("/capabilities", methods=["GET"])
    def list_capabilities():
        load_result = _refresh_registry()
        return jsonify(
            {
                "ok": True,
                "count": len(registry.list()),
                "items": registry.list(),
                "errors": load_result.get("errors", []),
            }
        ), 200

    @bp.route("/capabilities/<path:name>", methods=["GET"])
    def get_capability(name: str):
        _refresh_registry()
        capability = registry.get(name)
        if capability is None:
            return _json_error("Capability not found", status_code=404, code="not_found")
        return jsonify({"ok": True, "capability": capability, "errors": registry.errors}), 200

    @bp.route("/plan", methods=["POST"])
    def build_plan():
        _refresh_registry()

        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return _json_error(
                "Request body must be a JSON object",
                status_code=400,
                code="validation_error",
            )

        intent = body.get("intent")
        if not isinstance(intent, dict):
            return _json_error(
                "Field 'intent' is required and must be an object",
                status_code=400,
                code="validation_error",
            )

        intent_type = intent.get("type")
        if not isinstance(intent_type, str) or not intent_type.strip():
            return _json_error(
                "Field 'intent.type' is required",
                status_code=400,
                code="validation_error",
            )

        request_id = body.get("request_id")
        plan_result = planner.build_plan(intent=intent, request_id=request_id)

        if not plan_result.get("ok"):
            return jsonify(plan_result), 400

        current_app.logger.info(
            "planner.plan_generated request_id=%s intent_type=%s plan_id=%s",
            request_id,
            intent_type,
            plan_result["plan"]["plan_id"],
        )
        return jsonify(plan_result), 200

    return bp
