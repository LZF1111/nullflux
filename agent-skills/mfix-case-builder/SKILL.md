---
name: mfix-case-builder
description: >-
  生成、修改与校验 MFiX (气固多相/流化床 CFD-DEM/TFM/PIC) 算例的输入文件 (mfix.dat 或
  project.mfx) 与自定义源码 (usr*.f / usr_rates.f 反应速率 / usr_drag / usr_properties)。
  当用户要求：搭建流化床/喷动床/鼓泡床/输运床/CFB/颗粒反应器模拟、编写或修改 MFiX keyword
  (RUN_TYPE/GEOMETRY/IMAX-JMAX-KMAX/DT/TSTOP/物性/BC_/IC_/DES 颗粒参数/DRAG_TYPE/化学反应)、
  在 TFM(两流体)、DEM(离散元)、PIC(MP-PIC/CGP) 三种求解模式间选型、或植入自定义曳力/反应/物性
  Fortran 源码时使用。只负责生成 .dat/.mfx 与 usr*.f 源码；实际 mfixsolver 运行由用户本机 MFiX 执行。
  输出整体算例文件 + 三份总览(文件/算法/调优)，写自定义源码时以官方 MFiX 源代码为背板参照。
license: MIT
---

# MFiX 气固多相算例配置技能

你现在具备为 **MFiX (24.x / 23.x，Sandia/NETL 官方)** 生成气固多相仿真算例输入文件与自定义
Fortran 源码的领域能力。本技能**只产出完整代码文件**——`mfixsolver` 的实际编译与运行交给用户本机
安装的 MFiX 作为背板执行。

## 交付契约（最高优先级，先读）

- **输出整体算例**：一次交付跑一个 MFiX 算例所需的**全部文件**（`project.mfx` 或 `mfix.dat` +
  按需的 `usr*.f` + `species.inc`/化学 + 几何 STL），外加三份总览
  `MANIFEST.md` / `ALGORITHM.md` / `TUNING.md`（模板见 `../_shared/OUTPUT_CONTRACT.md`）。
- **官方源码背板**：写 `usr_*.f`（自定义曳力/反应/物性/边界）前，必须照 `backplane/SOURCE_MAP.md`
  在 MFiX 官方 `model/` 源码里定位参考 subroutine，照其参数表/公共块(common/module)/调用约定写。
  背板机制见 `../_shared/BACKPLANE.md`，获取源码用 `backplane/fetch_sources.*`。
- **只生成、不代跑**：产出完整可编译/可读的文件即完成。

## 核心纪律（先读这段）

1. **先定求解模式**：气固两相有三条路线，选错整个算例作废——
   - **TFM**（Two-Fluid Model，欧拉-欧拉）：颗粒当拟流体，`SOLIDS_MODEL(1)='TFM'`。适合稠密、大规模、
     不关心单颗粒。需 `MMAX`、颗粒相物性、`KT_TYPE` 颗粒动理学。
   - **DEM**（离散元，欧拉-拉格朗日）：逐颗粒解牛顿方程，`DES_INTERP_ON`、`PARTICLES`。适合中等颗粒数、
     碰撞细节、非球/粘结。需 `particle_input.dat` 或自动生成。
   - **PIC**（MP-PIC / CGP 粗粒化）：包裹粒(parcel)统计，`SOLIDS_MODEL(1)='PIC'`。适合海量颗粒工业规模。
   详见 `reference/solids-models.md`。
2. **单位制默认 SI**（`UNITS='SI'`：kg, m, s, K, Pa）。别混 CGS。
3. **keyword 语法**：`KEYWORD = value`，字符串用引号，相/BC/IC 用**索引**：`BC_TYPE(1)`、`IC_EP_G(1)`、
   `SOLIDS_MODEL(1)`。索引从 **1** 开始。相 1 通常是气相在部分 keyword 里隐含，颗粒相从 1 或 2 起（看 keyword 定义）。
4. **BC/IC 必须覆盖所有区域与所有相**：每个 BC_ID 要给 `BC_TYPE` 及该类型必需的场（入口给速度/温度/组分，
   出口给压力）。每个 IC 区要给 `IC_EP_G`（空隙率）等。漏一个相/区域就报错或结果错。
5. **几何**：笛卡尔网格 `IMAX/JMAX/KMAX` + `XLENGTH/YLENGTH/ZLENGTH`；复杂几何用 `CARTESIAN_GRID=.TRUE.`
   + STL（cut-cell）。
6. **DT/TSTOP 与稳定性**：气固强耦合 DT 常需 1e-4~1e-3 s，自动步长 `DT_MAX`/`DT_MIN`。DEM 的
   `DES_MIN_DT` 由碰撞时间(Rayleigh/Hertz)定。

## 标准工作流

### A. 从零搭建算例
1. **问清工况**（一次问完给默认）：床型（鼓泡/喷动/输运/CFB）、求解模式(TFM/DEM/PIC)、
   几何尺寸与维度(2D/3D)、颗粒(直径 D_p、密度 RO_s、Geldart 类别)、气体(RO_g/MU_g)、
   入口表观气速 U_g、是否传热/化学反应、TSTOP。
2. **选骨架**：优先照官方 tutorial（`backplane/SOURCE_MAP.md`：fluidBed/spouted/CFB/hopper 等）。
3. **写 `project.mfx`（新格式）或 `mfix.dat`（旧格式）**：Run 控制 → 几何/网格 → 物理(气/固物性) →
   求解模式与曳力(`DRAG_TYPE`) → BC_ → IC_ → 数值(残差/迭代) → 输出(RES_DT/SPX/VTK)。
   逐段模板见 `templates/`。
4. **需要自定义**：曳力/反应/物性写 `usr*.f`（见 `reference/custom-fortran.md` + SOURCE_MAP）。
5. **写三份总览**（MANIFEST/ALGORITHM/TUNING）。
6. **自检**：BC/IC 覆盖全、相索引对、单位 SI、DT 合理；让用户 `build_mfixsolver` 后运行。

### B. 修改已有算例
读 `.mfx`/`.dat` 解析 RUN_TYPE/几何/相/BC/IC；只改相关 keyword，保持相索引与单位一致。

### C. 自定义 Fortran 源码植入
见 `reference/custom-fortran.md`：把官方 `model/usr*.f` 模板拷进算例目录改写，`build_mfixsolver`
会优先编译算例目录里的 `usr*.f` 覆盖默认实现。**写前必查 SOURCE_MAP 定位官方参考 subroutine**。

## 参考文件（按需读取）

- `../_shared/OUTPUT_CONTRACT.md` / `../_shared/BACKPLANE.md` — 交付契约与背板机制。
- `backplane/SOURCE_MAP.md` — MFiX 官方源码/教程指针（model/ 下的 usr 模板、drag、des、chem）。
- `reference/keywords.md` — mfix.dat/.mfx 全段 keyword 速查（Run/几何/物理/BC/IC/数值/输出）。
- `reference/solids-models.md` — TFM vs DEM vs PIC 选型、曳力模型 DRAG_TYPE、颗粒动理学 KT_TYPE。
- `reference/custom-fortran.md` — usr*.f 植入（usr_drag/usr_rates/usr_properties）+ build_mfixsolver。
- `reference/error-patterns.md` — 高频报错（BC 缺场/相索引/发散/负空隙率/DEM 颗粒重叠）与修法。

## 模板文件（可直接拷贝改数）

- `templates/fluidBed.mfx` — 2D 鼓泡流化床 TFM 完整输入卡（最常用起点）。
- `templates/dem_hopper.mfx` — DEM 料斗/颗粒床骨架。
- `templates/usr_drag.f` — 自定义曳力 Fortran 骨架（照官方 drag 接口）。
- `templates/overviews/` — MANIFEST/ALGORITHM/TUNING 填充范例。
