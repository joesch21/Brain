# validate_airline_param.ps1
# Purpose: Validate airline/legacy operator alias behavior + conflict guard + airport requirement.

param(
  [string]$Base = "http://127.0.0.1:5173",
  [string]$Date = "2025-12-24",
  [string]$Airport = "YSSY"
)

$ErrorActionPreference = "Stop"

function Write-Pass($msg) { Write-Host "[PASS] $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; throw $msg }

function Assert-True($cond, $msg) {
  if (-not $cond) { Write-Fail $msg } else { Write-Pass $msg }
}

function Assert-HasKeys($obj, [string[]]$keys, $label) {
  foreach ($k in $keys) {
    Assert-True ($null -ne $obj.PSObject.Properties[$k]) "$label has key '$k'"
  }
}

function Invoke-JsonGet($uri, $timeout = 20) {
  return Invoke-RestMethod -Method GET -Uri $uri -TimeoutSec $timeout
}

function Invoke-JsonExpectError($method, $uri, $body, $timeout = 20) {
  try {
    if ($null -ne $body) {
      $jsonBody = $body | ConvertTo-Json -Depth 6
      Invoke-RestMethod -Method $method -Uri $uri -ContentType "application/json" -Body $jsonBody -TimeoutSec $timeout | Out-Null
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

Write-Host "=== Validate airline param ===" -ForegroundColor Cyan
Write-Host "Base=$Base Date=$Date Airport=$Airport" -ForegroundColor DarkGray

# 1) Canonical airline works
$canonicalUrl = "$Base/api/flights?date=$Date&airport=$Airport&airline=ALL"
$canonical = Invoke-JsonGet $canonicalUrl
Assert-HasKeys $canonical @("airline") "GET /api/flights (canonical airline)"
Assert-True ($canonical.airline -eq "ALL") "Canonical airline returns airline=ALL"

# 2) Legacy operator alias works
$legacyUrl = "$Base/api/flights?date=$Date&airport=$Airport&operator=ALL"
$legacy = Invoke-JsonGet $legacyUrl
Assert-HasKeys $legacy @("airline") "GET /api/flights (legacy operator)"
Assert-True ($legacy.airline -eq "ALL") "Legacy operator maps to airline=ALL"
Assert-True (-not ($legacy.PSObject.Properties.Name -contains "operator")) "Legacy response excludes operator"

# 3) Conflict guard rejects mismatch
$conflict = Invoke-JsonExpectError "GET" "$Base/api/flights?date=$Date&airport=$Airport&airline=JQ&operator=ALL" $null
Assert-True ($conflict.Status -eq 400) "Conflict guard returns HTTP 400"
Assert-True ($conflict.Json.error.code -eq "param_conflict") "Conflict guard returns error.code=param_conflict"

# 4) Airport is still required
$missingAirport = Invoke-JsonExpectError "GET" "$Base/api/flights?date=$Date&airline=ALL" $null
Assert-True ($missingAirport.Status -eq 400) "Missing airport returns HTTP 400"

Write-Host "=== Airline param validation complete ===" -ForegroundColor Cyan
