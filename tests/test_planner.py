from pathlib import Path

from services.capability_registry import CapabilityRegistry
from services.planner import Planner


CAPABILITIES_DIR = Path(__file__).resolve().parents[1] / "capabilities"


def _planner_with_core_caps() -> Planner:
    registry = CapabilityRegistry()
    registry.load_from_dir(str(CAPABILITIES_DIR), force_reload=True)
    return Planner(registry)


def test_planner_build_fix_know_are_deterministic_sequences():
    planner = _planner_with_core_caps()

    for intent_type in ("build", "fix", "know"):
        result = planner.build_plan({"type": intent_type, "payload": {"prompt": "x"}}, request_id="req-1")
        assert result["ok"] is True
        plan = result["plan"]
        assert plan["request_id"] == "req-1"
        assert [step["capability_name"] for step in plan["steps"]] == [
            "codecrafter.run",
            "brain.follow_run",
            "brain.summarize_report",
        ]
        assert plan["steps"][0]["args"]["mode"] == intent_type


def test_planner_unknown_intent_returns_structured_error():
    planner = _planner_with_core_caps()
    result = planner.build_plan({"type": "dance"}, request_id="req-2")

    assert result["ok"] is False
    assert result["error"]["code"] == "unknown_intent"
    assert "build" in result["error"]["suggestions"]


def test_api_endpoints_capabilities_and_plan():
    import app as brain_app

    client = brain_app.app.test_client()

    caps_resp = client.get("/api/capabilities")
    assert caps_resp.status_code == 200
    caps_payload = caps_resp.get_json()
    assert caps_payload["ok"] is True
    assert caps_payload["count"] >= 3

    plan_resp = client.post(
        "/api/plan",
        json={"request_id": "req-3", "intent": {"type": "build", "payload": {"prompt": "hello"}}},
    )
    assert plan_resp.status_code == 200
    plan_payload = plan_resp.get_json()
    assert plan_payload["ok"] is True
    assert len(plan_payload["plan"]["steps"]) == 3

    bad_resp = client.post("/api/plan", json={"intent": {"type": "unknown"}})
    assert bad_resp.status_code == 400
    assert bad_resp.get_json()["error"]["code"] == "unknown_intent"
