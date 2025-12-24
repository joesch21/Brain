# brain_http.ps1 — helpers for calling Brain UI/Brain backend endpoints with sensible defaults

$script:UiBase    = $env:BRAIN_UI_BASE    ? $env:BRAIN_UI_BASE    : 'http://127.0.0.1:5173'
$script:BrainBase = $env:BRAIN_API_BASE   ? $env:BRAIN_API_BASE   : 'http://127.0.0.1:5055'
$script:Airport   = $env:BRAIN_AIRPORT    ? $env:BRAIN_AIRPORT    : 'YSSY'

function Get-BrainFlights {
  param(
    [Parameter(Mandatory)][string]$Date,
    [string]$Operator = 'ALL',
    [string]$AirportOverride
  )
  $a = $AirportOverride ? $AirportOverride : $script:Airport
  Invoke-RestMethod "$script:UiBase/api/flights?date=$Date&airport=$a&operator=$Operator" -TimeoutSec 30
}

function Get-BrainRuns {
  param(
    [Parameter(Mandatory)][string]$Date,
    [string]$Operator = 'ALL',
    [string]$Shift = 'ALL',
    [string]$AirportOverride
  )
  $a = $AirportOverride ? $AirportOverride : $script:Airport
  Invoke-RestMethod "$script:UiBase/api/runs?date=$Date&airport=$a&operator=$Operator&shift=$Shift" -TimeoutSec 30
}

function Get-BrainRunsDaily {
  param(
    [Parameter(Mandatory)][string]$Date,
    [string]$Operator = 'ALL',
    [string]$Shift = 'ALL',
    [string]$AirportOverride
  )
  $a = $AirportOverride ? $AirportOverride : $script:Airport
  Invoke-RestMethod "$script:UiBase/api/runs?date=$Date&airport=$a&operator=$Operator&shift=$Shift" -TimeoutSec 30
}

function Get-BrainWiring {
  Invoke-RestMethod "$script:BrainBase/api/wiring-status" -TimeoutSec 10
}
