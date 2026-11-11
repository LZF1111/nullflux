# OpenFOAM 边界条件速查

规则：**每个 patch 的每个场都要独立写 `boundaryField` 条目**，不许合并；patch 名必须与
`constant/polyMesh/boundary` 里一致（多一个少一个都报错）。

## 不可压湍流绕流/内流（simpleFoam + kOmegaSST）

| 场 | inlet | outlet | wall（无滑移） | 说明 |
| --- | --- | --- | --- | --- |
| `U` | `fixedValue; value uniform (Ux Uy Uz);` | `inletOutlet; inletValue uniform (0 0 0); value $internalField;` 或 `zeroGradient` | `noSlip;` | 出口用 inletOutlet 防回流 |
| `p` | `zeroGradient;` | `fixedValue; value uniform 0;` | `zeroGradient;` | 不可压定压参考在出口 |
| `k` | `fixedValue; value uniform <k>;` | `inletOutlet; inletValue $internalField; value $internalField;` | `kqRWallFunction; value uniform <k>;` | |
| `omega` | `fixedValue; value uniform <omega>;` | `inletOutlet; ...` | `omegaWallFunction; value uniform <omega>;` | |
| `epsilon` | `fixedValue; value uniform <eps>;` | `inletOutlet; ...` | `epsilonWallFunction; value uniform <eps>;` | 用 kEpsilon 时 |
| `nut` | `calculated; value uniform 0;` | `calculated; value uniform 0;` | `nutkWallFunction; value uniform 0;` | 高 Re 壁面函数 |

低 Re 壁面（y+≈1，解析边界层）：`nut` 用 `nutLowReWallFunction`，`omega` 用 `omegaWallFunction`
（自动混合），别用高 Re 的 `nutkWallFunction`。

## 常见 BC 类型含义

- `fixedValue` — 固定值（Dirichlet）。
- `zeroGradient` — 零法向梯度（Neumann），出流/绝热壁常用。
- `inletOutlet` — 出口自适应：流出取零梯度，回流取 `inletValue`。防出口回流发散。
- `outletInlet` — 反之（入口可能倒流时）。
- `noSlip` — 壁面速度为 0（等价 `fixedValue (0 0 0)`）。
- `slip` — 自由滑移（对称面/理想壁）。
- `symmetry` / `symmetryPlane` — 对称边界（patch 类型也要在 boundary 里对应）。
- `empty` — 2D 算例的前后面（1 层网格），必须在 boundary 里 type empty。
- `cyclic` / `cyclicAMI` — 周期性 / 任意网格交界周期。
- `fixedFluxPressure` — 有重力/多相时压力壁面 BC（配合 p_rgh）。
- `totalPressure` / `pressureInletOutletVelocity` — 开放边界（大气）。
- `flowRateInletVelocity` — 给体积/质量流量而非速度：`massFlowRate` 或 `volumetricFlowRate`。
- `codedFixedValue` — 用户内联 C++ 表达式（如抛物线入口剖面）。

## 温度场 T（传热/浮力，buoyant* 求解器）

| patch | BC |
| --- | --- |
| inlet | `fixedValue; value uniform 300;` |
| outlet | `inletOutlet; inletValue $internalField; value $internalField;` |
| 热壁 | `fixedValue; value uniform 350;` 或 `externalWallHeatFluxTemperature` |
| 绝热壁 | `zeroGradient;` |

浮力算例用 `p_rgh`（不是 p）：壁面 `fixedFluxPressure;`，开放边界 `prghTotalHydrostaticPressure`
或 `prghPressure`。`p` 由求解器从 `p_rgh` 派生，通常 `calculated`。

## 多相 VOF（interFoam：alpha.water / U / p_rgh）

| 场 | inlet | atmosphere（开放顶） | wall |
| --- | --- | --- | --- |
| `alpha.water` | `fixedValue; value uniform 1;`（进液）或 0（进气） | `inletOutlet; inletValue uniform 0; value uniform 0;` | `zeroGradient;`（或 `constantAlphaContactAngle`） |
| `U` | `fixedValue;` 或 `flowRateInletVelocity` | `pressureInletOutletVelocity; value uniform (0 0 0);` | `noSlip;` |
| `p_rgh` | `fixedFluxPressure; value uniform 0;` | `totalPressure; p0 uniform 0;` | `fixedFluxPressure; value uniform 0;` |

多相/有液位算例**必须用 `setFields` 初始化 alpha**（见主 SKILL 与 setFieldsDict 模板），否则算白算。

## 2D 算例要点

- 网格 z 方向 1 层，前后两个面 patch 类型 `empty`。
- 所有场对该 empty patch 写 `type empty;`（无 value）。
- `blockMeshDict` 里 z 向 `(... 1 ...)` 只分 1 格。

## 入口湍流量数值（配合 dictionaries.md 的公式）

- 内流 I≈5%、外流 I≈1%；L≈0.07×水力直径（内流）或特征尺寸。
- `turbulentIntensityKineticEnergyInlet`（k 的 BC，直接给 I）与
  `turbulentMixingLengthDissipationRateInlet`（epsilon/omega）可让 OpenFOAM 自动算，省手算。
