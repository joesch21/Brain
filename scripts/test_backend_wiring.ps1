# scripts/test_backend_wiring.ps1
# EWOT: Checks that the Ops backend endpoints used by The Brain are reachable and returning JSON.

param(
  [string]$BaseUrl = "https://brain-lbaj.onrender.com"
)

Write-Host "Testing backend wiring for: $BaseUrl" -ForegroundColor Cyan

function Test-Endpoint {
  param(
    [string]$Name,
    [string]$Url,
    [string]$Method = "GET",
    [object]$Body = $null
  )

  Write-Host "--- $Name ---" -ForegroundColor Yellow

  try {
    if ($null -ne $Body) {
      $jsonBody = $Body | ConvertTo-Json -Depth 5
      $response = Invoke-RestMethod -Uri $Url -Method $Method -Body $jsonBody -ContentType "application/json"
    } else {
      $response = Invoke-RestMethod -Uri $Url -Method $Method
    }

    Write-Host "OK" -ForegroundColor Green
    # Print a small JSON snippet so we know we got structured data
    $response | ConvertTo-Json -Depth 3 | Write-Host
  }
  catch {
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
  }

  Write-Host ""
}

# 1) Wiring status: proves Brain -> Ops link is alive
$wiringUrl = "$BaseUrl/api/wiring-status"
Test-Endpoint -Name "Wiring status" -Url $wiringUrl -Method "GET"

# 2) Daily roster: used by Runs page to populate operator dropdown from employee assignments
$today = (Get-Date).ToString('yyyy-MM-dd')
$rosterUrl = "$BaseUrl/api/employee_assignments/daily?date=$today&airport=YSSY&airline=ALL"
Test-Endpoint -Name "Daily employee assignments" -Url $rosterUrl -Method "GET"

# 3) Daily runs: used by Runs page to display run layout for today
$runsUrl = "$BaseUrl/api/runs?date=$today&airline=ALL&airport=YSSY"
Test-Endpoint -Name "Runs" -Url $runsUrl -Method "GET"

# 4) Auto-assign runs: used by Runs page 'Auto-assign runs for this day' button
$autoAssignUrl = "$BaseUrl/api/runs/auto_assign"
$autoAssignBody = @{
  date     = $today
  airline  = "ALL"
}
Test-Endpoint -Name "Auto-assign runs" -Url $autoAssignUrl -Method "POST" -Body $autoAssignBody

Write-Host "Backend wiring tests finished." -ForegroundColor Cyan

# Run it from the Brain repo root with:
#
# pwsh scripts/test_backend_wiring.ps1
# or against a different environment:
# pwsh scripts/test_backend_wiring.ps1 -BaseUrl "https://your-staging-url.onrender.com"
