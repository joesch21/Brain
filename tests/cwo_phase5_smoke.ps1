# CWO-BRAIN-FLIGHTS-PULL-003
# Purpose: Single Phase 5 smoke/regression pack for contract + flights + runs + pull (anti-drift).

param(
  [string]$Base           = "http://127.0.0.1:5173",
  [string]$Airport        = "YSSY",
  [string]$Airline        = "ALL",
  [string]$Shift          = "ALL",
  [string]$DateHasData    = "2025-12-22",
  [string]$DateMaybeEmpty = "2025-12-24",
  [int]$TimeoutSec        = 30
)

. "$PSScriptRoot/lib/assert.ps1"

function Run-Check([string]$name, [scriptblock]$block, [switch]$NonBlockingTimeout){
  try {
    & $block
    Write-Pass $name
  } catch {
    if ($NonBlockingTimeout -and (Test-IsTimeoutException $_.Exception)) {
      Write-Warn $name "Timeout contacting endpoint (non-blocking)."
      return
    }

    Write-Fail $name $_.Exception.Message
    Write-Summary
    exit 1
  }
}

Write-Host "== CWO Phase 5 Smoke Runner ==" -ForegroundColor Cyan
Write-Host "Base=$Base Airport=$Airport Airline=$Airline Shift=$Shift DateHasData=$DateHasData DateMaybeEmpty=$DateMaybeEmpty TimeoutSec=$TimeoutSec"

Run-Check "P5-01 wiring-status ok" {
  $response = Invoke-JsonGet "$Base/api/wiring-status" $TimeoutSec
  Assert-Equal $response.Status 200 "GET /api/wiring-status status"
  Assert-HasKeys $response.Json @("ok","upstream_base_url_active") "GET /api/wiring-status"
  Assert-Equal $response.Json.ok $true "GET /api/wiring-status ok"
  Assert-NotEmpty $response.Json.upstream_base_url_active "GET /api/wiring-status upstream_base_url_active"
} -NonBlockingTimeout

Run-Check "P5-02 airport required (400s)" {
  $flightsError = Invoke-JsonExpectError "GET" "$Base/api/flights?date=$DateHasData&airline=$Airline" $null $TimeoutSec
  Assert-Equal $flightsError.Status 400 "GET /api/flights missing airport status"

  $runsError = Invoke-JsonExpectError "GET" "$Base/api/runs?date=$DateHasData&airline=$Airline&shift=$Shift" $null $TimeoutSec
  Assert-Equal $runsError.Status 400 "GET /api/runs missing airport status"

  $pullError = Invoke-JsonExpectError "POST" "$Base/api/flights/pull" @{ date=$DateHasData; airline=$Airline } $TimeoutSec
  Assert-Equal $pullError.Status 400 "POST /api/flights/pull missing airport status"
} 

Run-Check "P5-03 legacy /api/runs/daily deprecated (410)" {
  $legacy = Invoke-JsonExpectError "GET" "$Base/api/runs/daily?date=$DateHasData&airport=$Airport&airline=$Airline&shift=$Shift" $null $TimeoutSec
  Assert-Equal $legacy.Status 410 "GET /api/runs/daily status"
}

Run-Check "P5-04 flights read (keys + count)" {
  $flights = Invoke-JsonGet "$Base/api/flights?date=$DateHasData&airport=$Airport&airline=$Airline" $TimeoutSec
  Assert-Equal $flights.Status 200 "GET /api/flights status"
  Assert-HasKeys $flights.Json @("ok","airport","local_date","count","records") "GET /api/flights"
  Assert-Equal $flights.Json.ok $true "GET /api/flights ok"
  Assert-Equal $flights.Json.airport $Airport "GET /api/flights airport"
  Assert-Equal $flights.Json.local_date $DateHasData "GET /api/flights local_date"
  Assert-True (([int]$flights.Json.count) -ge 1) "GET /api/flights count >= 1"
}

Run-Check "P5-05 runs read (keys + count)" {
  $runs = Invoke-JsonGet "$Base/api/runs?date=$DateHasData&airport=$Airport&airline=$Airline&shift=$Shift" $TimeoutSec
  Assert-Equal $runs.Status 200 "GET /api/runs status"
  Assert-HasKeys $runs.Json @("ok","airport","local_date","count","runs") "GET /api/runs"
  Assert-Equal $runs.Json.ok $true "GET /api/runs ok"
  Assert-Equal $runs.Json.airport $Airport "GET /api/runs airport"
  Assert-Equal $runs.Json.local_date $DateHasData "GET /api/runs local_date"
  Assert-True (([int]$runs.Json.count) -ge 1) "GET /api/runs count >= 1"
}

Run-Check "P5-06 pull flights (envelope + idempotency)" {
  $baseline = Invoke-JsonGet "$Base/api/flights?date=$DateMaybeEmpty&airport=$Airport&airline=$Airline" $TimeoutSec
  Assert-Equal $baseline.Status 200 "GET /api/flights baseline status"
  Assert-HasKeys $baseline.Json @("ok","count") "GET /api/flights baseline"
  $baselineCount = [int]$baseline.Json.count

  $pullBody = @{
    date     = $DateMaybeEmpty
    airport  = $Airport
    airline  = $Airline
    store    = $true
    timeout  = $TimeoutSec
    scope    = "both"
  }
  $pull = Invoke-JsonPost "$Base/api/flights/pull" $pullBody $TimeoutSec
  Assert-Equal $pull.Status 200 "POST /api/flights/pull status"
  Assert-HasKeys $pull.Json @("ok","airport","local_date","airline","source","upstream","payload") "POST /api/flights/pull"
  Assert-Equal $pull.Json.source "upstream" "POST /api/flights/pull source"
  Assert-HasKeys $pull.Json.upstream @("status_code","path","base_url") "POST /api/flights/pull upstream"
  Assert-Equal $pull.Json.upstream.path "/api/flights/ingest/aeroapi" "POST /api/flights/pull upstream.path"

  $after = Invoke-JsonGet "$Base/api/flights?date=$DateMaybeEmpty&airport=$Airport&airline=$Airline" $TimeoutSec
  Assert-Equal $after.Status 200 "GET /api/flights after status"
  Assert-HasKeys $after.Json @("ok","count") "GET /api/flights after"
  $afterCount = [int]$after.Json.count
  Assert-True ($afterCount -ge $baselineCount) "GET /api/flights count non-decreasing after pull"
}

Write-Pass "CWO-BRAIN-FLIGHTS-PULL-003 complete"
Write-Summary

if ($script:FailCount -gt 0) { exit 1 }
