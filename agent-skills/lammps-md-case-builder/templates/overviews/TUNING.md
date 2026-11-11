# 可能问题及调优方向: <案例名>

## 稳定性风险（按概率排序）
| 症状 | 根因 | 首选修法 | 备选 |
| --- | --- | --- | --- |
| Lost atoms / 原子飞散 | 初始重叠 或 timestep 过大 | 先 `minimize` + 减小 timestep | soft 势预推开重叠 |
| ReaxFF 立刻炸 | timestep>0.25fs 或缺 qeq | timestep 0.1-0.25fs + `fix qeq/reaxff` | 预松弛 NVT 低温 |
| 温度失控/爆温 | 控温挂了含定向速度的 all | `compute temp` 挂去质心子 group | 检查 Tdamp |
| 拓扑不符报错 | atom_style 与 data 段不匹配 | full 需 Bonds/Angles；charge 不能有 Bonds | |
| 缺 pair_coeff | 某 type 对未赋参 | 补全所有 i≤j 组合或用 `* *` | |
| 势文件缺元素 | pair_coeff 元素不在 ffield | 换含该元素的势文件 | |

## 精度 / 收敛调优
- 时间步无关性：减半 timestep 看能量漂移是否显著减小（NVE 能量应守恒）。
- 尺寸效应：加大盒子/原子数，关注目标量收敛。
- 平衡判据：thermo 里 T/P/PE 达到平台后再统计。
- 统计量：扩散系数用 MSD 线性段拟合；RDF 用 `compute rdf` 足够采样。

## 物理合理性自查清单
- [ ] units ↔ atom_style ↔ pair_style ↔ data 四者自洽
- [ ] timestep 量级与 units 匹配（见 ALGORITHM）
- [ ] 先 minimize 再 run
- [ ] pair_coeff 元素顺序 = data atom type 顺序
- [ ] 控温 group 不含定向速度
- [ ] 所有 atom type 都有 mass 与 pair_coeff
- [ ] ReaxFF: atom_style charge + fix qeq + 无 Bonds 段
- [ ] 势文件对应的 package 已在编译时启用

## 性能
- 邻居表 skin 调优；`neigh_modify every 1 delay 0 check yes`。
- 并行域分解与 mpirun -np 匹配；GPU/KOKKOS 加速需对应 package。
- 长跑前 `run 200` 探针确认无报错再放量。
