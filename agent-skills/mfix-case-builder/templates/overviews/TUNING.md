# 可能问题及调优方向: <案例名>

## 稳定性风险（按概率排序）
| 症状 | 根因 | 首选修法 | 备选 |
| --- | --- | --- | --- |
| EP_g 越界(<0 或 >1)发散 | DT 过大/曳力过强/初始堆积>最大堆积 | 减小 DT(自适应) + IC_EP_G≥EP_STAR | DISCRETIZE 用一阶(2)；曳力 GIDASPOW_BLEND |
| 残差不降,MAX_NIT 用满 | 迭代不足/DT 大/BC 不物理 | 增 MAX_NIT + 减 DT | 核对入口气速在 U_mf~U_t |
| 床层整体喷飞 | 入口气速 >> U_t | 降 BC_V_G 到 1–5×U_mf | |
| DEM 颗粒爆散 | 初始重叠/碰撞步过大 | 无重叠初始 + 小 DES_MIN_DT | 降 KN 软化 |
| 单位数量级异常 | CGS/SI 混用 | 统一 SI | |

## 精度 / 收敛调优
- 网格无关性：IMAX/JMAX 加密对比床层膨胀高度/压降，变化<5% 即够。
- 曳力选择：稠密鼓泡床 GIDASPOW(_BLEND)；稀相 WEN_YU；多分散 BVK。
- KT_TYPE：快速起步 ALGEBRAIC，要精度用 GHD/LUN_1984。
- 时间步：自适应 DT_MAX/DT_MIN 跟耦合稳定性。

## 物理合理性自查清单
- [ ] BC 覆盖所有边界，每个 BC_TYPE 必需场齐全
- [ ] IC 区并集铺满整域，IC_EP_G ≥ EP_STAR
- [ ] 相索引 ≤ MMAX，单位 SI
- [ ] 入口气速在 U_mf~U_t 区间
- [ ] DEM: 无初始重叠，碰撞步足够小
- [ ] VTK/RES 输出频率能覆盖关注瞬态

## 性能 / 并行
- 域分解 NODESI/NODESJ/NODESK 与 mpirun -np 一致。
- DEM 用近邻网格/cell-linked-list 加速碰撞检测。
- 收敛后加大 VTK_DT 减少 I/O。
