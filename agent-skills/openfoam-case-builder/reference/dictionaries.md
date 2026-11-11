# OpenFOAM 字典字段速查 (v2306)

## 目录约定

| 目录 | 内容 |
| --- | --- |
| `system/` | `controlDict`（运行控制）、`fvSchemes`（离散格式）、`fvSolution`（线性求解器+算法）、`blockMeshDict`、`snappyHexMeshDict`、`surfaceFeatureExtractDict`、`setFieldsDict`、`decomposeParDict`、`fvOptions` |
| `constant/` | `transportProperties` / `physicalProperties`（物性）、`turbulenceProperties`、`g`（重力）、`phaseProperties`（多相）、`thermophysicalProperties`（可压/反应）、`polyMesh/`（网格，由 blockMesh 生成） |
| `0/` 与 `0.orig/` | 每个场的初始值 + 边界条件：`U`、`p`（或 `p_rgh`）、`k`、`epsilon`/`omega`、`nut`、`T`、`alpha.*` 等 |

判定一个目录是不是 case：存在 `system/controlDict`。

## 文件头（所有字典必须有 FoamFile 块）

```c++
/*--------------------------------*- C++ -*----------------------------------*\
| OpenFOAM 字典文件                                                            |
\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;   // volVectorField / volScalarField（场文件用）
    object      controlDict;  // 与文件名一致
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
```

场文件（0/ 下）的 `class` 用 `volScalarField`（p/k/T/alpha）或 `volVectorField`（U）。

## 量纲 dimensions（[kg m s K mol A cd]，写错必崩）

| 场 | dimensions | 说明 |
| --- | --- | --- |
| `U` | `[0 1 -1 0 0 0 0]` | 速度 m/s |
| `p`（不可压） | `[0 2 -2 0 0 0 0]` | 运动学压力 p/ρ，单位 m²/s² |
| `p`（可压/rho*） | `[1 -1 -2 0 0 0 0]` | 真实压力 Pa |
| `p_rgh` | 同上对应 | 减去静水压的压力 |
| `k` | `[0 2 -2 0 0 0 0]` | 湍动能 m²/s² |
| `epsilon` | `[0 2 -3 0 0 0 0]` | 耗散率 m²/s³ |
| `omega` | `[0 0 -1 0 0 0 0]` | 比耗散率 1/s |
| `nut` / `nu` | `[0 2 -1 0 0 0 0]` | 运动粘度 m²/s |
| `nuTilda` | `[0 2 -1 0 0 0 0]` | S-A 模型 |
| `T` | `[0 0 0 1 0 0 0]` | 温度 K |
| `alpha.*` | `[0 0 0 0 0 0 0]` | 相体积分数，无量纲 |

## system/controlDict 关键项

```c++
application     simpleFoam;      // 求解器名，与实际运行一致
startFrom       startTime;       // latestTime 可续算
startTime       0;
stopAt          endTime;
endTime         1000;            // 稳态=迭代步数；瞬态=物理秒
deltaT          1;               // 稳态=1；瞬态按 CFL 定
writeControl    timeStep;        // 或 runTime / adjustableRunTime
writeInterval   100;
purgeWrite      0;               // >0 只保留最近 N 个时间目录
writeFormat     ascii;
writePrecision  8;
runTimeModifiable true;
// 瞬态自适应时间步：
adjustTimeStep  yes;             // 仅 PIMPLE 类
maxCo           1;               // 最大 Courant 数
maxDeltaT       0.01;
// functionObjects（后处理，可选）：forceCoeffs / fieldAverage / probes / residuals
```

## system/fvSchemes 常用组合

```c++
ddtSchemes      { default steadyState; }        // 瞬态用 Euler / backward / CrankNicolson 0.9
gradSchemes     { default Gauss linear; }
divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwindV grad(U);  // 稳态 RANS 稳健选择
    div(phi,k)      bounded Gauss upwind;
    div(phi,omega)  bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes   { default corrected; }
```

- 追求精度且网格好：`Gauss linear`（二阶中心，可能振荡）。
- 稳健优先：`upwind`（一阶，耗散大）或 `linearUpwind`（二阶迎风）。
- VOF 界面（alpha）：`div(phi,alpha) Gauss vanLeer;` + `div(phirb,alpha) Gauss linear;`。
- 非正交网格差：`snGradSchemes` 用 `limited 0.5` 或 `corrected`。

## system/fvSolution

```c++
solvers
{
    p               // 压力用 GAMG 或 PCG
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-06;
        relTol          0.1;      // 稳态可放宽到 0.05~0.1，瞬态最后一步 relTol 0
    }
    "(U|k|omega|epsilon)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-08;
        relTol          0.1;
    }
}

SIMPLE            // 稳态用 SIMPLE；瞬态用 PIMPLE
{
    nNonOrthogonalCorrectors 1;
    consistent      yes;          // SIMPLEC，收敛更快
    residualControl { p 1e-4; U 1e-4; "(k|omega)" 1e-4; }
}
relaxationFactors // 稳态需要松弛；consistent yes 时 p 可设 1
{
    fields  { p 0.7; }
    equations { U 0.7; "(k|omega|epsilon)" 0.7; }
}
// 瞬态 PIMPLE：
// PIMPLE { nOuterCorrectors 2; nCorrectors 2; nNonOrthogonalCorrectors 1; }
```

## constant/transportProperties（不可压单相）

```c++
transportModel  Newtonian;
nu              [0 2 -1 0 0 0 0] 1e-06;   // 水 ~1e-6, 空气 ~1.5e-5
```

## constant/turbulenceProperties

```c++
simulationType  RAS;              // RAS / LES / laminar
RAS
{
    RASModel        kOmegaSST;    // kEpsilon / kOmegaSST / SpalartAllmaras / realizableKE
    turbulence      on;
    printCoeffs     on;
}
```

## constant/g（有浮力/多相时）

```c++
FoamFile { class uniformDimensionedVectorField; object g; }
dimensions      [0 1 -2 0 0 0 0];
value           (0 0 -9.81);
```

## 网格入口估算（湍流场初值）

- `k = 1.5*(I*U)²`，I 为湍流强度（内流 ~5%，外流 ~1%）。
- `epsilon = C_mu^0.75 * k^1.5 / L`，`C_mu=0.09`，L 为特征长度（≈0.07×水力直径）。
- `omega = k^0.5 / (C_mu^0.25 * L)` 或 `omega = epsilon/(C_mu*k)`。
- `nut` 初值可给 0 或按 `nut = C_mu * k² / epsilon`。
