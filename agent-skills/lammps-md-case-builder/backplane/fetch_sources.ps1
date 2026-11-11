# fetch_sources.ps1 — 重新拉取/更新官方 LAMMPS 源码到 backplane/vendor/ (Windows)
# 说明: 本 skill 已内置 lammps-official\{src,doc}, 通常无需再跑。
#       仅当 vendor\ 被清空、想更新版本、或想补 potentials\ 时使用。
# 用法:
#   .\fetch_sources.ps1 status                 # 查看已内置源码
#   .\fetch_sources.ps1 clone                  # git clone 官方仓 (src+doc, 需网)
#   .\fetch_sources.ps1 link  "C:\path\lammps" # 软链本机 LAMMPS (含 potentials\)
param([string]$mode = "status", [string]$lmp = $env:LAMMPS_ROOT)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $here "vendor\lammps-official"
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
$git = "git"

function Show-Status {
  foreach ($d in @("src","doc")) {
    if (Test-Path (Join-Path $vendor $d)) { Write-Host "[ok] lammps-official\$d" } else { Write-Host "[--] lammps-official\$d 缺失" }
  }
  if (Test-Path (Join-Path $vendor "potentials")) { Write-Host "[ok] potentials (已 link)" } else { Write-Host "[--] potentials 未接入(生成时按官方命名引用即可)" }
}

switch ($mode) {
  "status" { Show-Status }
  "clone" {
    $tmp = Join-Path $env:TEMP ("lmp_" + [guid]::NewGuid().ToString("N").Substring(0,8))
    & $git clone --depth 1 https://github.com/lammps/lammps.git $tmp
    if ($LASTEXITCODE -eq 0) {
      Copy-Item (Join-Path $tmp "src") (Join-Path $vendor "src") -Recurse -Force
      Copy-Item (Join-Path $tmp "doc") (Join-Path $vendor "doc") -Recurse -Force
      if (Test-Path (Join-Path $tmp "LICENSE")) { Copy-Item (Join-Path $tmp "LICENSE") $vendor -Force }
      Remove-Item $tmp -Recurse -Force -EA SilentlyContinue
    } else { Write-Host "[warn] 克隆失败(网络?)" }
    Show-Status
  }
  "link" {
    if ($lmp -and (Test-Path (Join-Path $lmp "src"))) {
      New-Item -ItemType Junction -Force -Path (Join-Path $vendor "src") -Target (Join-Path $lmp "src") | Out-Null
      if (Test-Path (Join-Path $lmp "doc")) { New-Item -ItemType Junction -Force -Path (Join-Path $vendor "doc") -Target (Join-Path $lmp "doc") | Out-Null }
      if (Test-Path (Join-Path $lmp "potentials")) { New-Item -ItemType Junction -Force -Path (Join-Path $vendor "potentials") -Target (Join-Path $lmp "potentials") | Out-Null }
      Write-Host "[ok] 已登记本机 LAMMPS: $lmp"
    } else {
      Write-Host "[warn] 未找到 LAMMPS(需含 src\)。用法: .\fetch_sources.ps1 link C:\path\to\lammps"
    }
  }
  default { Write-Host "用法: .\fetch_sources.ps1 [status|clone|link <LAMMPS_DIR>]" }
}
