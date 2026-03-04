import json
from pathlib import Path

from services.capability_registry import CapabilityRegistry, REQUIRED_FIELDS


CAPABILITIES_DIR = Path(__file__).resolve().parents[1] / "capabilities"


def test_registry_loads_core_capabilities_and_supports_queries():
    registry = CapabilityRegistry()
    result = registry.load_from_dir(str(CAPABILITIES_DIR), force_reload=True)

    assert result["ok"] is True
    assert result["count"] >= 3

    names = {item["name"] for item in registry.list()}
    assert {"codecrafter.run", "brain.follow_run", "brain.summarize_report"}.issubset(names)

    codecrafter = registry.get("codecrafter.run")
    assert codecrafter is not None
    assert codecrafter["owner"] == "CodeCrafter"


def test_registry_reports_missing_required_fields(tmp_path):
    bad_file = tmp_path / "bad_capability.json"
    bad_file.write_text(json.dumps({"name": "demo.bad", "version": "0.1.0"}), encoding="utf-8")

    registry = CapabilityRegistry()
    result = registry.load_from_dir(str(tmp_path), force_reload=True)

    assert result["count"] == 0
    assert any(err["code"] == "missing_required_fields" for err in result["errors"])


def test_registry_reports_duplicate_names(tmp_path):
    payload = {
        "name": "demo.dup",
        "version": "0.1.0",
        "description": "d",
        "owner": "o",
        "inputs_schema": {},
        "outputs_schema": {},
        "effects": "none",
        "idempotency": {},
        "timeouts": {},
        "policy": {},
    }

    (tmp_path / "one.json").write_text(json.dumps(payload), encoding="utf-8")
    (tmp_path / "two.json").write_text(json.dumps(payload), encoding="utf-8")

    registry = CapabilityRegistry()
    result = registry.load_from_dir(str(tmp_path), force_reload=True)

    assert result["count"] == 1
    assert any(err["code"] == "duplicate_name" for err in result["errors"])


def test_schema_required_fields_lock():
    schema = json.loads((CAPABILITIES_DIR / "schema.capability.json").read_text(encoding="utf-8"))
    assert schema["required"] == REQUIRED_FIELDS
