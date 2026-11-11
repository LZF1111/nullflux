# fetch_sources.ps1 — 接入官方 MFiX 源码到 backplane/vendor/MFiX/ (Windows)
# 用法: .\fetch_sources.ps1 link "C:\path\to\mfix"   |   .\fetch_sources.ps1 clone
param([string]$mode = "link", [string]$mfixHome = $env:MFIX_HOME)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $here "vendor\MFiX"
New-Item -ItemType Directory -Force -Path $vendor | Out-Null

switch ($mode) {
  "link" {
    if ($mfixHome -and (Test-Path (Join-Path $mfixHome "model"))) {
      foreach ($d in @("model","tutorials","doc")) {
        $t = Join-Path $mfixHome $d
        if (Test-Path $t) { New-Item -ItemType Junction -Force -Path (Join-Path $vendor $d) -Target $t | Out-Null }
      }
      Write-Host "[ok] 已登记本机 MFiX: $mfixHome -> $vendor"
    } else {
      Write-Host "[warn] 未找到 MFiX(需含 model\)。用法: .\fetch_sources.ps1 link C:\path\to\mfix"
    }
  }
  "clone" {
    git clone --depth 1 https://mfix.netl.doe.gov/gitlab/develop/mfix.git (Join-Path $vendor "mfix")
    if ($LASTEXITCODE -ne 0) { Write-Host "[warn] 克隆失败 — 改用 link 登记本机 MFiX" }
  }
  default { Write-Host "用法: .\fetch_sources.ps1 [link <MFIX_HOME>|clone]" }
}
Get-ChildItem $vendor -ErrorAction SilentlyContinue | Select-Object Name
