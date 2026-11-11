# LBM 格子模型 (lattice schemes)

所有 LBM 求解器的第一件事：选定离散速度集 $\{\mathbf{c}_i\}$、对应权重 $\{w_i\}$、声速 $c_s$。
它们必须**成套使用**，权重和恒为 1，$\sum_i w_i=1$。声速统一 $c_s^2=1/3$（Δx=Δt=1）。

## D2Q9（二维首选）
9 个速度（含静止 0）。权重：
| i | c_i (cx,cy) | w_i |
| --- | --- | --- |
| 0 | (0,0) | 4/9 |
| 1–4 | (±1,0),(0,±1) | 1/9 each |
| 5–8 | (±1,±1) | 1/36 each |

- $c_s^2=1/3$。opposite（反弹用）：0↔0, 1↔3, 2↔4, 5↔7, 6↔8（须按你的索引顺序建表）。
- 常用索引顺序（本 skill 模板采用）：
  `c = [(0,0),(1,0),(0,1),(-1,0),(0,-1),(1,1),(-1,1),(-1,-1),(1,-1)]`
  → opposite `= [0,3,4,1,2,7,8,5,6]`，权重 `w=[4/9, 1/9,1/9,1/9,1/9, 1/36,1/36,1/36,1/36]`。

## D3Q19（三维性价比首选）
19 个速度：1 静止 + 6 面心(±1 沿一轴) + 12 棱心(±1,±1 两轴)。
| 类 | c_i | w_i |
| --- | --- | --- |
| 静止 | (0,0,0) | 1/3 |
| 面心(6) | (±1,0,0)… | 1/18 each |
| 棱心(12) | (±1,±1,0)… | 1/36 each |

- $c_s^2=1/3$。适合中低 Re 的一般 3D 流动，内存/速度平衡好。

## D3Q27（三维高精度）
27 个速度：D3Q19 + 8 体对角(±1,±1,±1)。
| 类 | c_i | w_i |
| --- | --- | --- |
| 静止 | (0,0,0) | 8/27 |
| 面心(6) | (±1,0,0)… | 2/27 each |
| 棱心(12) | (±1,±1,0)… | 1/54 each |
| 角(8) | (±1,±1,±1) | 1/216 each |

- 各向同性更好，高 Re/湍流/复杂几何优先；成本高于 D3Q19。

## 平衡分布（所有格子通用）
$$f_i^{eq}=w_i\,\rho\left[1+\frac{\mathbf{c}_i\cdot\mathbf{u}}{c_s^2}
+\frac{(\mathbf{c}_i\cdot\mathbf{u})^2}{2c_s^4}-\frac{\mathbf{u}\cdot\mathbf{u}}{2c_s^2}\right]$$
代入 $c_s^2=1/3$：$3(\mathbf{c}_i\cdot\mathbf{u})+4.5(\mathbf{c}_i\cdot\mathbf{u})^2-1.5\,\mathbf{u}^2$。

## 宏观量
$$\rho=\sum_i f_i,\qquad \rho\mathbf{u}=\sum_i \mathbf{c}_i f_i\;(+\tfrac{1}{2}\mathbf{F}\text{，若有体力})$$

## 官方背板参照
- Palabos: `src/latticeBoltzmann/nearestNeighborLattices2D/3D.h`（D2Q9/D3Q19/D3Q27 描述符、权重、c_s）
- OpenLB: `src/dynamics/latticeDescriptors.h`
