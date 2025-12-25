# CWO-BRAIN-FLIGHTS-PULL-003
# Purpose: End-to-end validation for Pull Flights MVP + anti-drift checks.
# One sentence: Runs required contract tests (airport required), performs a pull, then validates response shapes.

param(
  [string]$Base    = "http://127.0.0.1:5173",
  [string]$Airport = "YSSY",
  [string]$Op      = "ALL",
  [string]$Date    = "2025-12-24"
)

$ErrorActionPreference = "Stop"

function Pass($name){ Write-Host "[PASS] $name" -ForegroundColor Green }
function Fail($name,$msg){ Write-Host "[FAIL] $name — $msg" -ForegroundColor Red }
function Assert-HasKeys($obj, $keys, $name){
  $present = @($obj.PSObject.Properties.Name)
  $missing = @($keys | Where-Object { $present -notcontains $_ })
  if ($missing.Count -gt 0) { throw "$name missing keys: $($missing -join ', ')" }
}

$results = @()

try {
  Write-Host "== Preconditions ==" -ForegroundColor Cyan
  Write-Host "Base=$Base Date=$Date Airport=$Airport Operator=$Op"

  # A0: Contract includes flights_pull
  $contract = Invoke-RestMethod "$Base/api/contract"
  if ($null -eq ($contract.endpoints | Where-Object { $_.name -eq "flights_pull" })) {
    Fail "A0 contract includes flights_pull" "Missing flights_pull endpoint in /api/contract"
  } else {
    Pass "A0 contract includes flights_pull"
  }

  # A1: Airport required (GET flights)
  try {
    Invoke-RestMethod "$Base/api/flights?date=$Date&operator=$Op" | Out-Null
    Fail "A1 airport required (GET /api/flights)" "Request succeeded without airport"
  } catch {
    Pass "A1 airport required (GET /api/flights)"
  }

  # A2: Airport required (GET runs)
  try {
    Invoke-RestMethod "$Base/api/runs?date=$Date&operator=$Op&shift=ALL" | Out-Null
    Fail "A2 airport required (GET /api/runs)" "Request succeeded without airport"
  } catch {
    Pass "A2 airport required (GET /api/runs)"
  }

  # A3: Airport required (POST pull)
  try {
    $bodyMissing = @{ date=$Date; operator=$Op } | ConvertTo-Json
    Invoke-RestMethod -Method POST -Uri "$Base/api/flights/pull" -ContentType "application/json" -Body $bodyMissing | Out-Null
    Fail "A3 airport required (POST /api/flights/pull)" "Request succeeded without airport"
  } catch {
    Pass "A3 airport required (POST /api/flights/pull)"
  }

  # B1: Baseline
  Write-Host "== Baseline read ==" -ForegroundColor Cyan
  $before = Invoke-RestMethod "$Base/api/flights?date=$Date&airport=$Airport&operator=$Op"
  Assert-HasKeys $before @("ok","airport","local_date","source","count","records") "GET /api/flights baseline"
  $beforeCount = [int]$before.count
  Write-Host "Before: source=$($before.source) count=$beforeCount"

  # B2: Pull
  Write-Host "== Pull ==" -ForegroundColor Cyan
  $pullBody = @{
    date    = $Date
    airport = $Airport
    operator= $Op
    store   = $true
    timeout = 30
  } | ConvertTo-Json

  $pull = Invoke-RestMethod -Method POST -Uri "$Base/api/flights/pull" -ContentType "application/json" -Body $pullBody
  Assert-HasKeys $pull @("ok","airport","local_date","operator","source","upstream","payload") "POST /api/flights/pull"
  Assert-HasKeys $pull.upstream @("status_code","path","base_url") "POST /api/flights/pull.upstream"

  Write-Host "Pull: upstream_status=$($pull.upstream.status_code) ok=$($pull.ok)"

  # B3: After
  Write-Host "== After read ==" -ForegroundColor Cyan
  $after = Invoke-RestMethod "$Base/api/flights?date=$Date&airport=$Airport&operator=$Op"
  Assert-HasKeys $after @("ok","airport","local_date","source","count","records") "GET /api/flights after"
  $afterCount = [int]$after.count
  Write-Host "After: source=$($after.source) count=$afterCount"

  if ($afterCount -ge $beforeCount) {
    Pass "B3 flights count non-decreasing after pull"
  } else {
    Fail "B3 flights count non-decreasing after pull" "before=$beforeCount after=$afterCount"
  }

  Pass "CWO-BRAIN-FLIGHTS-PULL-003 complete"
}
catch {
  Fail "CWO-BRAIN-FLIGHTS-PULL-003" $_.Exception.Message
  exit 1
}
