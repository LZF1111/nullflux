# 算法总览: <案例名>

## 物理模型
- 运动方程：牛顿力学 $m_i\ddot{\mathbf{r}}_i=-\nabla_i U(\{\mathbf{r}\})$，速度 Verlet 积分。
- 势函数 $U$：<LJ / EAM 嵌入原子 / Tersoff 键序 / ReaxFF 反应力场>
  - EAM：$U=\sum_i F_i(\bar\rho_i)+\tfrac12\sum_{i\ne j}\phi_{ij}(r_{ij})$，$\bar\rho_i=\sum_{j}\rho_j(r_{ij})$。
  - ReaxFF：键序 BO 依赖的多体项 + 电荷平衡（QEq），允许成键/断键。
- 系综：<NVE / NVT(Nosé-Hoover) / NPT>，控温 $T$、控压 $P$。

## 数值设置
| 项 | 值 | 依据 |
| --- | --- | --- |
| units | <lj/real/metal> | 与 pair_style 匹配 |
| timestep | <0.001/1.0/0.25 fs> | ReaxFF≤0.25fs, real 1fs, metal 1-2fs |
| Tdamp / Pdamp | <100×dt / 1000×dt> | Nosé-Hoover 阻尼 |
| neighbor / neigh_modify | <skin, every/delay> | 邻居表 |
| minimize | 1e-4 1e-6 1000 10000 | 消初始重叠 |

## 公式 → 命令映射
| 理论 | LAMMPS 命令 | 参照官方源码 |
| --- | --- | --- |
| 势函数 | `pair_style <...>` + `pair_coeff` | vendor/lammps-official/doc/src/pair_<...>.rst + src/.../pair_<...>.cpp |
| 系综积分 | `fix nvt/npt temp ...` | doc/src/fix_nh.rst + src/fix_nh.cpp |
| 电荷平衡(ReaxFF) | `fix qeq/reaxff` | doc/src/fix_qeq_reaxff.rst |

## 元素 → atom type 映射（关键，错位=参数用错）
| type | 元素 | 来源 |
| --- | --- | --- |
| 1 | <C> | pair_coeff 里第 1 个元素 |
| 2 | <H> | ... |

## 官方源码背板依据
- pair_style: `vendor/lammps-official/src/.../pair_<...>.cpp`
- 命令手册: `vendor/lammps-official/doc/src/<...>.rst`
