# 算法总览: <案例名>

## 控制方程（TFM 两流体示例，按模式改）
气相/固相各自的连续性与动量方程（相 g 与 s，空隙率 $\varepsilon_g+\varepsilon_s=1$）：
$$\begin{aligned}
\frac{\partial(\varepsilon_g\rho_g)}{\partial t} + \nabla\cdot(\varepsilon_g\rho_g\mathbf{u}_g) &= 0 \\
\frac{\partial(\varepsilon_g\rho_g\mathbf{u}_g)}{\partial t} + \nabla\cdot(\varepsilon_g\rho_g\mathbf{u}_g\mathbf{u}_g)
&= -\varepsilon_g\nabla p + \nabla\cdot\boldsymbol{\tau}_g + \varepsilon_g\rho_g\mathbf{g} - \beta(\mathbf{u}_g-\mathbf{u}_s)
\end{aligned}$$
固相动量含颗粒相应力（由颗粒动理学 KTGF 闭合）与相间曳力 $\beta$。
- DEM：固相改为逐颗粒牛顿方程 $m_i\dot{\mathbf{v}}_i=\sum \mathbf{F}_{contact}+\mathbf{F}_{drag}+m_i\mathbf{g}$。
- PIC：parcel 统计 + 固相应力经验闭合。

## 数值方法
- 压力-速度耦合：SIMPLE 类（MFiX 内部）。
- 离散：`DISCRETIZE` 起步一阶迎风(2)，可升 Superbee/SMART。
- 时间推进：自适应 DT（DT_MIN/DT_MAX），气固强耦合。
- 曳力闭合：`DRAG_TYPE`（GIDASPOW_BLEND 等）。
- 颗粒动理学：`KT_TYPE`；摩擦应力 `FRICTION`。

## 公式 → 代码映射（自定义 usr*.f 时填）
| 理论 | 代码位置 | 参照官方源码 |
| --- | --- | --- |
| $\beta = \frac{3}{4}C_d\frac{\varepsilon_s\varepsilon_g\rho_g|u_g-u_s|}{d_p}\varepsilon_g^{-2.65}$ | usr_drag.f: DRAG_USR | vendor/MFiX/model/usr_drag.f + drag_gs.f |

## 参数与常数
| 量 | 值 | 来源 |
| --- | --- | --- |
| $d_p$ | 5e-4 m | 颗粒直径 |
| $\rho_s$ | 2500 kg/m³ | 砂 |
| $\varepsilon_{*}$ (EP_STAR) | 0.42 | 最大堆积 |
| U_mf | <估算> | Wen-Yu/Ergun |

## 官方源码背板依据
- tutorial: `vendor/MFiX/tutorials/tfm/fluid_bed_2d`
- （植入时）`vendor/MFiX/model/usr_drag.f`
