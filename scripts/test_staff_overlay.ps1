param(
  [string]$Base = "http://127.0.0.1:5173",
  [string]$Date = "2025-12-22",
  [string]$Airport = "YSSY",
  [string]$Operator = "ALL",
  [string]$Shift = "ALL",
  [int]$TimeoutSec = 8
)

# EWOT: Validates staff overlay endpoint is non-blocking (HTTP 200, valid JSON, ok:true) within 8 seconds.

$uri = "$Base/api/employee_assignments/daily?date=$Date&airport=$Airport&operator=$Operator&shift=$Shift"

Write-Host "GET $uri" -ForegroundColor Cyan

try {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $resp = Invoke-WebRequest -Uri $uri -TimeoutSec $TimeoutSec -UseBasicParsing
  $sw.Stop()
} catch {
  throw "Request failed (timeout/network). $($_.Exception.Message)"
}

if ($resp.StatusCode -ne 200) {
  throw "Expected HTTP 200, got $($resp.StatusCode). Body: $($resp.Content)"
}

try {
  $json = $resp.Content | ConvertFrom-Json -Depth 20
} catch {
  throw "Response was not valid JSON. Body: $($resp.Content)"
}

if ($json.ok -ne $true) {
  throw "Expected ok:true for non-blocking overlay. Got ok=$($json.ok). Body: $($resp.Content)"
}

if ($null -eq $json.available) { throw "Expected 'available' field (true/false)." }
if ($null -eq $json.assignments) { throw "Expected 'assignments' field (object or array)." }

Write-Host ("ok=true available={0} reason={1} ({2}ms)" -f $json.available, ($json.reason ?? ""), [math]::Round($sw.Elapsed.TotalMilliseconds,0)) -ForegroundColor Green
Write-Host "PASS: staff overlay is non-blocking." -ForegroundColor Green
