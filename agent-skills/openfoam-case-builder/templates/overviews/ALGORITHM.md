# 算法总览: <案例名>

## 控制方程
不可压 RANS（示例，按实际改）：
$$\begin{aligned}
\nabla \cdot \mathbf{u} &= 0 \\
\frac{\partial \mathbf{u}}{\partial t} + (\mathbf{u}\cdot\nabla)\mathbf{u}
&= -\frac{1}{\rho}\nabla p + \nabla\cdot\big[(\nu+\nu_t)(\nabla\mathbf{u}+\nabla\mathbf{u}^T)\big]
\end{aligned}$$

湍流闭合（k-ω SST 示例）：$\nu_t = a_1 k / \max(a_1\omega, S F_2)$，并求解 $k$、$\omega$ 输运方程。

## 数值方法
- 时间推进：稳态 `steadyState`（SIMPLE/SIMPLEC 压力-速度耦合）；瞬态用 PIMPLE。
- 空间离散：对流 `bounded Gauss linearUpwind`（二阶迎风，稳健）；扩散 `Gauss linear corrected`。
- 线性求解：p 用 GAMG，U/k/omega 用 smoothSolver。
- 松弛：SIMPLEC (`consistent yes`) 或 U 0.7 / p 0.3。

## 公式 → 代码映射（仅自定义算法植入时填）
| 理论公式 | 代码位置 | 参照的官方源码 |
| --- | --- | --- |
| $C_d Re = 24(1+0.15Re^{0.687})$ | Foo.C: `CdRe()` | src/.../dragModels/SchillerNaumann/SchillerNaumann.C |

## 参数与常数
| 量 | 值 | 来源 |
| --- | --- | --- |
| $\nu$ | 1e-6 m²/s | 水 20°C |
| Re | <值> | $Re=UL/\nu$ |
| 入口 $k$ | $1.5(IU)^2$ | I=5% |

## 官方源码背板依据
- 教程骨架: `vendor/OpenFOAM/tutorials/incompressible/simpleFoam/pitzDaily`
- （植入时）参照模型: `vendor/OpenFOAM/src/.../SchillerNaumann/`
