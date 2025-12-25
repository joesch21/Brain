$ErrorActionPreference = "Stop"

$script:PassCount = 0
$script:FailCount = 0
$script:WarnCount = 0

function Write-Pass([string]$name){
  $script:PassCount += 1
  Write-Host "[PASS] $name" -ForegroundColor Green
}

function Write-Fail([string]$name, [string]$message){
  $script:FailCount += 1
  Write-Host "[FAIL] $name — $message" -ForegroundColor Red
}

function Write-Warn([string]$name, [string]$message){
  $script:WarnCount += 1
  Write-Host "[WARN] $name — $message" -ForegroundColor Yellow
}

function Assert-True([bool]$condition, [string]$message){
  if (-not $condition) { throw $message }
}

function Assert-HasKeys($obj, $keys, [string]$name){
  $present = @($obj.PSObject.Properties.Name)
  $missing = @($keys | Where-Object { $present -notcontains $_ })
  Assert-True ($missing.Count -eq 0) "$name missing keys: $($missing -join ', ')"
}

function Assert-Equal($actual, $expected, [string]$name){
  Assert-True ($actual -eq $expected) "$name expected '$expected' got '$actual'"
}

function Assert-NotEmpty([string]$value, [string]$name){
  Assert-True (-not [string]::IsNullOrWhiteSpace($value)) "$name expected non-empty value"
}

function Invoke-JsonGet([string]$uri, [int]$timeoutSec){
  $response = Invoke-WebRequest -Method GET -Uri $uri -TimeoutSec $timeoutSec
  $json = $response.Content | ConvertFrom-Json
  return @{ Status = [int]$response.StatusCode; Json = $json }
}

function Invoke-JsonPost([string]$uri, $body, [int]$timeoutSec){
  $jsonBody = $body | ConvertTo-Json -Depth 6
  $response = Invoke-WebRequest -Method POST -Uri $uri -ContentType "application/json" -Body $jsonBody -TimeoutSec $timeoutSec
  $json = $response.Content | ConvertFrom-Json
  return @{ Status = [int]$response.StatusCode; Json = $json }
}

function Invoke-JsonExpectError([string]$method, [string]$uri, $body, [int]$timeoutSec){
  try {
    if ($null -ne $body) {
      Invoke-JsonPost $uri $body $timeoutSec | Out-Null
    } else {
      Invoke-WebRequest -Method $method -Uri $uri -TimeoutSec $timeoutSec | Out-Null
    }
    throw "Expected HTTP error but request succeeded"
  } catch {
    $response = $_.Exception.Response
    if ($null -eq $response) {
      throw $_
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

function Test-IsTimeoutException($exception){
  return ($null -ne $exception -and $exception.Status -eq [System.Net.WebExceptionStatus]::Timeout)
}

function Write-Summary(){
  Write-Host "== Summary ==" -ForegroundColor Cyan
  Write-Host "PASS: $script:PassCount  FAIL: $script:FailCount  WARN: $script:WarnCount"
}
