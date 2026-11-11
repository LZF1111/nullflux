# LBM 边界条件 (boundary conditions)

边界的本质：streaming 后，边界格点上**指向域内的分布 $f_i$ 未知**，需按边界类型补全。
每种 BC 必须明确它更新的是哪些方向的 $f_i$。

## Bounce-back（固壁，无滑移）
最常用、最鲁棒。壁面把入射分布原路反弹。
- **全程 (full-way)**：碰撞后把每个 $f_i$ 换到反向 $f_{\bar i}$；壁面落在格点上，一阶精度。
- **半程 (half-way)**：streaming 时，指向壁的分布反射回来 $f_{\bar i}(\mathbf{x},t+1)=f_i^*(\mathbf{x},t)$；
  **壁面落在格点与邻点中间半格处，二阶精度**，工程首选。
- 运动壁（如顶盖）加动量修正：$f_{\bar i}=f_i^*-2w_i\rho\frac{\mathbf{c}_i\cdot\mathbf{u}_w}{c_s^2}$。
- 依赖正确的 **opposite 表**（见 lattice-schemes.md）。

## Zou-He（速度/压力 Dirichlet 入口出口）
已知边界速度（或密度），解出未知分布 + 满足动量。以 D2Q9 左边界给定 $u$ 为例：
1. 由已知分布求 $\rho=\frac{1}{1-u_x}\left[f_0+f_2+f_4+2(f_3+f_6+f_7)\right]$。
2. 未知 $f_1,f_5,f_8$ 由密度/动量约束 + 非平衡 bounce-back 假设解析给出。
- 精确但公式随边（左右上下）与格子而变，实现照官方类，别手抄错分量。

## 非平衡外推 (Guo non-equilibrium extrapolation)
边界点分布 = 平衡部分（用边界宏观量）+ 非平衡部分（从邻近内点外推）：
$$f_i(\mathbf{x}_b)=f_i^{eq}(\rho_b,\mathbf{u}_b)+\big[f_i(\mathbf{x}_{in})-f_i^{eq}(\rho_{in},\mathbf{u}_{in})\big]$$
- 比 Zou-He 更通用（各边同一套），二阶，稳定，弯曲边界也好用。

## 周期边界
域一侧流出的分布直接进另一侧（数组环绕 / np.roll）。无需额外处理，最简单。

## 出口 (outflow)
- **对流出流**：$\partial_t\phi+U\partial_n\phi=0$ 离散更新边界分布，反射小。
- **零梯度外推**：$f_i(\text{out})=f_i(\text{inner})$，简单但有反射。
- 压力出口：Zou-He 给定 $\rho_{out}$（=已知压力）。

## 弯曲/浸没边界
- 插值 bounce-back（Bouzidi / Filippova-Hänel）：按壁面到格点的分数距离 $q$ 插值，精确表示曲面。
- IB-LBM（浸没边界）：拉格朗日点施加力，适合运动/柔性边界。

## 官方背板参照
- Palabos: `src/boundaryCondition/`（`ZouHeDynamics`, `boundaryCondition2D/3D`, 反弹在 `bounceBackDynamics`）
- OpenLB: `src/boundary/`（`setBounceBackBoundary`, `setLocalVelocityBoundary`(Zou-He), `setInterpolatedVelocityBoundary`）
