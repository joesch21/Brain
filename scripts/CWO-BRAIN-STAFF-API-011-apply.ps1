param(
  [string]$Repo = "E:\Brain"
)

$ErrorActionPreference = "Stop"

function Fail($msg) { throw $msg }

if (-not (Test-Path $Repo)) { Fail "Repo path not found: $Repo" }

Push-Location $Repo
try {
  if (-not (Test-Path ".git")) { Fail "Not a git repo: $Repo" }

  # Find python file(s) containing the endpoint route string
  $hits = git grep -n "/api/employee_assignments/daily" -- "*.py"
  if (-not $hits) { Fail "Could not find '/api/employee_assignments/daily' in any *.py file." }

  $files = $hits | ForEach-Object {
    ($_ -split ":",3)[0]
  } | Select-Object -Unique

  Write-Host "Found candidate file(s):" -ForegroundColor Cyan
  $files | ForEach-Object { Write-Host " - $_" }

  $replacement = @"
@app.get("/api/employee_assignments/daily")
def api_employee_assignments_daily():
    """
    EWOT: Optional staff overlay endpoint.
    It must NEVER block the UI. Even if upstream is missing/404/HTML/timeout, return HTTP 200:
      { ok:true, available:false, reason:..., assignments:{} }
    """
    date_str = (request.args.get("date") or "").strip()
    airport = (request.args.get("airport") or "").strip().upper()
    operator = (request.args.get("operator") or "ALL").strip().upper()
    shift = (request.args.get("shift") or "ALL").strip().upper()

    # enforce contract (airport required, date required)
    if not date_str:
        return jsonify({"ok": False, "error": {"code": "validation_error", "message": "Missing required 'date' query parameter."}}), 400
    if not airport:
        return jsonify({"ok": False, "error": {"code": "validation_error", "message": "Missing required 'airport' query parameter."}}), 400

    def optional(reason: str):
        return jsonify({
            "ok": True,
            "available": False,
            "reason": reason,
            "airport": airport,
            "local_date": date_str,
            "operator": operator,
            "shift": shift,
            "assignments": {}
        }), 200

    params = {
        "date": date_str,
        "airport": airport,
        "operator": operator,
        "shift": shift,
    }

    try:
        resp = requests.get(
            _upstream_url("/api/employee_assignments/daily"),
            params=params,
            timeout=8,
        )
    except requests.Timeout:
        return optional("timeout")
    except requests.RequestException:
        return optional("upstream_error")

    if resp.status_code == 404:
        return optional("upstream_404")

    if resp.status_code != 200:
        return optional("upstream_error")

    try:
        payload = resp.json()
    except Exception:
        return optional("upstream_error")

    if not isinstance(payload, dict):
        return optional("upstream_error")

    if payload.get("ok") is False:
        return optional("upstream_error")

    payload.setdefault("ok", True)
    payload.setdefault("available", True)
    payload.setdefault("airport", airport)
    payload.setdefault("local_date", date_str)
    payload.setdefault("operator", operator)
    payload.setdefault("shift", shift)
    payload.setdefault("assignments", payload.get("assignments") or {})

    return jsonify(payload), 200
"@

  $pattern = '(?s)@app\.get\("/api/employee_assignments/daily"\)\s*\r?\n\s*def\s+[A-Za-z0-9_]+\s*\([^\)]*\):.*?(?=\r?\n@app\.|\z)'

  $patchedAny = $false

  foreach ($f in $files) {
    if (-not (Test-Path $f)) { continue }

    $raw = Get-Content $f -Raw

    if ($raw -notmatch '@app\.get\("/api/employee_assignments/daily"\)') {
      continue
    }

    if ($raw -notmatch $pattern) {
      Write-Warning "Found route marker but could not match function block pattern in: $f"
      continue
    }

    # Backup once per file
    $bak = "$f.bak"
    Copy-Item $f $bak -Force

    $new = [Regex]::Replace($raw, $pattern, $replacement)

    # Safety check: ensure replacement occurred
    if ($new -eq $raw) {
      Write-Warning "No changes applied to: $f"
      continue
    }

    Set-Content -Path $f -Value $new -Encoding UTF8
    Write-Host "Patched: $f (backup: $bak)" -ForegroundColor Green
    $patchedAny = $true

    # Quick syntax check for this file if python is available
    try {
      python -m py_compile $f | Out-Null
      Write-Host "Python syntax OK: $f" -ForegroundColor Green
    } catch {
      Write-Warning "Python compile check failed for $f (you can still run servers and see runtime errors): $($_.Exception.Message)"
    }
  }

  if (-not $patchedAny) {
    Fail "No file was patched. Route may be in a non-standard format or different decorator name."
  }

  Write-Host "`nDone. Now restart: powershell -ExecutionPolicy Bypass -File E:\Brain\up.ps1" -ForegroundColor Cyan
  Write-Host "Then test:" -ForegroundColor Cyan
  Write-Host 'Invoke-WebRequest "http://127.0.0.1:5173/api/employee_assignments/daily?date=2025-12-22&airport=YSSY&operator=ALL&shift=ALL" -TimeoutSec 8 -UseBasicParsing | Select StatusCode' -ForegroundColor Cyan

} finally {
  Pop-Location
}
