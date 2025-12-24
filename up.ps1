# up.ps1 — One-command dev bring-up for Brain backend (5055) + UI (5173)
# Usage: powershell -ExecutionPolicy Bypass -File E:\Brain\up.ps1

$ErrorActionPreference = "Stop"

# ----------------------------
# Config
# ----------------------------
$BrainDir     = "E:\Brain"
$BrainBindIp  = "127.0.0.1"
$BrainPort    = 5055
$UiBindIp     = "127.0.0.1"
$UiPort       = 5173

$BrainBaseUrl = "http://${BrainBindIp}:$BrainPort"
$UiBaseUrl    = "http://${UiBindIp}:$UiPort"

# Smoke test defaults
$SmokeDate    = "2025-12-24"
$SmokeAirport = "YSSY"

Write-Host "=== up.ps1 ===" -ForegroundColor Cyan
Write-Host "BrainDir: $BrainDir"
Write-Host "Brain:    $BrainBaseUrl"
Write-Host "UI:       $UiBaseUrl"
Write-Host ""

# ----------------------------
# Helpers (PowerShell-safe names only)
# ----------------------------
function Stop-ListenersOnPort {
  param([Parameter(Mandatory)][int]$Port)

  try {
    $pids = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique

    foreach ($pid in $pids) {
      if ($pid -and $pid -ne 0) {
        try {
          Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
          Write-Host "Stopped PID $pid on port $Port" -ForegroundColor Yellow
        } catch {}
      }
    }
  } catch {}
}

function Wait-PortOpen {
  param(
    [Parameter(Mandatory)][string]$TargetHost,
    [Parameter(Mandatory)][int]$Port,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    $tcpClient = $null
    try {
      $tcpClient = New-Object System.Net.Sockets.TcpClient
      $iar = $tcpClient.BeginConnect($TargetHost, $Port, $null, $null)

      if ($iar.AsyncWaitHandle.WaitOne(500, $false)) {
        $tcpClient.EndConnect($iar)
        $tcpClient.Close()
        return $true
      }

      $tcpClient.Close()
    } catch {
      if ($tcpClient) { try { $tcpClient.Close() } catch {} }
      # ignore and retry
    }

    Start-Sleep -Milliseconds 250
  }

  return $false
}

function Assert-CommandExists {
  param(
    [Parameter(Mandatory)][string]$Name,
    [string]$Hint = ""
  )

  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    $msg = "Required command not found on PATH: $Name"
    if ($Hint) { $msg += " ($Hint)" }
    throw $msg
  }
}

function Pick-PythonExe {
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

function Start-CmdWindow {
  param(
    [Parameter(Mandatory)][string]$WorkingDir,
    [Parameter(Mandatory)][string]$WindowTitle,
    [Parameter(Mandatory)][string]$CommandLine
  )

  # /k keeps the window open so you can watch logs and stop by closing the window.
  $args = @(
    "/k",
    "title $WindowTitle && cd /d `"$WorkingDir`" && $CommandLine"
  )

  Start-Process -FilePath "cmd.exe" -ArgumentList $args -WindowStyle Normal | Out-Null
}

function Try-JsonGet {
  param(
    [Parameter(Mandatory)][string]$Url,
    [int]$TimeoutSec = 15
  )
  Invoke-RestMethod -Uri $Url -TimeoutSec $TimeoutSec
}

function Try-HttpGet {
  param(
    [Parameter(Mandatory)][string]$Url,
    [int]$TimeoutSec = 15
  )
  Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec
}

# ----------------------------
# Preflight
# ----------------------------
if (-not (Test-Path $BrainDir)) {
  throw "BrainDir not found: $BrainDir"
}

Assert-CommandExists -Name "yarn" -Hint "Install Node/Yarn or ensure Yarn is on PATH."

$pythonExe = Pick-PythonExe
if ($pythonExe -eq "python") {
  Assert-CommandExists -Name "python" -Hint "Install Python or create .venv in E:\Brain."
}

Write-Host "=== Killing stale listeners (best-effort) ===" -ForegroundColor Yellow
Stop-ListenersOnPort -Port $BrainPort
Stop-ListenersOnPort -Port $UiPort
Write-Host ""

# ----------------------------
# Start Brain backend
# ----------------------------
Write-Host "=== Start Brain backend ===" -ForegroundColor Green
$brainCmdLine = "`"$pythonExe`" app.py"
Start-CmdWindow -WorkingDir $BrainDir -WindowTitle "Brain Backend ($BrainPort)" -CommandLine $brainCmdLine

Write-Host "Waiting for Brain port $BrainPort..."
if (-not (Wait-PortOpen -TargetHost $BrainBindIp -Port $BrainPort -TimeoutSeconds 45)) {
  throw "Brain did not start listening on ${BrainBindIp}:$BrainPort"
}
Write-Host "Brain listening: OK" -ForegroundColor Green
Write-Host ""

# ----------------------------
# Start Vite UI
# ----------------------------
Write-Host "=== Start Vite UI ===" -ForegroundColor Green
$uiCmdLine = "yarn dev --host $UiBindIp --port $UiPort"
Start-CmdWindow -WorkingDir $BrainDir -WindowTitle "Vite UI ($UiPort)" -CommandLine $uiCmdLine

Write-Host "Waiting for UI port $UiPort..."
if (-not (Wait-PortOpen -TargetHost $UiBindIp -Port $UiPort -TimeoutSeconds 60)) {
  throw "UI did not start listening on ${UiBindIp}:$UiPort"
}
Write-Host "UI listening: OK" -ForegroundColor Green
Write-Host ""

# ----------------------------
# Health checks
# ----------------------------
Write-Host "=== Health checks ===" -ForegroundColor Cyan

# 1) Brain wiring-status
try {
  $wiring = Try-JsonGet -Url "$BrainBaseUrl/api/wiring-status" -TimeoutSec 10
  $upstream = $wiring.upstream_base_url_active
  Write-Host ("Brain wiring-status: ok={0} upstream_active={1}" -f $wiring.ok, $upstream) -ForegroundColor Green
} catch {
  Write-Host "Brain wiring-status: FAIL" -ForegroundColor Red
  Write-Host $_.Exception.Message
}

# 2) UI home page
try {
  $uiHomeResp = Try-HttpGet -Url $UiBaseUrl -TimeoutSec 10
  Write-Host ("UI home: StatusCode={0}" -f $uiHomeResp.StatusCode) -ForegroundColor Green
} catch {
  Write-Host "UI home: FAIL" -ForegroundColor Red
  Write-Host $_.Exception.Message
}

# 3) UI -> flights smoke test
try {
  $flightsUrl = "$UiBaseUrl/api/flights?date=$SmokeDate&airport=$SmokeAirport&operator=ALL"
  $flights = Try-JsonGet -Url $flightsUrl -TimeoutSec 30
  Write-Host ("UI->Flights: ok={0} count={1} source={2} airport={3} local_date={4}" -f $flights.ok, $flights.count, $flights.source, $flights.airport, $flights.local_date) -ForegroundColor Green
} catch {
  Write-Host "UI->Flights: FAIL" -ForegroundColor Red
  Write-Host $_.Exception.Message
}

# 4) UI -> runs smoke test
try {
  $runsUrl = "$UiBaseUrl/api/runs?date=$SmokeDate&airport=$SmokeAirport&operator=ALL&shift=ALL"
  $runs = Try-JsonGet -Url $runsUrl -TimeoutSec 30
  Write-Host ("UI->Runs: ok={0} count={1} source={2} airport={3} local_date={4}" -f $runs.ok, $runs.count, $runs.source, $runs.airport, $runs.local_date) -ForegroundColor Green
} catch {
  Write-Host "UI->Runs: FAIL" -ForegroundColor Red
  Write-Host $_.Exception.Message
}

Write-Host ""
Write-Host "DONE. Keep the two cmd windows open (Brain + UI). Close them to stop servers." -ForegroundColor Cyan
