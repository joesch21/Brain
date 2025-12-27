<#
cwo_sync.ps1
Safe CWO sync script for Brain repo
#>

param(
  [Parameter(Mandatory=$true)]
  [string]$Cwo,

  [Parameter(Mandatory=$true)]
  [string]$Msg,

  [string]$RepoDir = "E:\Brain",
  [string]$Remote = "origin",
  [string]$MainBranch = "main"
)

$ErrorActionPreference = "Stop"

function Run-Git {
  param([string]$Args)
  Write-Host ">> git $Args" -ForegroundColor Cyan
  $out = git $Args 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host $out -ForegroundColor Red
    throw "Git command failed: git $Args"
  }
  return $out
}

# --- Start ---
if (-not (Test-Path $RepoDir)) {
  throw "RepoDir not found: $RepoDir"
}
Set-Location $RepoDir

# Safety: block if rebase or merge in progress
$gitDir = (Run-Git "rev-parse --git-dir").Trim()

$rebaseApply = Test-Path (Join-Path $gitDir "rebase-apply")
$rebaseMerge = Test-Path (Join-Path $gitDir "rebase-merge")
$mergeHead   = Test-Path (Join-Path $gitDir "MERGE_HEAD")

if ($rebaseApply -or $rebaseMerge -or $mergeHead) {
  throw "Repo has an in-progress rebase or merge. Resolve it first (git status)."
}

# 1) Fetch latest
Run-Git "fetch --prune $Remote"

# 2) Update main safely
Run-Git "switch $MainBranch"
Run-Git "pull --ff-only $Remote $MainBranch"

# 3) Switch/create CWO branch
$branchName = "cwo/$Cwo"
$exists = Run-Git "branch --list $branchName"

if ($exists) {
  Run-Git "switch $branchName"
} else {
  Run-Git "switch -c $branchName"
}

# 4) Commit local changes if any
$status = Run-Git "status --porcelain"
if ($status) {
  Run-Git "add -A"
  $staged = Run-Git "diff --cached --name-only"
  if ($staged) {
    Run-Git "commit -m `"$Msg`""
  } else {
    Write-Host "Nothing staged after add." -ForegroundColor Yellow
  }
} else {
  Write-Host "Working tree clean — nothing to commit." -ForegroundColor Yellow
}

# 5) Rebase on latest main
Run-Git "rebase $Remote/$MainBranch"

# 6) Push branch
Run-Git "push -u $Remote $branchName"

# 7) Helpful output
$repoUrl = (Run-Git "config --get remote.$Remote.url").Trim()
if ($repoUrl -match "^git@github\.com:(.+)\.git$") {
  $repoWeb = "https://github.com/$($Matches[1])"
} elseif ($repoUrl -match "^https://github\.com/.+\.git$") {
  $repoWeb = $repoUrl -replace "\.git$", ""
} else {
  $repoWeb = $repoUrl
}

Write-Host ""
Write-Host "DONE ✅" -ForegroundColor Green
Write-Host "Branch: $branchName"
Write-Host "Open PR: $repoWeb/compare/$branchName?expand=1" -ForegroundColor Green
Write-Host ""
