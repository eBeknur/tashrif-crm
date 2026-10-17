$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$nodeCommand = Get-Command node -ErrorAction Stop
$node = $nodeCommand.Source
$versionText = (& $node --version).Trim()
$major = [int]($versionText.TrimStart('v').Split('.')[0])
if ($major -lt 22) {
    throw "Node.js 22 yoki yangiroq versiya kerak. Topilgan: $versionText"
}

$existing = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 8000, 8443 } | Select-Object -First 1)
if ($existing.Count -gt 0) {
    throw "$($existing[0].LocalPort)-port band (PID $($existing[0].OwningProcess)). Mavjud jarayonni tekshiring; uni avtomatik to‘xtatmadim."
}

$dataPath = Join-Path $PSScriptRoot '.tashrif-data'
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $dataPath /inheritance:r /grant:r "$($identity):(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not set ACL on the local data folder.' }

& (Join-Path $PSScriptRoot 'setup-https.ps1')
if ($LASTEXITCODE -ne 0) { throw 'HTTPS sertifikati sozlanmadi.' }

& (Join-Path $PSScriptRoot 'setup-ai.ps1')
if ($LASTEXITCODE -ne 0) { throw 'YOLO va yuz moslashtirish modellari sozlanmadi.' }

Write-Host 'Tashrif CRM lokal serveri ishga tushmoqda. Toxtatish uchun Ctrl+C bosing.' -ForegroundColor Green
& $node (Join-Path $PSScriptRoot 'server.mjs')
