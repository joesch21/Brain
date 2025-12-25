param(
  [string]$Base    = "http://127.0.0.1:5173",
  [string]$Airport = "YSSY",
  [string]$Operator= "ALL",
  [string]$DateHasData = "2025-12-22",
  [string]$DateMaybeEmpty = "2025-12-24",
  [int]$TimeoutSec = 30
)

$ErrorActionPreference = "Stop"

function Write-Pass($msg) { Write-Host "PASS: $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; throw $msg }

function Assert-True($cond, $msg) { if (-not $cond) { Write-Fail $msg } else { Write-Pass $msg } }

function Get-StatusCode($url) {
  try {
    $r = Invoke-WebRequest -Uri $url -Method GET -TimeoutSec $TimeoutSec -UseBasicParsing
    return [int]$r.StatusCode
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      return [int]$_.Exception.Response.StatusCode.value__
    }
    throw
  }
}

function Post-StatusCode($url, $jsonBody) {
  try {
    $r = Invoke-WebRequest -Uri $url -Method POST -ContentType "application/json" -Body $jsonBody -TimeoutSec $TimeoutSec -UseBasicParsing
    return [int]$r.StatusCode
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      return [int]$_.Exception.Response.StatusCode.value__
    }
    throw
  }
}

function Require-Keys($obj, [string[]]$keys, $label) {
  foreach ($k in $keys) {
    Assert-True ($null -ne $obj.PSObject.Properties[$k]) "$label has key '$k'"
  }
}

Write-Host "=== CWO Flights Pull MVP Test ===" -ForegroundColor Cyan
Write-Host "Base=$Base Airport=$Airport Operator=$Operator DateHasData=$DateHasData DateMaybeEmpty=$DateMaybeEmpty" -ForegroundColor DarkGray

# ---------- Negative tests: airport required ----------
$sc = Get-StatusCode "$Base/api/flights?date=$DateHasData&operator=$Operator"
Assert-True ($sc -eq 400) "GET /api/flights without airport returns 400 (got $sc)"

$sc = Get-StatusCode "$Base/api/runs?date=$DateHasData&operator=$Operator&shift=ALL"
Assert-True ($sc -eq 400) "GET /api/runs without airport returns 400 (got $sc)"

$bodyMissingAirport = @{ date=$DateHasData; operator=$Operator } | ConvertTo-Json
$sc = Post-StatusCode "$Base/api/flights/pull" $bodyMissingAirport
Assert-True ($sc -eq 400) "POST /api/flights/pull without airport returns 400 (got $sc)"

# ---------- Legacy anti-drift (optional but recommended) ----------
$sc = Get-StatusCode "$Base/api/runs/daily?date=$DateHasData&airport=$Airport&operator=$Operator&shift=ALL"
Assert-True ($sc -eq 410) "GET /api/runs/daily returns 410 deprecated (got $sc)"

# ---------- Positive: flights read for known-good date ----------
$fl = Invoke-RestMethod "$Base/api/flights?date=$DateHasData&airport=$Airport&operator=$Operator" -TimeoutSec $TimeoutSec
Require-Keys $fl @("ok","airport","local_date","count","source") "Flights($DateHasData)"
Assert-True ($fl.ok -eq $true) "Flights($DateHasData) ok=true"
Assert-True ($fl.airport -eq $Airport) "Flights($DateHasData) airport=$Airport"
Assert-True ($fl.local_date -eq $DateHasData) "Flights($DateHasData) local_date=$DateHasData"
Assert-True ($fl.count -ge 1) "Flights($DateHasData) count >= 1 (got $($fl.count))"

# ---------- Positive: runs read for known-good date ----------
$rn = Invoke-RestMethod "$Base/api/runs?date=$DateHasData&airport=$Airport&operator=$Operator&shift=ALL" -TimeoutSec $TimeoutSec
Require-Keys $rn @("ok","airport","local_date","count","source") "Runs($DateHasData)"
Assert-True ($rn.ok -eq $true) "Runs($DateHasData) ok=true"
Assert-True ($rn.airport -eq $Airport) "Runs($DateHasData) airport=$Airport"
Assert-True ($rn.local_date -eq $DateHasData) "Runs($DateHasData) local_date=$DateHasData"
Assert-True ($rn.count -ge 1) "Runs($DateHasData) count >= 1 (got $($rn.count))"

# ---------- Pull flow: baseline -> pull -> after (non-decreasing count rule) ----------
$before = Invoke-RestMethod "$Base/api/flights?date=$DateMaybeEmpty&airport=$Airport&operator=$Operator" -TimeoutSec $TimeoutSec
Require-Keys $before @("ok","count","source","airport","local_date") "FlightsBefore($DateMaybeEmpty)"
$beforeCount = [int]$before.count
Write-Host "Baseline flights count for $DateMaybeEmpty: $beforeCount" -ForegroundColor DarkGray

$pullBody = @{
  date    = $DateMaybeEmpty
  airport = $Airport
  operator= $Operator
  store   = $true
  timeout = 30
  scope   = "both"
} | ConvertTo-Json

$pull = Invoke-RestMethod -Method POST -Uri "$Base/api/flights/pull" -ContentType "application/json" -Body $pullBody -TimeoutSec ([Math]::Max($TimeoutSec, 60))
Require-Keys $pull @("ok","airport","local_date","operator","source","upstream","payload") "Pull($DateMaybeEmpty)"
Require-Keys $pull.upstream @("base_url","path","status_code") "Pull.upstream"
Assert-True ($pull.airport -eq $Airport) "Pull airport=$Airport"
Assert-True ($pull.local_date -eq $DateMaybeEmpty) "Pull local_date=$DateMaybeEmpty"
Assert-True ($pull.source -eq "upstream") "Pull source=upstream"
Assert-True ($pull.upstream.path -eq "/api/flights/ingest/aeroapi") "Pull upstream.path is /api/flights/ingest/aeroapi"

$after = Invoke-RestMethod "$Base/api/flights?date=$DateMaybeEmpty&airport=$Airport&operator=$Operator" -TimeoutSec $TimeoutSec
Require-Keys $after @("ok","count","source","airport","local_date") "FlightsAfter($DateMaybeEmpty)"
$afterCount = [int]$after.count
Write-Host "After pull flights count for $DateMaybeEmpty: $afterCount" -ForegroundColor DarkGray
Assert-True ($afterCount -ge $beforeCount) "FlightsAfter count non-decreasing (before=$beforeCount after=$afterCount)"

Write-Host "=== ALL TESTS PASSED ===" -ForegroundColor Green
exit 0
