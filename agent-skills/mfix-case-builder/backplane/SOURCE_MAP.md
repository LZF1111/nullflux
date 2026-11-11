# MFiX 官方源码背板索引 (SOURCE_MAP)

> 用法见 `../../_shared/BACKPLANE.md`。官方源码来自 NETL MFiX（mfix.netl.doe.gov / GitLab
> `MFIX/mfix`）。写 `usr*.f` 前来这查参照 subroutine，在 `vendor/MFiX/`（或本机安装的 MFiX）
> `read_file` 打开核对签名/模块/索引宏。

## 背板根目录解析顺序
1. `vendor/MFiX/`（fetch 脚本拉取或精选实拷）
2. 本机 MFiX 安装根（含 `model/` 与 `tutorials/`）——环境变量常见 `MFIX_HOME` 或 conda 环境路径。

## 一、算例 → 官方 tutorial 参照（tutorials/ 下）

| 你要生成 | 参照官方 tutorial | 模式 |
| --- | --- | --- |
| 2D 鼓泡流化床 | `tutorials/tfm/fluid_bed_2d`（或 `fluidBed*`） | TFM |
| 喷动床 spouted bed | `tutorials/.../spouted_bed` | TFM/DEM |
| 循环流化床 CFB | `tutorials/.../CFB` | TFM |
| DEM 料斗/下料 | `tutorials/dem/hopper` | DEM |
| DEM 转鼓/混合 | `tutorials/dem/rotating_drum` | DEM |
| PIC 大规模床 | `tutorials/pic/...` | PIC |
| 带化学反应 | `tutorials/.../reactor` 或 chem 相关 | TFM+chem |
| cut-cell 复杂几何 | `tutorials/.../cartesian_grid` | 任意 |

## 二、自定义 Fortran → 官方 model/ 参照

| 你要写 | 官方桩/参考(model/ 下) | 关键模块(USE) |
| --- | --- | --- |
| `usr_drag.f` | `model/usr_drag.f` + `model/drag_gs.f`(调用点/参数) | param, constant |
| `usr_rates.f` | `model/usr_rates.f` | rxns, fldvar, physprop, indices, compar |
| `usr_rates_des.f` | `model/des/usr_rates_des.f` | discretelement, des_rxns |
| `usr_properties.f` | `model/usr_properties.f` | fldvar, physprop, constant |
| `usr0.f`/`usr1.f` | `model/usr0.f`, `model/usr1.f`, `model/usr_mod.f` | usr, run, fldvar |
| 访问场变量 | `model/fldvar_mod.f`(EP_g,ROP_s,U_g,T_g,X_g...) | fldvar |
| 网格索引/循环 | `model/indices_mod.f`, `model/functions.f`(FUNIJK, FLUID_AT) | indices, functions, compar |

## 三、keyword 权威定义

- keyword 完整清单与含义：官方 `model/` 里 keyword 相关模块 + 官方文档 `doc/`；
  或本机 `mfix --help`。生成 keyword 有疑义时以官方 keyword 参考手册为准。

## 四、编译

- `build_mfixsolver`（官方脚本）在算例目录检测 `usr*.f` 并编译；细节看官方 `doc/` 的 build 说明与
  `Makefile`/CMake。

> `vendor/` 为空且本机未装 MFiX：在总览顶部标注 `⚠ 未接入官方源码背板`，提示用户跑 fetch 或登记安装路径。
