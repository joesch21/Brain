$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root "src"

$hits = rg -n "['\"`]/api/" $src | Where-Object { $_ -notmatch 'apiUrl\(' }

if ($hits) {
  Write-Host "❌ Found relative /api/ usage in frontend code. Replace with apiUrl(...)." -ForegroundColor Red
  $hits | ForEach-Object { Write-Host $_ }
  exit 1
}

Write-Host "✅ No relative /api/ usage found." -ForegroundColor Green
