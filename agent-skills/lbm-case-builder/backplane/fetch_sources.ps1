# fetch_sources.ps1 — 接入官方 LBM 框架源码到 backplane/vendor/ (Windows)
# 用法:
#   .\fetch_sources.ps1 link "C:\path\to\palabos"   # 登记本机 Palabos (Junction)
#   .\fetch_sources.ps1 clone-palabos               # 浅克隆 Palabos
param([string]$mode = "help", [string]$src = "")

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $here "vendor"
New-Item -ItemType Directory -Force -Path $vendor | Out-Null

switch ($mode) {
  "link" {
    if ($src -and (Test-Path (Join-Path $src "src"))) {
      New-Item -ItemType Junction -Force -Path (Join-Path $vendor "src") -Target (Join-Path $src "src") | Out-Null
      $ex = Join-Path $src "examples"
      if (Test-Path $ex) { New-Item -ItemType Junction -Force -Path (Join-Path $vendor "examples") -Target $ex | Out-Null }
      Write-Host "[ok] 已登记本机框架: $src -> $vendor"
    } else {
      Write-Host "[warn] 未找到框架(需含 src\)。用法: .\fetch_sources.ps1 link C:\path\to\palabos"
    }
  }
  "clone-palabos" {
    git clone --depth 1 https://gitlab.com/unigespc/palabos.git (Join-Path $vendor "palabos")
    if ($LASTEXITCODE -ne 0) { Write-Host "[warn] 克隆失败 — 改用 link 登记本机 Palabos" }
  }
  "clone-openlb" {
    Write-Host "OpenLB 需从官网下载: https://www.openlb.net/download/  解压后 .\fetch_sources.ps1 link <dir>"
  }
  default { Write-Host "用法: .\fetch_sources.ps1 [link <DIR> | clone-palabos | clone-openlb]" }
}
Get-ChildItem $vendor -ErrorAction SilentlyContinue | Select-Object Name
