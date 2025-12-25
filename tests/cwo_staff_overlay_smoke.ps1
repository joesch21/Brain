param(
  [string]$Base     = "http://127.0.0.1:5173",
  [string]$Airport  = "YSSY",
  [string]$Operator = "ALL",
  [string]$Shift    = "ALL",
  [string]$Date     = "2025-12-22",
  [int]$TimeoutSec  = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Pass($m){ Write-Host "PASS: $m" -ForegroundColor Green }
function Fail($m){ Write-Host "FAIL: $m" -ForegroundColor Red; throw $m }
function Assert([bool]$c,[string]$m){ if(-not $c){Fail $m}else{Pass $m} }

function Status([string]$Url,[int]$T){
  try {
    $r = Invoke-WebRequest -Uri $Url -TimeoutSec $T -UseBasicParsing
    return [int]$r.StatusCode
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      return [int]$_.Exception.Response.StatusCode.value__
    }
    return -1
  }
}

function GetJson([string]$Url,[int]$T){
  return Invoke-RestMethod -Uri $Url -TimeoutSec $T
}

Write-Host "=== Staff Overlay Smoke (Non-blocking) ===" -ForegroundColor Cyan
Write-Host ("Base={0} Date={1} Airport={2} Operator={3} Shift={4}" -f $Base,$Date,$Airport,$Operator,$Shift) -ForegroundColor DarkGray

# Core endpoints must respond quickly (overlay must not affect these)
$flUrl = "{0}/api/flights?date={1}&airport={2}&operator={3}" -f $Base,$Date,$Airport,$Operator
$fl = GetJson $flUrl $TimeoutSec
Assert ($fl.ok -eq $true) "Flights ok=true"

$rnUrl = "{0}/api/runs?date={1}&airport={2}&operator={3}&shift={4}" -f $Base,$Date,$Airport,$Operator,$Shift
$rn = GetJson $rnUrl $TimeoutSec
Assert ($rn.ok -eq $true) "Runs ok=true"

# Assignments endpoint is OPTIONAL but must respond quickly
$asUrl = "{0}/api/employee_assignments/daily?date={1}&airport={2}&operator={3}&shift={4}" -f $Base,$Date,$Airport,$Operator,$Shift
$sc = Status $asUrl 8
Assert ($sc -ne -1) ("Assignments endpoint responded within 8s (status={0})" -f $sc)
Assert (($sc -eq 200) -or ($sc -eq 404) -or ($sc -eq 400) -or ($sc -eq 502) -or ($sc -eq 503)) ("Assignments status acceptable optional outcome (got {0})" -f $sc)

Write-Host "=== ALL TESTS PASSED ===" -ForegroundColor Green
exit 0
