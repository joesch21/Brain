from typing import Any, Dict, List, Optional
from uuid import uuid4

from services.capability_registry import CapabilityRegistry


class Planner:
    _INTENT_TO_MODE = {
        "build": "build",
        "fix": "fix",
        "know": "know",
    }

    def __init__(self, registry: CapabilityRegistry):
        self.registry = registry

    def build_plan(self, intent: Dict[str, Any], request_id: Optional[str] = None) -> Dict[str, Any]:
        intent_type = (intent or {}).get("type")
        mode = self._INTENT_TO_MODE.get(intent_type)

        if mode is None:
            return {
                "ok": False,
                "error": {
                    "code": "unknown_intent",
                    "message": "Unsupported intent type",
                    "suggestions": ["build", "fix", "know"],
                },
            }

        sequence = [
            ("codecrafter.run", {"mode": mode, "payload": intent.get("payload", {}), "caller": "brain.planner", "request_id": request_id}),
            ("brain.follow_run", {"run_id": "$steps.1.run_id"}),
            ("brain.summarize_report", {"run_id": "$steps.1.run_id", "report": "$steps.2.report"}),
        ]

        steps: List[Dict[str, Any]] = []
        expected_outputs: Dict[str, Any] = {}

        for idx, (capability_name, args) in enumerate(sequence, start=1):
            capability = self.registry.get(capability_name)
            if capability is None:
                return {
                    "ok": False,
                    "error": {
                        "code": "missing_capability",
                        "message": f"Capability not registered: {capability_name}",
                    },
                }

            step_id = f"step-{idx}"
            steps.append(
                {
                    "step_id": step_id,
                    "capability_name": capability_name,
                    "args": args,
                    "requires_approval": bool(capability.get("policy", {}).get("approval_required", False)),
                    "effects": capability.get("effects", "none"),
                }
            )
            expected_outputs[step_id] = capability.get("outputs_schema", {}).get("required", [])

        plan = {
            "plan_id": str(uuid4()),
            "request_id": request_id,
            "intent_type": intent_type,
            "steps": steps,
            "expected_outputs": expected_outputs,
        }
        return {"ok": True, "plan": plan}
