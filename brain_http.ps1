# brain_http.ps1  helpers for calling Brain UI/Brain backend endpoints with sensible defaults
# Compatible with Windows PowerShell 5.1 (NO ternary operator)

$script:UiBase    = if ($env:BRAIN_UI_BASE)  { $env:BRAIN_UI_BASE  } else { 'http://127.0.0.1:5173' }
$script:ApiBase   = if ($env:BRAIN_API_BASE) { $env:BRAIN_API_BASE } else { 'http://127.0.0.1:5055' }
$script:Airport   = if ($env:BRAIN_AIRPORT)  { $env:BRAIN_AIRPORT  } else { 'YSSY' }

function Get-BrainFlights {
  param(
    [Parameter(Mandatory)][string]$Date,
    [string]$Operator = 'ALL',
    [string]$AirportOverride
  )

  $a = if ($AirportOverride) { $AirportOverride } else { $script:Airport }
  $url = "$script:UiBase/api/flights?date=$Date&airport=$a&operator=$Operator"
  Invoke-RestMethod -Uri $url -TimeoutSec 30
}

function Get-BrainRuns {
  param(
    [Parameter(Mandatory)][string]$Date,
    [string]$Operator = 'ALL',
    [string]$Shift = 'ALL',
    [string]$AirportOverride
  )

  $a = if ($AirportOverride) { $AirportOverride } else { $script:Airport }
  $url = "$script:UiBase/api/runs?date=$Date&airport=$a&operator=$Operator&shift=$Shift"
  Invoke-RestMethod -Uri $url -TimeoutSec 30
}

function Get-BrainContract {
  $url = "$script:UiBase/api/contract"
  Invoke-RestMethod -Uri $url -TimeoutSec 10
}

function Get-BrainWiring {
  $url = "$script:ApiBase/api/wiring-status"
  Invoke-RestMethod -Uri $url -TimeoutSec 10
}
