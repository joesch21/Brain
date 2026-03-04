# Brain Architecture Overview

This document outlines how the Brain frontend, CodeCrafter2, and the Office/Postgres database collaborate using the cognitive brain analogy: Brain is the sensory UI and control panel, CodeCrafter2 is the cognitive layer for reasoning and planning, and Postgres (via the Machine Room/Ops API) is the long-term operational memory.

## Core roles
- **Brain (this repository)** — acts as the **senses and display/control panel**. It renders schedules, run sheets, and operational dashboards, collecting user inputs and surfacing facts. Brain does not own operational truth; it shows data it reads from the Ops API.
- **CodeCrafter2** — serves as the **cognitive brain**. It handles reasoning, planning, optimisation requests, and other AI-powered assistance initiated from Brain. It can propose actions and coordinate with operational services but is not the system of record.
- **Office/Postgres DB (via Machine Room/Ops API)** — functions as **long-term memory**. The Ops API reads and writes the operational source of truth (flights, runs, statuses, and similar data) stored in Postgres. All persistent operations flow through this layer.

## Data Flow
Brain separates data retrieval from cognition:

- Operational facts (flights, runs, status) are fetched from the **Ops API** (Machine Room backend), which reads/writes the Office/Postgres database.
- Questions, optimisation requests, and smart tasks are sent to **CodeCrafter2**, which performs cognitive work and can call back into the Ops API (or other services) when it needs authoritative data or write-backs.
- Postgres remains the memory; neither Brain nor CodeCrafter2 should assume authority over operational truth.

**Text diagrams**
```
Brain (UI) → Ops API → Postgres (memory)
Brain (UI) → CodeCrafter2 (cognitive) → Ops API → Postgres
```

## Configuration
Brain uses environment configuration to keep cognition and operational data separated:

- `VITE_OPS_BASE_URL` — base URL for the Machine Room/Ops API (source of flights, runs, statuses). Pages like Schedule, Planner, and Run Sheets should use this endpoint for CRUD and status reads.
- `VITE_KNOW_BASE_URL` — base URL for CodeCrafter2 (Know/cognitive tools). AI analyses, suggestions, and tooling features should call this endpoint.

The separation is intentional: Brain displays and gathers inputs, CodeCrafter2 thinks, and Postgres remembers. Brain should not hard-code Ops URLs; it must rely on these environment variables so deployments can target the correct backends.

## Future Evolution
- Richer planning/optimisation loops where Brain asks CodeCrafter2 to propose operational changes, with operators reviewing and approving write-backs via the Ops API to Postgres.
- Additional sensors or UIs can join the ecosystem without moving cognition or memory: new frontends still call the Ops API for truth and CodeCrafter2 for reasoning, leaving Postgres as the consistent source of record.
- This separation allows scaling cognition and UI independently while keeping operational data centralized in the Office/Postgres memory.

## Brain Control Plane Contract (Dispatch + Follow)

Brain now exposes a minimal control-plane surface for orchestrating CodeCrafter runs while keeping execution logic inside CodeCrafter.

### Separation of concerns
- Brain decides **what** to request and **what to do next**.
- CodeCrafter executes runs and owns artifacts/reports.
- Brain **never infers filesystem paths** and **only consumes run metadata URLs returned by CodeCrafter**.

### Brain -> CodeCrafter request envelope
```json
{
  "mode": "build|fix|know",
  "payload": {
    "prompt": "...",
    "hints": {}
  },
  "caller": "brain:<correlation-id>"
}
```

### CodeCrafter -> Brain run envelope (authoritative metadata)
```json
{
  "run_id": "string",
  "open_url": "string",
  "preview_url": "string|null",
  "report_url": "string",
  "latest_url": "string",
  "status": "running|complete|failed|queued"
}
```

### Brain API endpoints
- `POST /api/dispatch`
  - Validates `mode` (`build|fix|know`), accepts optional `payload` object and `caller`.
  - Returns:
  ```json
  {
    "ok": true,
    "run": {
      "run_id": "...",
      "open_url": "...",
      "preview_url": null,
      "report_url": "...",
      "latest_url": "...",
      "status": "running|complete|failed|queued"
    }
  }
  ```
- `GET /api/follow/<run_id>`
  - Returns stable follow contract even for unknown runs:
  ```json
  {
    "ok": false,
    "run_id": "missing",
    "status": "not_found",
    "report": null,
    "error": {"code": "not_found", "message": "..."}
  }
  ```

### Environment variables
- `CC_BASE_URL` (optional): primary CodeCrafter base URL (for example `http://127.0.0.1:6060`).
- `CC_DISPATCH_PATH` (optional): CodeCrafter dispatch path (defaults to `/api/run`).

If upstream is unavailable or not configured, Brain fails soft by returning a deterministic placeholder run envelope and a structured report error; it does not 500 for known validation/upstream-down scenarios.
