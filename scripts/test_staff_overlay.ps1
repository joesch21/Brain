# scripts/test_staff_overlay.ps1
# EWOT: Validate staff overlay endpoint without blocking the UI.

param(
  [string]$Base = "http://127.0.0.1:5173",
  [string]$Date = (Get-Date).ToString("yyyy-MM-dd"),
  [string]$Airport = "YSSY",
  [string]$Operator = "ALL",
  [string]$Shift = "ALL"
)

function Encode([string]$value) {
  return [System.Uri]::EscapeDataString($value)
}

$query = "date=$(Encode $Date)&airport=$(Encode $Airport)&operator=$(Encode $Operator)&shift=$(Encode $Shift)"
$url = "$Base/api/employee_assignments/daily?$query"

Write-Host "Testing staff overlay: $url" -ForegroundColor Cyan

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

try {
  $response = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 8 -UseBasicParsing
} catch {
  Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  $stopwatch.Stop()
}

if ($stopwatch.Elapsed.TotalSeconds -gt 8) {
  Write-Host "FAILED: Response exceeded 8 seconds ($($stopwatch.Elapsed.TotalSeconds)s)." -ForegroundColor Red
  exit 1
}

if ($response.StatusCode -ne 200) {
  Write-Host "FAILED: Expected HTTP 200, got $($response.StatusCode)." -ForegroundColor Red
  exit 1
}

try {
  $payload = $response.Content | ConvertFrom-Json -ErrorAction Stop
} catch {
  Write-Host "FAILED: Response body is not valid JSON." -ForegroundColor Red
  exit 1
}

if (-not $payload.ok) {
  Write-Host "FAILED: Payload ok=false." -ForegroundColor Red
  exit 1
}

$hasAvailable = $payload.PSObject.Properties.Name -contains "available"
$hasAssignments = $payload.PSObject.Properties.Name -contains "assignments"

if (-not $hasAvailable -or -not $hasAssignments) {
  Write-Host "FAILED: Payload missing available/assignments fields." -ForegroundColor Red
  exit 1
}

Write-Host "OK: Staff overlay endpoint healthy." -ForegroundColor Green
Write-Host "Response time: $([Math]::Round($stopwatch.Elapsed.TotalSeconds, 2))s" -ForegroundColor Green
