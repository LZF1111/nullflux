---
name: liggghts-dem-case-builder
description: >-
  用 LIGGGHTS-PUBLIC 3.8 搭建、运行、监视和后处理离散元 (DEM) 颗粒算例。当任务涉及颗粒床、振动托盘/振动盘/振动筛、
  颗粒混合与偏析、料仓卸料、滚筒、颗粒镀膜（磁控溅射粉体镀膜）均匀性、粗粒化 (coarse graining)、
  接触模型 (hertz/hooke, 切向历史, 滚动摩擦)、fix move/mesh 振动波形 (wiggle/viblin/vibrot)、STL 壁面网格时使用。
  本机可执行文件见下文“环境”。输出完整算例目录 (in.* 脚本、STL、后处理 Python) 并负责实际运行与验证。
license: MIT
---

# LIGGGHTS 离散元 (DEM) 技能

## 环境
- 可执行文件：`lmp_auto`（LIGGGHTS-PUBLIC 3.8.0，OpenMPI，无 VTK 输出）。
- 运行：在算例目录 `mpirun -np N lmp_auto -in in.xxx -log log.liggghts > out.liggghts 2>&1`。
  用 lbm_run_async 或 run_command 后台启动后，用 solver_wait 等待（日志里的进度行是 thermo 的 Step 行，不是 OpenFOAM 的 Time =）。
- 后处理用 python3 + numpy + matplotlib。**Python 一律 Tab 缩进**。

## 纪律
1. 动手前先算：颗粒数、床层厚度、无量纲加速度 Γ、接触时间 t_c、时间步 dt ≤ t_c/20。写进 MANIFEST.md。
2. 基准先行：单颗粒回弹（恢复系数）、静止沉降（颗粒数守恒、最大重叠 < 1% d）、Γ 起跳阈值，三项过了才做设计算例。
3. 沉降与振动分开：先沉降到动能 < 1e-12 J 并 `write_restart`，所有振动工况从同一个 restart 读起。
4. 每个算例都要检查：`atoms` 列不变（Lost atoms = 0）、ke 不指数增长、最大重叠。
5. 粗粒化结论必须和真实粒径小块在一个重叠工况上对比，误差 < 10% 才能用。

## 参考
- `reference/vibrated-tray.md`：振动托盘问题的量级估算、输入骨架、振动写法（已对照官方 fix move/mesh 文档）、
  曝光/镀膜均匀性后处理、常见报错。
- `reference/benchmarks.md`：本机已跑过的基准结果（恢复系数标定等）。
