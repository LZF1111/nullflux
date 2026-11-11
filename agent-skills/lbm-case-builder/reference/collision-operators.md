# LBM 碰撞算子 (collision operators)

碰撞把分布拉向平衡。选型决定稳定性与精度。

## 选型速查
| 算子 | 松弛数 | 稳定性 | 精度/边界 | 成本 | 何时用 |
| --- | --- | --- | --- | --- | --- |
| BGK (SRT) | 1 (τ) | 差(近 τ=0.5 失稳) | 一般 | 最低 | 低 Re、快速验证、教学 |
| TRT | 2 (τ+, τ-) | 中 | 壁面位置更准 | 低 | 多孔介质、要精确壁面 |
| MRT | ~q 个 | 好 | 好 | 中 | 中高 Re、工程通用推荐 |
| Cumulant | 多 | 很好 | 很好 | 中高 | 高 Re、湍流 |
| Regularized (RLBM) | 1 | 好 | 好 | 低-中 | 高 Re 且想保持简单 |

## BGK（单松弛）
$$f_i^*=f_i-\frac{1}{\tau}\left(f_i-f_i^{eq}\right),\qquad \tau=3\nu_{lb}+0.5,\quad \nu_{lb}=c_s^2(\tau-0.5)$$
- τ 必须 > 0.5；越接近 0.5（高 Re）越易失稳。
- 加体力（Guo forcing）：
  $F_i=w_i\left(1-\frac{1}{2\tau}\right)\left[\frac{\mathbf{c}_i-\mathbf{u}}{c_s^2}
  +\frac{(\mathbf{c}_i\cdot\mathbf{u})}{c_s^4}\mathbf{c}_i\right]\cdot\mathbf{F}$，
  且宏观速度用 $\rho\mathbf{u}=\sum_i\mathbf{c}_if_i+\frac{1}{2}\mathbf{F}$。

## TRT（双松弛）
把 $f_i$ 分对称/反对称部分：$f_i^\pm=\tfrac12(f_i\pm f_{\bar i})$，同理 $f_i^{eq\pm}$。
$$f_i^*=f_i-\frac{1}{\tau^+}(f_i^+-f_i^{eq+})-\frac{1}{\tau^-}(f_i^--f_i^{eq-})$$
- $\tau^+$ 定黏度（$\nu=c_s^2(\tau^+-0.5)$），$\tau^-$ 由"磁数" $\Lambda=(\tau^+-0.5)(\tau^--0.5)$
  自由选，$\Lambda=1/4$ 令 bounce-back 壁面恰在半格、最稳最准。

## MRT（多松弛）
在**矩空间**松弛：$\mathbf{m}=M\mathbf{f}$，$\mathbf{m}^{eq}=M\mathbf{f}^{eq}$，
$$\mathbf{f}^*=\mathbf{f}-M^{-1}S\,(\mathbf{m}-\mathbf{m}^{eq})$$
- $M$：把分布映到矩（密度、能量、动量、应力…）的变换矩阵（D2Q9 为 9×9，见 d'Humières）。
- $S=\mathrm{diag}(s_0,\dots)$：各矩独立松弛率；与黏度相关的 $s_\nu=1/\tau$，其余可调稳定性。
- 实现照官方矩阵，别手推错。

## Cumulant / Regularized
- Cumulant：在累积量空间松弛，高阶累积量独立控制，高 Re 稳定性最佳（Geier 2015）。
- Regularized：碰撞前把非平衡部分投影回二阶 Hermite 空间，滤掉高阶噪声，简单又稳。

## 官方背板参照
- Palabos: `src/basicDynamics/isoThermalDynamics.h`（`BGKdynamics`, `RegularizedBGKdynamics`）、
  `src/complexDynamics/mrtDynamics.h`（`MRTdynamics` 及矩阵）
- OpenLB: `src/dynamics/dynamics.h`（`BGKdynamics`）、`src/dynamics/mrtDynamics.h`、`mrtLatticeDescriptors.h`
