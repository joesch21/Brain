# up.ps1 — One-command dev bring-up for Brain (5055) + UI (5173)
# Usage: powershell -ExecutionPolicy Bypass -File E:\Brain\up.ps1

$ErrorActionPreference = "Stop"

# --- Config ---
$BrainDir   = "E:\Brain"
$BrainHost  = "127.0.0.1"
$BrainPort  = 5055
$UiHost     = "127.0.0.1"
$UiPort     = 5173

$BrainUrl   = "http://${BrainHost}:$BrainPort"
$UiUrl      = "http://${UiHost}:$UiPort"

Write-Host "=== up.ps1 ===" -ForegroundColor Cyan
Write-Host "BrainDir: $BrainDir"
Write-Host "Brain:    $BrainUrl"
Write-Host "UI:       $UiUrl"
Write-Host ""

# --- Helpers ---
function Stop-ListenersOnPort {
  param([int]$Port)

  try {
    $pids = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique

    foreach ($pid in $pids) {
      if ($pid -and $pid -ne 0) {
        try {
          Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
          Write-Host "Stopped PID $pid on port $Port"
        } catch {}
      }
    }
  } catch {}
}

function Wait-Port {
  param(
    [string]$Host,
    [int]$Port,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $ok = (Test-NetConnection $Host -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded
    if ($ok) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Pick-Python {
  # Prefer local venv if present, else fall back to `python`
  $candidates = @(
    (Join-Path $BrainDir ".venv\Scripts\python.exe"),
    (Join-Path $BrainDir "venv\Scripts\python.exe")
  )

  foreach ($p in $candidates) {
    if (Test-Path $p) { return $p }
  }
  return "python"
}

# --- Preflight ---
if (-not (Test-Path $BrainDir)) {
  throw "BrainDir not found: $BrainDir"
}

Write-Host "=== Killing stale listeners (best-effort) ===" -ForegroundColor Yellow
Stop-ListenersOnPort -Port $BrainPort
Stop-ListenersOnPort -Port $UiPort
Write-Host ""

# --- Start Brain ---
Write-Host "=== Start Brain backend ===" -ForegroundColor Green
$py = Pick-Python
$brainCmd = "cd /d `"$BrainDir`" && `"$py`" app.py"
Start-Process cmd -ArgumentList '/k', $brainCmd -WindowStyle Normal | Out-Null

Write-Host "Waiting for Brain port $BrainPort..."
if (-not (Wait-Port -Host $BrainHost -Port $BrainPort -TimeoutSeconds 45)) {
  throw "Brain did not start listening on ${BrainHost}:$BrainPort"
}
Write-Host "Brain listening: OK" -ForegroundColor Green
Write-Host ""

# --- Start UI ---
Write-Host "=== Start Vite UI ===" -ForegroundColor Green
$uiCmd = "cd /d `"$BrainDir`" && yarn dev --host $UiHost --port $UiPort"
Start-Process cmd -ArgumentList '/k', $uiCmd -WindowStyle Normal | Out-Null

Write-Host "Waiting for UI port $UiPort..."
if (-not (Wait-Port -Host $UiHost -Port $UiPort -TimeoutSeconds 45)) {
  throw "UI did not start listening on ${UiHost}:$UiPort"
}
Write-Host "UI listening: OK" -ForegroundColor Green
Write-Host ""

# --- Health checks ---
Write-Host "=== Health checks ===" -ForegroundColor Cyan

try {
  $ws = Invoke-RestMethod "$BrainUrl/api/wiring-status" -TimeoutSec 10
  Write-Host ("Brain wiring-status: ok={0} upstream={1}" -f $ws.ok, $ws.upstream_base_url_active) -ForegroundColor Green
} catch {
  Write-Host "Brain wiring-status: FAIL" -ForegroundColor Red
  Write-Host $_.Exception.Message
}

try {
  $home = Invoke-WebRequest $UiUrl -UseBasicParsing -TimeoutSec 10
  Write-Host ("UI home: StatusCode={0}" -f $home.StatusCode) -ForegroundColor Green
} catch {
  Write-Host "UI home: FAIL" -ForegroundColor Red
  Write-Host $_.Exception.Message
}

# Smoke tests (date/airport defaults you’re using)
$Date    = "2025-12-24"
$Airport = "YSSY"

try {
  $f = Invoke-RestMethod "$UiUrl/api/flights?date=$Date&airport=$Airport&operator=ALL" -TimeoutSec 30
  Write-Host ("UI->Flights: ok={0} count={1} source={2} airport={3} local_date={4}" -f $f.ok, $f.count, $f.source, $f.airport, $f.local_date) -ForegroundColor Green
} catch {
  Write-Host "UI->Flights: FAIL" -ForegroundColor Red
  Write-Host $_.Exception.Message
}

try {
  $r = Invoke-RestMethod "$UiUrl/api/runs?date=$Date&airport=$Airport&operator=ALL&shift=ALL" -TimeoutSec 30
  Write-Host ("UI->Runs: ok={0} count={1} source={2} airport={3} local_date={4}" -f $r.ok, $r.count, $r.source, $r.airport, $r.local_date) -ForegroundColor Green
} catch {
  Write-Host "UI->Runs: FAIL" -ForegroundColor Red
  Write-Host $_.Exception.Message
}

Write-Host ""
Write-Host "DONE. Keep the two cmd windows open (Brain + UI). Close them to stop servers." -ForegroundColor Cyan
