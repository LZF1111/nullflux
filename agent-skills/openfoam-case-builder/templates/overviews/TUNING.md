# 可能问题及调优方向: <案例名>

## 稳定性风险（按概率排序）
| 症状 | 根因 | 首选修法 | 备选 |
| --- | --- | --- | --- |
| 残差不降/发散 | 初场差 / 松弛过大 / 格式过激进 | 降松弛(U0.5,p0.3) 或 SIMPLEC | div 退到 upwind；potentialFoam 打初场 |
| `bounding k,omega` 频繁 | 入口湍流量或壁面函数不当 | 核对 k/omega 入口值与量纲 | 换低 Re 壁面函数(y+~1) |
| 压力求解 singularity | 全 Neumann 无参考压 | 出口设 fixedValue p=0 | 设 pRefCell/pRefValue |
| 出口回流发散 | 出口 zeroGradient | 出口改 inletOutlet | |
| checkMesh 负体积/高偏斜 | 网格差 / snappy 抠空 | 改 snappy refinement/layers | 降层数/膨胀比 |
| 多相界面涂抹 | 对流格式耗散 | div(phi,alpha) 用 vanLeer + cAlpha 1 | 减小 Courant |

## 精度 / 收敛调优
- 网格无关性：粗→中→细三套网格对比目标量，变化<2% 即收敛。
- 边界层 y+：高 Re 壁面函数 y+≈30–300；解析边界层 y+≈1（换 nutLowReWallFunction）。
- 残差判据：`residualControl` p/U 1e-4；重要量（Cd/Cl）稳定比残差更可靠。
- 离散升阶：先 upwind 稳住，再切 linearUpwind/linear 提精度。

## 物理合理性自查清单
- [ ] 所有场的 dimensions 正确（k=[0 2 -2..], omega=[0 0 -1..], nu=[0 2 -1..]）
- [ ] 每个 patch 在每个场里都有 boundaryField 条目（不缺不多）
- [ ] 入口湍流量数量级合理（k、omega/epsilon 与经验公式一致）
- [ ] Re/Ma 数量级与预期一致
- [ ] 多相已用 setFields 初始化 alpha

## 性能 / 并行
- `decomposePar`：`numberOfSubdomains` = 核数；`method scotch`(自动) 或 `hierarchical`。
- 稳态收敛后可加大 writeInterval 减少 I/O。
- GAMG 的 `nCellsInCoarsestLevel` 影响多重网格效率。
