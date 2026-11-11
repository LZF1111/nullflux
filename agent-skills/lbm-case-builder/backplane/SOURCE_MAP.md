# LBM 官方源码背板映射 (SOURCE_MAP)

写核心算法前，先在此表定位官方参考实现，照其**公式/权重/矩阵/常数**写，别手推。
LBM 无统一框架 → 以 **Palabos**（C++，ESI 官方）与 **OpenLB**（C++，官方）为权威背板；
自研 Python 也应对齐它们的公式与常数。

获取源码：`backplane/fetch_sources.sh|ps1`（clone 或 link 本机安装）→ 落到 `backplane/vendor/`。

## 生成任务 → 官方源码

### 格子描述符（权重 / 速度集 / 声速）
| 任务 | Palabos | OpenLB |
| --- | --- | --- |
| D2Q9/D3Q19/D3Q27 权重与 c_i | `src/latticeBoltzmann/nearestNeighborLattices2D.h`, `nearestNeighborLattices3D.h` | `src/dynamics/latticeDescriptors.h` |

### 碰撞算子
| 任务 | Palabos | OpenLB |
| --- | --- | --- |
| BGK | `src/basicDynamics/isoThermalDynamics.h` → `BGKdynamics` | `src/dynamics/dynamics.h` → `BGKdynamics` |
| Regularized BGK | `isoThermalDynamics.h` → `RegularizedBGKdynamics` | `src/dynamics/dynamics.h` |
| MRT (变换矩阵 M、松弛谱 S) | `src/complexDynamics/mrtDynamics.h`, `mrtTemplates.h` | `src/dynamics/mrtDynamics.h`, `mrtLatticeDescriptors.h` |
| 平衡分布 feq 模板 | `src/latticeBoltzmann/dynamicsTemplates.h` | `src/dynamics/lbHelpers.h` |
| 外力 (Guo forcing) | `src/basicDynamics/externalForceDynamics.h` | `src/dynamics/forcedBGKdynamics.h` |

### 边界条件
| 任务 | Palabos | OpenLB |
| --- | --- | --- |
| bounce-back | `src/basicDynamics/bounceBackModels.h` | `src/boundary/setBounceBackBoundary.h` |
| Zou-He 速度/压力 | `src/boundaryCondition/zouHeDynamics.h`, `zouHeBoundary2D/3D.h` | `src/boundary/setLocalVelocityBoundary.h` |
| 非平衡外推/插值 | `src/boundaryCondition/boundaryCondition2D/3D.h` | `src/boundary/setInterpolatedVelocityBoundary.h` |
| 曲面插值 bounce-back | `src/offLattice/`（Bouzidi） | `src/boundary/setBouzidiBoundary.h` |

### 多物理扩展
| 任务 | Palabos | OpenLB |
| --- | --- | --- |
| 热 LBM (DDF 温度) | `src/multiPhysics/` (advectionDiffusion) | `src/dynamics/advectionDiffusionDynamics.h` |
| 多相 Shan-Chen | `src/multiPhysics/shanChenLattices*.h` | `src/dynamics/interactionPotential.h` |
| 自由能多相 | `src/multiPhysics/freeEnergy*` | — |

### 完整可跑例子（学结构 / 直接改）
| 案例 | Palabos | OpenLB |
| --- | --- | --- |
| 顶盖方腔 | `examples/showCases/cavity2d` | `examples/laminar/cavity2d` |
| 圆柱绕流 | `examples/showCases/cylinder2d` | `examples/laminar/cylinder2d` |
| 多相(RT不稳定) | `examples/showCases/rayleighTaylor` | `examples/multiComponent/` |

## 权威文档
- Krüger et al., *The Lattice Boltzmann Method: Principles and Practice*（公式基准）
- Palabos User Guide: https://palabos.unige.ch
- OpenLB User Guide: https://www.openlb.net

## vendor/ 状态
- 若 `vendor/` 为空：说明**未接入官方源码背板**，在 ALGORITHM.md 标注 `⚠ 未接入官方源码背板`，
  公式回退到本 reference/ + Krüger 教材，并提示用户运行 fetch_sources 接入。
