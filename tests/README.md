# Tests

## Phase 5 Smoke Runner (CWO-BRAIN-FLIGHTS-PULL-003)

1. Start the app:

```powershell
powershell -ExecutionPolicy Bypass -File E:\Brain\up.ps1
```

2. Run the Phase 5 smoke suite:

```powershell
powershell -ExecutionPolicy Bypass -File E:\Brain\tests\cwo_phase5_smoke.ps1 -Base "http://127.0.0.1:5173" -Airport YSSY -Operator ALL -Shift ALL -DateHasData 2025-12-22 -DateMaybeEmpty 2025-12-24 -TimeoutSec 30
```

### Parameters

- `-Base`: Base URL for the Brain UI/API (default `http://127.0.0.1:5173`).
- `-Airport`: Airport code (default `YSSY`).
- `-Operator`: Operator code (default `ALL`).
- `-Shift`: Shift filter (default `ALL`).
- `-DateHasData`: Date known to have data (default `2025-12-22`).
- `-DateMaybeEmpty`: Date that may be empty (default `2025-12-24`).
- `-TimeoutSec`: Per-request timeout in seconds (default `30`).
