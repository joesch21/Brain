# Brain Capabilities

Capabilities are Brain's syscall table: explicit tool contracts that apps can plug into the platform.

## Contract-over-magic doctrine

- Capabilities are JSON files loaded from `capabilities/**`.
- Input/output contracts are explicit (`inputs_schema`, `outputs_schema`).
- Planner chooses capabilities deterministically from intent rules.
- Brain does not infer local filesystem paths for outputs; it consumes URLs emitted by execution engines.

## Capability schema

Canonical schema file: `capabilities/schema.capability.json`.

Required fields:

- `name` - stable namespace identifier (`namespace.action`)
- `version` - semver-like version string
- `description` - plain-language capability description
- `owner` - plugin owner/application name
- `inputs_schema` - JSON Schema object for inputs
- `outputs_schema` - JSON Schema object for outputs
- `effects` - one of `none|read|write|external`
- `idempotency` - idempotency metadata and key fields
- `timeouts` - timeout + retry policy
- `policy` - approvals, logging requirements, data constraints

## Plugin workflow

1. Drop a capability JSON file in `capabilities/<plugin>/`.
2. Ensure it matches required schema keys.
3. Call `GET /api/capabilities` to verify it was discovered.

Registry loading is fail-soft: invalid files are surfaced in `errors` while valid capabilities remain available.

## Example capability

```json
{
  "name": "codecrafter.run",
  "version": "0.1.0",
  "description": "Dispatch a CodeCrafter job and return run-scoped URLs.",
  "owner": "CodeCrafter",
  "inputs_schema": {"type": "object"},
  "outputs_schema": {"type": "object"},
  "effects": "external",
  "idempotency": {"enabled": true, "idempotency_key_fields": ["request_id"]},
  "timeouts": {"seconds": 30, "retry_policy": {"retries": 1, "backoff_seconds": 1}},
  "policy": {"approval_required": false, "logging_requirements": ["request_id"], "data_constraints": []}
}
```

## Example plan output

```json
{
  "ok": true,
  "plan": {
    "plan_id": "4d05...",
    "request_id": "req-123",
    "intent_type": "build",
    "steps": [
      {"step_id": "step-1", "capability_name": "codecrafter.run"},
      {"step_id": "step-2", "capability_name": "brain.follow_run"},
      {"step_id": "step-3", "capability_name": "brain.summarize_report"}
    ],
    "expected_outputs": {
      "step-1": ["run_id", "open_url", "report_url", "latest_url", "status"],
      "step-2": ["ok", "run_id", "status"],
      "step-3": ["run_id", "summary", "next_action"]
    }
  }
}
```
