# OpenFOAM 求解器选型

选错求解器 = 整个算例作废。先按物理类别定求解器，再据此定 `0/` 需要哪些场。

## 不可压单相

| 求解器 | 用途 | 必需场 |
| --- | --- | --- |
| `simpleFoam` | 稳态 RANS（绕流/内流最常用） | U, p, k, omega/epsilon, nut |
| `pimpleFoam` | 瞬态（大时间步，PIMPLE） | 同上 |
| `pisoFoam` | 瞬态（小 Courant，PISO） | 同上 |
| `icoFoam` | 层流瞬态（教学，无湍流） | U, p |
| `potentialFoam` | 势流初始化（给其它求解器打初场） | U, p |

## 可压 / 传热

| 求解器 | 用途 | 必需场 |
| --- | --- | --- |
| `rhoSimpleFoam` | 稳态可压 | U, p, T, rho, k, omega |
| `rhoPimpleFoam` | 瞬态可压 | 同上 |
| `buoyantSimpleFoam` | 稳态自然对流/浮力传热 | U, p_rgh, T, alphat, k, omega |
| `buoyantPimpleFoam` | 瞬态浮力传热 | 同上 |
| `chtMultiRegionFoam` | 固-流共轭传热（多区域） | 每区域独立场 |

可压/传热求解器用 `constant/thermophysicalProperties`（定义 mixture/transport/thermo/equationOfState），
而非 transportProperties。

## 多相

| 求解器 | 用途 | 关键 |
| --- | --- | --- |
| `interFoam` | 两相不可压 VOF（自由界面：溃坝/晃荡/液位） | alpha.water, U, p_rgh；需 setFields |
| `interIsoFoam` | isoAdvector 界面锐化 VOF | 同上 |
| `multiphaseInterFoam` | 多于两相 VOF | alpha.phase1/2/3... |
| `compressibleInterFoam` | 可压两相（含空化倾向） | + T |
| `twoPhaseEulerFoam` / `reactingTwoPhaseEulerFoam` | 欧拉双流体（鼓泡塔/流化床） | alpha.air, U.air, U.water, p, Theta... |
| `multiphaseEulerFoam` | 欧拉多流体 | 多相各自场 |
| `driftFluxFoam` | 沉降/絮凝混合物模型 | alpha, U, p_rgh |

多相求解器用 `constant/phaseProperties`（定义相、drag/lift/virtualMass 等相间力、界面模型）。

## 反应 / 燃烧

| 求解器 | 用途 |
| --- | --- |
| `reactingFoam` | 通用组分输运 + 化学反应（可压） |
| `chemFoam` | 单点化学（0D 反应器验证机理） |
| `fireFoam` | 火灾/湍流扩散燃烧 |
| `XiFoam` / `PDRFoam` | 预混燃烧 |

反应算例需 `constant/`：`thermophysicalProperties`、`chemistryProperties`、`combustionProperties`、
`reactions` + `thermo.compressibleGas`（机理文件）。

## 网格运动 / 多参考系

- `pimpleFoam` + `dynamicMeshDict`（AMI/overset）：旋转机械、搅拌桨瞬态。
- MRF（多参考系，稳态近似旋转）：`constant/MRFProperties` 定义旋转 cellZone + omega。搅拌釜稳态首选。
- `simpleFoam` + MRFProperties 即可做稳态搅拌釜（无需动网格）。

## 选型决策速记

```
可压缩? ──否──> 多相/自由界面? ──否──> 稳态? ──是──> simpleFoam
   │                  │                    └──否──> pimpleFoam/pisoFoam
   │                  └──是──> VOF(界面) ──> interFoam(+setFields)
   │                          Euler(弥散) ──> reactingTwoPhaseEulerFoam
   └──是──> 浮力主导? ──是──> buoyant{Simple,Pimple}Foam
                       └──否──> rho{Simple,Pimple}Foam
反应/燃烧 ──> reactingFoam / fireFoam
旋转机械 稳态 ──> simpleFoam + MRF ; 瞬态 ──> pimpleFoam + dynamicMesh(AMI)
```
