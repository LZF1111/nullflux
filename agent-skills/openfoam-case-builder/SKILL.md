---
name: openfoam-case-builder
description: >-
  生成、修改与校验 OpenFOAM 仿真算例配置文件（同时兼容 Foundation 版 OpenFOAM-10 与 ESI 版
  v2406/v2306），以及自定义模型的编译脚手架 (wmake / Make/files / Make/options)。当用户要求：
  搭建 CFD 算例、编写或修改 system/constant/0 下的字典文件 (controlDict, fvSchemes, fvSolution,
  blockMeshDict, snappyHexMeshDict, transportProperties/physicalProperties,
  turbulenceProperties/momentumTransport, 边界条件)、把论文算法/边界条件植入 OpenFOAM、
  为绕流/内流/多相/传热/反应算例配置求解器、或编译自定义 dragModel/turbulence/fvOptions 时使用。
  只负责生成配置与编译脚手架；实际网格生成与求解由用户本机的 OpenFOAM 执行。
  输出整体算例文件 + 三份总览(文件/算法/调优)，写自定义算法源码时以本 skill 内置的两套官方源码为背板参照。
license: MIT
---

# OpenFOAM 算例配置与编译脚手架技能

你现在具备为 **OpenFOAM 双版本**生成算例配置文件与自定义算法源码的领域能力：
- **Foundation 版 OpenFOAM-10**（`.org`，经典 `simpleFoam`/`interFoam` 独立求解器）
- **ESI 版 OpenFOAM-v2406/v2306**（`.com`，与 v2306 同系）

两套**完整官方源码已内置**在 `backplane/vendor/OpenFOAM-10/` 与 `backplane/vendor/OpenFOAM-v2306/`
（各含 `applications/solvers/`、`src/`、`tutorials/`）。生成任何字典/模型前先去 `backplane/SOURCE_MAP.md`
查对应版本的真实源码路径，`read_file` 打开对齐，**禁止凭记忆猜键名/API**。本技能**只产出完整代码文件**——
`blockMesh` / `snappyHexMesh` / 求解器 / `wmake` 的实际运行交给用户本机的 OpenFOAM 执行。

> **版本选择**：用户未指定时先问“基金会版(10) 还是 ESI 版(v2406)?”，默认 ESI v2406。两版字典键有差异
> （见 SOURCE_MAP 的版本差异对照表），选定后全程一致，并在 MANIFEST.md 顶部写明目标版本。

## 交付契约（最高优先级，先读）

- **输出整体算例**：一次交付该算例所需的**全部文件**（system/ + constant/ + 0.orig/ 一个不缺），
  外加三份总览 `MANIFEST.md`（文件总览）、`ALGORITHM.md`（算法总览）、`TUNING.md`（问题与调优）。
  详见 `../_shared/OUTPUT_CONTRACT.md`。
- **官方源码背板**：写自定义模型/求解器时，必须先照 `backplane/SOURCE_MAP.md` 在官方源码里定位参考实现，
  照其类结构/注册宏/接口写，禁止杜撰 API。背板机制见 `../_shared/BACKPLANE.md`，获取源码用
  `backplane/fetch_sources.*`。
- **只生成、不代跑**：产出完整可编译/可读的文件即完成；是否跑通由用户在 OpenFOAM 上验证。

## 核心纪律（先读这段）

1. **不要凭记忆手写复杂字典**（尤其 `snappyHexMeshDict` 的 `addLayersControls`、`fvSolution`）。
   优先以 `backplane/vendor/<版本>/tutorials/` 里最贴近的官方算例为骨架，整套拷贝其 system/constant/0.orig
   再改数值。v2306 起字段检查更严，少一个 int/scalar 就 `FOAM exiting`。
   ★两版字典有差异：湍流字典 OF-10 用 `constant/momentumTransport`、ESI 用 `constant/turbulenceProperties`；
   粘度字典 OF-10 用 `physicalProperties`、ESI 用 `transportProperties`。按目标版本对齐（见 SOURCE_MAP）。
2. **一个 case = 三个目录**：`system/`（离散与控制）、`constant/`（物性/湍流/网格）、`0/`（初始与边界场）。
   缺一不可。判定一个目录是不是 case：看有没有 `system/controlDict`。
3. **永远先建 `0.orig/`，再 `cp -r 0.orig 0`**，绝不直接编辑 `0/`。求解器/`setFields` 跑过后
   `0/` 已不是初始场。重跑只需 `rm -rf 0 && cp -r 0.orig 0`。
4. **量纲必须对**（写错必崩）：`k` 是 `[0 2 -2 0 0 0 0]`，`epsilon` 是 `[0 2 -3 0 0 0 0]`，
   `omega` 是 `[0 0 -1 0 0 0 0]`，`nu` 是 `[0 2 -1 0 0 0 0]`，`p`(不可压) 是 `[0 2 -2 0 0 0 0]`
   （运动学压力 p/ρ），`T` 是 `[0 0 0 1 0 0 0]`。详见 `reference/dictionaries.md`。
5. **每个 patch 的每个场都要独立写边界条件**，不许合并。inlet/outlet/walls 各字段类型见
   `reference/boundary-conditions.md`。
6. **论文植入**：任何来自论文的 BC/IC/常数/几何/时间步，先核对单位与量纲（cm/s vs m/s、mm vs m、
   K vs °C、bar vs Pa），有歧义就问用户，别自作主张猜值。

## 标准工作流

### A. 从零搭建标准算例
1. **问清工况**（一次问完，给编号默认值）：流动类型（外流绕物/内流/自然对流/多相）、
   主流方向、Re 或来流速度、求解器、湍流模型、网格细度、是否要边界层。
2. **选骨架**：优先克隆官方同类 tutorial（绕物=motorBike；内流=pitzDaily；混合罐=mixerVessel；
   自由界面=damBreak；自然对流=hotRoom/buoyant*）。无 tutorial 时用 `templates/` 里的骨架。
3. **填 `system/`**：`controlDict`（application/时间/写出）、`fvSchemes`（离散格式）、
   `fvSolution`（线性求解器+松弛/算法控制）。
4. **填 `constant/`**：`transportProperties` 或 `physicalProperties`（物性）、
   `turbulenceProperties`（RAS/LES/laminar）、`g`（有浮力时）、多相的 `phaseProperties`。
5. **填 `0.orig/`**：每个场（U/p/k/omega 或 epsilon/nut/T/alpha.*）的 `internalField` +
   每个 patch 的 `boundaryField`。然后 `cp -r 0.orig 0`。
6. **网格**：写 `blockMeshDict`（结构网格）或 `snappyHexMeshDict`（复杂几何，需 STL）+
   `surfaceFeatureExtractDict`。
7. **写三份总览**：按 `../_shared/OUTPUT_CONTRACT.md` 生成 `MANIFEST.md` / `ALGORITHM.md` / `TUNING.md`。
8. **自检**：列出每个场每个 patch 的 BC 类型对一遍；量纲逐个核。让用户跑 `blockMesh` →
   `checkMesh` → 求解器验证。

### B. 修改已有算例
1. 让用户/agent 递归列出 case 文件，读 `controlDict` 定位求解器与时间设置。
2. 只改与需求直接相关的字段，改前一句话说明意图。
3. 改 BC 一律改 `0.orig/`，再 `rm -rf 0 && cp -r 0.orig 0`。

### C. 论文算法植入 / 自定义模型编译
见 `reference/custom-model-compile.md`：新增 `Foo.H`/`Foo.C` + `Make/files` + `Make/options`，
用 `wmake libso` 编译，再在 `constant/` 字典里选用该模型。核对论文参数三遍（全文扫读→关键页图核对→
量纲合理性）后再落地。**写 .C 前必查 `backplane/SOURCE_MAP.md`**，在官方源码里打开最接近的现成模型
（如 SchillerNaumann/kOmegaSST），照其类继承 + `addToRunTimeSelectionTable` 宏 + 虚函数签名写。

## 参考文件（按需读取）

- `../_shared/OUTPUT_CONTRACT.md` — 交付契约与三份总览模板（MANIFEST/ALGORITHM/TUNING）。
- `../_shared/BACKPLANE.md` — 官方源码背板机制与使用流程。
- `backplane/SOURCE_MAP.md` — OpenFOAM 官方源码/教程指针：每类生成任务参照哪个文件/类/教程。
- `reference/dictionaries.md` — system/constant 各字典字段、量纲表、常用离散格式与线性求解器组合。
- `reference/boundary-conditions.md` — inlet/outlet/wall/atmosphere 各场的 BC 类型速查（含壁面函数）。
- `reference/solvers.md` — 常见求解器选型（simpleFoam/pimpleFoam/interFoam/buoyant*/reacting* 等）与匹配的场。
- `reference/custom-model-compile.md` — wmake 编译脚手架 + runTimeSelection 注册 + 论文植入流程。
- `reference/error-patterns.md` — 高频报错模式与修法（缺字典/BC 不识别/求解发散/网格负体积等）。

## 模板文件（可直接拷贝改数）

- `templates/system/{controlDict,fvSchemes,fvSolution,blockMeshDict}` — 不可压稳态骨架。
- `templates/constant/{transportProperties,turbulenceProperties}` — 单相水 + kOmegaSST。
- `templates/0.orig/{U,p,k,omega,nut}` — 绕流/内流通用初始场骨架，改 patch 名与数值即用。
