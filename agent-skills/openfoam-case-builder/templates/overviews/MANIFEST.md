# 算例文件总览: <案例名>

框架: OpenFOAM v2306
求解器: <simpleFoam | pimpleFoam | interFoam | buoyantSimpleFoam ...>
目标: <一句话：算什么、求什么量（如：Re=1e4 圆柱绕流稳态，求 Cd/Cl 与尾流结构）>

## 文件清单
| 文件 | 作用 | 关键字段 | 必需 |
| --- | --- | --- | --- |
| system/controlDict | 运行控制 | application, endTime, writeInterval | ✅ |
| system/fvSchemes | 离散格式 | ddt/div/laplacian schemes | ✅ |
| system/fvSolution | 线性求解+算法 | solvers, SIMPLE, relaxationFactors | ✅ |
| system/blockMeshDict | 结构网格 | vertices, blocks, boundary | ✅(或 snappy) |
| system/snappyHexMeshDict | 复杂几何网格 | geometry, castellated, snap, layers | 视几何 |
| system/surfaceFeatureExtractDict | 特征线 | includedAngle | 视 snappy |
| system/setFieldsDict | 初始场(多相/分层) | regions | 视物理 |
| system/decomposeParDict | 并行分解 | numberOfSubdomains | 并行时 |
| constant/transportProperties | 物性 | nu (或 physicalProperties) | ✅ |
| constant/turbulenceProperties | 湍流模型 | simulationType, RASModel | ✅ |
| constant/g | 重力 | value | 浮力/多相 |
| constant/phaseProperties | 相/相间力 | phases, drag, lift | 多相 |
| 0.orig/U | 速度场 | internalField, boundaryField | ✅ |
| 0.orig/p (或 p_rgh) | 压力场 | 每 patch BC | ✅ |
| 0.orig/k, omega/epsilon, nut | 湍流场 | 每 patch BC + 壁面函数 | RANS |
| 0.orig/T, alpha.* | 温度/相分数 | 每 patch BC | 传热/多相 |

## 目录结构树
```
<案例名>/
├── system/    (controlDict, fvSchemes, fvSolution, blockMeshDict, ...)
├── constant/  (transportProperties, turbulenceProperties, [g, phaseProperties])
└── 0.orig/    (U, p, k, omega, nut, [T, alpha.water])
```

## 使用顺序（用户在本机 OpenFOAM 执行，本 skill 不代跑）
```bash
cp -r 0.orig 0
blockMesh                 # 或 surfaceFeatureExtract && snappyHexMesh -overwrite
checkMesh
# setFields               # 多相/分层时
# decomposePar            # 并行时
<application>             # 如 simpleFoam ; 并行 mpirun -np N <application> -parallel
# reconstructPar          # 并行后
```
