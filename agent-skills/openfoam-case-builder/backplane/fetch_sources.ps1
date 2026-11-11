# fetch_sources.ps1 — 重新拉取/更新两套官方 OpenFOAM 源码到 backplane/vendor/ (Windows)
# 说明: 本 skill 已内置 OpenFOAM-10/ 与 OpenFOAM-v2306/ 两套完整源码, 通常无需再跑此脚本。
#       仅当 vendor/ 被清空或想更新版本时使用。
# 用法:
#   .\fetch_sources.ps1 status                 # 查看已内置的两套源码
#   .\fetch_sources.ps1 clone                  # 重新浅克隆 OF-10 + ESI(v2306镜像)
#   .\fetch_sources.ps1 link  "C:\path\to\OF"  # 软链本机已装 OpenFOAM (WSL/原生)
param([string]$mode = "status", [string]$foamHome = $env:WM_PROJECT_DIR)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $here "vendor"
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
$git = "git"

function Show-Status {
  foreach ($v in @("OpenFOAM-10","OpenFOAM-v2306")) {
    $p = Join-Path $vendor $v
    if (Test-Path (Join-Path $p "applications\solvers")) {
      Write-Host ("[ok] {0}  (含 solvers/src/tutorials)" -f $v)
    } else {
      Write-Host ("[--] {0}  缺失, 可用 clone 重新拉取" -f $v)
    }
  }
}

switch ($mode) {
  "status" { Show-Status }
  "clone" {
    & $git -c core.longpaths=true clone --depth 1 --branch version-10 `
      https://github.com/OpenFOAM/OpenFOAM-10.git (Join-Path $vendor "OpenFOAM-10")
    & $git -c core.longpaths=true clone --depth 1 `
      https://e.coding.net/dyfluid/OpenFOAM/OpenFOAM-v2306.git (Join-Path $vendor "OpenFOAM-v2306")
    if ($LASTEXITCODE -ne 0) {
      Push-Location (Join-Path $vendor "OpenFOAM-v2306")
      & $git -c core.longpaths=true restore --source=HEAD :/
      Pop-Location
    }
    Show-Status
  }
  "link" {
    if ($foamHome -and (Test-Path $foamHome)) {
      $dst = Join-Path $vendor "OpenFOAM-local"
      foreach ($d in @("src","tutorials","applications")) {
        $t = Join-Path $foamHome $d
        if (Test-Path $t) { New-Item -ItemType Junction -Force -Path (Join-Path $dst $d) -Target $t | Out-Null }
      }
      Write-Host "[ok] 已登记本机 OpenFOAM: $foamHome -> $dst"
    } else {
      Write-Host "[warn] 未找到本机 OpenFOAM(设 WM_PROJECT_DIR 或传路径)。Windows 常装于 WSL, 请在 WSL 里跑 fetch_sources.sh link。"
    }
  }
  default { Write-Host "用法: .\fetch_sources.ps1 [status|clone|link <FOAM_DIR>]" }
}
