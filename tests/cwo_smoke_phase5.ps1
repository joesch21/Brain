# CWO-BRAIN-FLIGHTS-PULL-003
# Purpose: Single smoke/regression pack for contract + flights + runs + pull (anti-drift).

param(
  [string]$Base          = "http://127.0.0.1:5173",
  [string]$Airport       = "YSSY",
  [string]$Airline       = "ALL",
  [string]$Shift         = "ALL",
  [string]$DateHasData   = "2025-12-22",
  [string]$DateMaybeEmpty= "2025-12-24"
)

$ErrorActionPreference = "Stop"
$HttpTimeoutSec = 20
$PullTimeoutSec = 40

function Pass($name){ Write-Host "[PASS] $name" -ForegroundColor Green }
function Fail($name,$msg){ Write-Host "[FAIL] $name — $msg" -ForegroundColor Red }
function Assert($condition, $message){ if (-not $condition) { throw $message } }
function Assert-HasKeys($obj, $keys, $name){
  $present = @($obj.PSObject.Properties.Name)
  $missing = @($keys | Where-Object { $present -notcontains $_ })
  Assert ($missing.Count -eq 0) "$name missing keys: $($missing -join ', ')"
}
function Assert-Equal($actual, $expected, $name){
  Assert ($actual -eq $expected) "$name expected '$expected' got '$actual'"
}
function Assert-In($value, $choices, $name){
  Assert ($choices -contains $value) "$name expected one of [$($choices -join ', ')] got '$value'"
}
function Assert-ContainsText($text, $needle, $name){
  Assert ($null -ne $text -and $text.ToString().Contains($needle)) "$name expected to contain '$needle'"
}

function Invoke-JsonGet($uri, $timeout){
  return Invoke-RestMethod -Method GET -Uri $uri -TimeoutSec $timeout
}

function Invoke-JsonPost($uri, $body, $timeout){
  $jsonBody = $body | ConvertTo-Json -Depth 6
  return Invoke-RestMethod -Method POST -Uri $uri -ContentType "application/json" -Body $jsonBody -TimeoutSec $timeout
}

function Invoke-JsonExpectError($method, $uri, $body, $timeout){
  try {
    if ($null -ne $body) {
      Invoke-JsonPost $uri $body $timeout | Out-Null
    } else {
      Invoke-RestMethod -Method $method -Uri $uri -TimeoutSec $timeout | Out-Null
    }
    throw "Expected HTTP error but request succeeded"
  } catch {
    $response = $_.Exception.Response
    if ($null -eq $response) {
      throw "Expected HTTP error response but got none: $($_.Exception.Message)"
    }

    $status = [int]$response.StatusCode
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $content = $reader.ReadToEnd()
    $reader.Close()

    try {
      $json = $content | ConvertFrom-Json
    } catch {
      throw "Response not JSON (status $status): $content"
    }

    return @{ Status = $status; Json = $json }
  }
}

function Run-Check($name, [scriptblock]$block){
  try {
    & $block
    Pass $name
  } catch {
    Fail $name $_.Exception.Message
    exit 1
  }
}

Write-Host "== CWO Smoke Phase 5 ==" -ForegroundColor Cyan
Write-Host "Base=$Base Airport=$Airport Airline=$Airline Shift=$Shift DateHasData=$DateHasData DateMaybeEmpty=$DateMaybeEmpty"

Run-Check "S1 wiring status" {
  $wiring = Invoke-JsonGet "$Base/api/wiring-status" $HttpTimeoutSec
  Assert-HasKeys $wiring @("ok","upstream_base_url_active") "GET /api/wiring-status"
  Assert-Equal $wiring.ok $true "GET /api/wiring-status ok"
  Assert-ContainsText $wiring.upstream_base_url_active "code-crafter3" "GET /api/wiring-status upstream_base_url_active"
}

Run-Check "S2 contract endpoint present" {
  $contract = Invoke-JsonGet "$Base/api/contract" $HttpTimeoutSec
  Assert-HasKeys $contract @("endpoints") "GET /api/contract"
  $hasPull = $contract.endpoints | Where-Object { $_.name -eq "flights_pull" -and ($_.maps_to -contains "/api/flights/pull") }
  $hasRuns = $contract.endpoints | Where-Object { $_.name -eq "runs" -and ($_.maps_to -contains "/api/runs") }
  Assert ($null -ne $hasPull) "Missing flights_pull endpoint mapping to /api/flights/pull"
  Assert ($null -ne $hasRuns) "Missing runs endpoint mapping to /api/runs"
}

Run-Check "S3 airport required everywhere" {
  $flightsError = Invoke-JsonExpectError "GET" "$Base/api/flights?date=$DateHasData&airline=$Airline" $null $HttpTimeoutSec
  Assert-Equal $flightsError.Status 400 "GET /api/flights missing airport status"
  Assert-HasKeys $flightsError.Json @("ok","error") "GET /api/flights missing airport"
  Assert-Equal $flightsError.Json.ok $false "GET /api/flights missing airport ok"
  Assert-HasKeys $flightsError.Json.error @("code") "GET /api/flights missing airport error"
  Assert-In $flightsError.Json.error.code @("validation_error","bad_request") "GET /api/flights missing airport error.code"

  $runsError = Invoke-JsonExpectError "GET" "$Base/api/runs?date=$DateHasData&airline=$Airline&shift=$Shift" $null $HttpTimeoutSec
  Assert-Equal $runsError.Status 400 "GET /api/runs missing airport status"
  Assert-HasKeys $runsError.Json @("ok","error") "GET /api/runs missing airport"
  Assert-Equal $runsError.Json.ok $false "GET /api/runs missing airport ok"
  Assert-HasKeys $runsError.Json.error @("code") "GET /api/runs missing airport error"
  Assert-In $runsError.Json.error.code @("validation_error","bad_request") "GET /api/runs missing airport error.code"

  $pullError = Invoke-JsonExpectError "POST" "$Base/api/flights/pull" @{ date=$DateHasData; airline=$Airline } $HttpTimeoutSec
  Assert-Equal $pullError.Status 400 "POST /api/flights/pull missing airport status"
  Assert-HasKeys $pullError.Json @("ok","error") "POST /api/flights/pull missing airport"
  Assert-Equal $pullError.Json.ok $false "POST /api/flights/pull missing airport ok"
  Assert-HasKeys $pullError.Json.error @("code") "POST /api/flights/pull missing airport error"
  Assert-In $pullError.Json.error.code @("validation_error","bad_request") "POST /api/flights/pull missing airport error.code"
}

Run-Check "S4 flights read" {
  $flights = Invoke-JsonGet "$Base/api/flights?date=$DateHasData&airport=$Airport&airline=$Airline" $HttpTimeoutSec
  Assert-HasKeys $flights @("ok","airport","local_date","count","records") "GET /api/flights"
  Assert-Equal $flights.ok $true "GET /api/flights ok"
  Assert-Equal $flights.airport $Airport "GET /api/flights airport"
  Assert-Equal $flights.local_date $DateHasData "GET /api/flights local_date"
  Assert (([int]$flights.count) -ge 1) "GET /api/flights count >= 1"
}

Run-Check "S5 runs read" {
  $runs = Invoke-JsonGet "$Base/api/runs?date=$DateHasData&airport=$Airport&airline=$Airline&shift=$Shift" $HttpTimeoutSec
  Assert-HasKeys $runs @("ok","airport","local_date","count","runs") "GET /api/runs"
  Assert-Equal $runs.ok $true "GET /api/runs ok"
  Assert-Equal $runs.airport $Airport "GET /api/runs airport"
  Assert-Equal $runs.local_date $DateHasData "GET /api/runs local_date"
  Assert (([int]$runs.count) -ge 1) "GET /api/runs count >= 1"
}

Run-Check "S6 pull flights" {
  $baseline = Invoke-JsonGet "$Base/api/flights?date=$DateMaybeEmpty&airport=$Airport&airline=$Airline" $HttpTimeoutSec
  Assert-HasKeys $baseline @("ok","count") "GET /api/flights baseline"
  $baselineCount = [int]$baseline.count

  $pullBody = @{
    date     = $DateMaybeEmpty
    airport  = $Airport
    airline  = $Airline
    store    = $true
    timeout  = 30
  }
  $pull = Invoke-JsonPost "$Base/api/flights/pull" $pullBody $PullTimeoutSec
  Assert-HasKeys $pull @("ok","airport","local_date","airline","source","upstream","payload") "POST /api/flights/pull"
  Assert-HasKeys $pull.upstream @("status_code","path","base_url") "POST /api/flights/pull.upstream"
  Assert-Equal $pull.upstream.path "/api/flights/ingest/aeroapi" "POST /api/flights/pull upstream.path"

  $after = Invoke-JsonGet "$Base/api/flights?date=$DateMaybeEmpty&airport=$Airport&airline=$Airline" $HttpTimeoutSec
  Assert-HasKeys $after @("ok","count") "GET /api/flights after"
  $afterCount = [int]$after.count
  Assert ($afterCount -ge $baselineCount) "GET /api/flights count non-decreasing after pull"
}

Run-Check "S7 legacy runs/daily deprecated" {
  $legacy = Invoke-JsonExpectError "GET" "$Base/api/runs/daily?date=$DateHasData&airport=$Airport&airline=$Airline&shift=$Shift" $null $HttpTimeoutSec
  Assert-Equal $legacy.Status 410 "GET /api/runs/daily status"
  Assert-HasKeys $legacy.Json @("ok","error") "GET /api/runs/daily"
  Assert-Equal $legacy.Json.ok $false "GET /api/runs/daily ok"
  Assert-HasKeys $legacy.Json.error @("code") "GET /api/runs/daily error"
  Assert-Equal $legacy.Json.error.code "deprecated" "GET /api/runs/daily error.code"
}

Pass "CWO-BRAIN-FLIGHTS-PULL-003 complete"
