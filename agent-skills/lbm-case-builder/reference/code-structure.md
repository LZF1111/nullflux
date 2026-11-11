# LBM 求解器代码结构 (code structure)

## 顶层骨架（自研）
```
1. 读参数 / 单位换算  (Re, Nx, Ny, u_lb -> nu_lb, tau)
2. 建格子常数         (c[Q], w[Q], opposite[Q], cs2=1/3)
3. 分配场             (f[Q,Nx,Ny], feq, rho, u[2或3])
4. 初始化            (rho=1, u=0 或给定 -> f = feq)
5. 主循环 t=0..T:
      (a) 宏观量      rho=Σf, u=Σc f / rho  (+半步力)
      (b) collision   f* = f - (1/tau)(f - feq)   (+力项)
      (c) streaming   f_i(x+c_i) = f*_i(x)         (push) 或 pull
      (d) apply BC    bounce-back / Zou-He / 周期 / 出口
      (e) 收敛/输出    每 K 步查残差、存场
6. 后处理            速度/涡量 -> VTK/npy + 图
```

## collision 与 streaming 的两种写法
- **push (collide-then-stream)**：碰撞后把 $f_i^*$ 推到邻点。需注意别覆盖未处理数据 → 用两个数组 (f, f_new) 或先碰撞再整体 roll。
- **pull (stream-then-collide)**：先从邻点拉 $f_i$ 进本点再碰撞。缓存友好。
- **AB 双缓冲**最稳妥：读 `f`、写 `f_new`，循环末交换。NumPy 里 streaming 用 `np.roll(f[i], shift=c_i, axis=...)`。

## 数据布局
- **SoA**（`f[Q][Nx][Ny]`，本 skill Python 模板用）：向量化/GPU 友好，推荐。
- **AoS**（`cell[x][y].f[Q]`）：C++ 面向对象框架常见。
- 大 3D 用 SoA + 单精度可省显存；注意 NaN 检查。

## 常见扩展点
| 需求 | 加什么 | 参照 |
| --- | --- | --- |
| 体力/浮力 | Guo forcing 项 + 半步速度修正 | collision-operators.md |
| 传热 | 第二套分布 g（DDF，D2Q5/D2Q9）解温度平流扩散 | 热 LBM |
| 多相/多组分 | Shan-Chen 伪势力 或 自由能/相场 | Palabos multiPhase |
| 高 Re 稳定 | BGK→MRT/Cumulant/Regularized | collision-operators.md |
| 复杂几何 | 障碍掩码 + (插值)bounce-back | boundary-conditions.md |
| 湍流 | Smagorinsky 亚格子（局部改 τ） | LES-LBM |

## 框架 vs 自研
- **自研 Python/NumPy**：快速验证、教学、算法研究；分辨率/性能有限。
- **Palabos (C++)**：并行、多物理、成熟；用其 `Dynamics`+`BoundaryCondition` 组合。
- **OpenLB (C++)**：模板化、高性能、GPU；`SuperLattice` + `setXxxBoundary`。

## 官方背板参照
- Palabos 例子：`examples/showCases/cavity2d`, `cylinder2d`, `rayleighTaylor`（完整可跑，学结构）
- OpenLB 例子：`examples/laminar/cavity2d`, `examples/laminar/cylinder2d`
