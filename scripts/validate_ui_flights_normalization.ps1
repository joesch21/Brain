$ErrorActionPreference = "Stop"

$UI = $env:UI_BASE_URL
if ([string]::IsNullOrWhiteSpace($UI)) {
  $UI = "http://127.0.0.1:5173"
}

$Date = $env:OPS_DATE
if ([string]::IsNullOrWhiteSpace($Date)) {
  $Date = (Get-Date).ToString("yyyy-MM-dd")
}

$FlightsUrl = "$UI/api/flights?date=$Date&airport=YSSY&operator=ALL"

Write-Host "Checking flights payload from $FlightsUrl"
$resp = Invoke-RestMethod $FlightsUrl

if (-not $resp.ok) {
  throw "Flights response did not return ok=true."
}

$list =
  if ($resp.flights) { $resp.flights }
  elseif ($resp.records) { $resp.records }
  elseif ($resp.rows) { $resp.rows }
  elseif ($resp.items) { $resp.items }
  elseif ($resp -is [System.Array]) { $resp }
  else { @() }

if (-not $list -or $list.Count -lt 1) {
  throw "Flights list was empty."
}

$first = $list[0]
$hasFlightNumber = $first.ident_iata -or $first.ident -or $first.flight_number -or $first.flightNumber
$hasTimeIso = $first.estimated_off -or $first.scheduled_off -or $first.etd -or $first.time_iso

if (-not $hasFlightNumber) {
  throw "First flight row missing flight number fields (ident/flight_number)."
}

if (-not $hasTimeIso) {
  throw "First flight row missing time fields (estimated_off/scheduled_off)."
}

Write-Host "Flights payload looks valid."

Write-Host "Checking UI source for legacy endpoints (/api/roster/daily, /api/staff_runs)"
$legacyHits = & rg "/api/roster/daily|/api/staff_runs" src/pages src/components
if ($LASTEXITCODE -eq 0 -and $legacyHits) {
  throw "Legacy endpoints detected in UI pages/components.`n$legacyHits"
}

Write-Host "Legacy endpoints not referenced in UI pages/components."
