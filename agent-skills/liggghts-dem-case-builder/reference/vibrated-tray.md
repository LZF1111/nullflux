# LIGGGHTS 振动托盘 DEM 指南

适用：薄层颗粒在振动托盘/振动盘/振动筛上的运动，振动波形设计、托盘结构对比、镀膜/混合均匀性评估。

## 0. 环境（my-server）
- 可执行文件：`lmp_auto`（LIGGGHTS-PUBLIC 3.8.0，MPI，无 VTK）。运行：`mpirun -np N lmp_auto -in in.xxx -log log.liggghts`。
- 核数：先看 `uptime` 的负载，总负载不超过 90；单个算例 8–32 核即可，颗粒数 / 核数 ≥ 5000 才划算。
- 没有 GPU。后处理用 python3 + numpy + matplotlib（服务器有）。
- 写 Python 一律用 Tab 缩进（工具参数里连续 8 个以上空格会被中转通道吞掉）。

## 1. 问题的量级（动手前先算）
- 颗粒数 N = 质量 / (ρ·π d³/6)。200 g、d=100 µm、ρ=10000 → 3.8×10⁷，整盘真实粒径不可算。
- 床层厚度 h = 面密度 / (ρ·φ)，φ≈0.6。上例 h≈0.47 mm ≈ 5 层。
- 无量纲加速度 Γ = A(2πf)²/g；振幅 A = Γ g/(2πf)²。
- 接触时间 t_c = π / sqrt(k/m_eff · (1-β²))，时间步 dt ≤ t_c/20。Hooke 模型下软化刚度可以，但最大重叠 < 1% 粒径。
- 两级模型：
  - A 级：真实粒径周期小块（x、y 周期，底部为振动平板），5×5 mm 约 2–5 万颗，做机理与波形。
  - B 级：整盘粗粒化（coarse graining，CG 倍数 k：粒径×k、颗粒数÷k³、密度不变、刚度按 Bierwisch 规则不变或按 k 缩放），做结构与宏观流动。B 级结论必须在一个重叠工况上与 A 级对比（床层膨胀、表层速度），误差 < 10% 才能用。

## 2. 输入脚本骨架（A 级周期小块）
```
atom_style  granular
atom_modify map array
boundary    p p f
newton      off
communicate single vel yes
units       si
region      domain block 0 0.005 0 0.005 -0.001 0.02 units box
create_box  1 domain
neighbor    0.00002 bin
neigh_modify delay 0
fix m1 all property/global youngsModulus peratomtype 5e6
fix m2 all property/global poissonsRatio peratomtype 0.3
fix m3 all property/global coefficientRestitution peratomtypepair 1 0.7
fix m4 all property/global coefficientFriction peratomtypepair 1 0.4
fix m5 all property/global coefficientRollingFriction peratomtypepair 1 0.05
pair_style  gran model hertz tangential history rolling_friction cdt
pair_coeff  * *
timestep    1e-7
fix gravi all gravity 9.81 vector 0 0 -1
# 底板用 mesh/surface 或 wall/gran 平面；振动用 move/mesh 或 wall/gran 的 wiggle
fix floor all wall/gran model hertz tangential history rolling_friction cdt primitive type 1 zplane 0.0
```
- 振动：
  - 正弦竖直：`fix vib all move/mesh mesh floorMesh wiggle amplitude 0 0 A period T`（mesh 底板），或 `fix floor ... zplane 0.0 wiggle z A period T`。
  - 椭圆/相位差/二次谐波/扭转：用 `move/mesh` 的 `viblin`（多谐波线性振动）与 `vibrot`（多谐波扭转），可以叠加多个 move/mesh 到同一网格（注意顺序和 `fix_id` 不同）。
  - 示例（周期 T、二次谐波周期 T/2，每一阶都要单独给 phase 和 period）：`fix mv1 all move/mesh mesh tray viblin axis 0 0 1 order 2 amplitude A1 A2 phase 0 phi2 period T T2`（T2 = T/2 写成数值）
  - 椭圆振动 = 两个 viblin（axis 0 0 1 与 axis 1 0 0）叠加，相位差写在 phase 里；周向椭圆 = viblin(z) + vibrot(z 轴)。
  - 注意 viblin 定义是 A·sin(2π t/T + phase)，从 fix 生效时刻起算；沉降完再加振动，并用 run 前的 `reset_timestep` 前后一致。
- 颗粒生成：`fix pts all particletemplate/sphere` + `fix pdd all particledistribution/discrete` + `fix ins all insert/pack ... volumefraction_region 0.3` 或 `insert/rate/region`，先沉降（不振动）到动能 < 1e-12 J，再 `write_restart`，振动工况从 restart 起步。
- 托盘几何（B 级）：在服务器上用 python 写 ASCII STL（底板、侧壁、圆角、中心锥、导流筋），`fix tray all mesh/surface file tray.stl type 1 scale 1`，再 `fix wall all wall/gran model hertz tangential history mesh n_meshes 1 meshes tray`。

## 3. 输出
- `thermo_style custom step atoms ke cpu`，`thermo 1000`，`thermo_modify lost ignore norm no`。
- `dump d1 all custom 20000 post/dump*.liggghts id type x y z vx vy vz omegax omegay omegaz radius`
- 曝光统计不在 LIGGGHTS 里做：dump 间隔取 0.5 ms 物理时间，Python 后处理（见 §5）。

## 4. 必过的基准（不过不准做设计）
1. 单颗粒落到静止板：回弹速度比 = 设定恢复系数，误差 < 2%。
2. 静止沉降：颗粒数守恒（atoms 不变），最大重叠 < 1% d。
3. 竖直振动起跳：Γ<1 床层不离开底板；Γ≈2.5–4 出现流化/Faraday 图案（文献：Melo, Umbanhowar & Swinney 1994/1995）。
4. 时间步与刚度：dt 减半、杨氏模量×4 时关键指标变化 < 5%。

## 5. 镀膜均匀性后处理（Python，读 dump）
- 曝光：每帧把 xy 平面按 d/4 网格划分，每个网格取最高颗粒表面；颗粒被“看见”的像素占其投影像素的比例 = 曝光分数 e_i（0–1）。
- 剂量 D_i = Σ e_i·J(r_i)·Δt，J(r) 为靶材径向通量（没有数据时用 1）。
- 指标：颗粒间剂量 CV = std(D)/mean(D)、CV 随时间衰减指数（理想混合 −1/2）、从未曝光比例、表面轮换频率（e 从 <0.05 升到 >0.5 的次数/秒）、单颗粒各向剂量 CV（用 omega 积分出的取向，12 个二十面体方向）。
- 冲击：相邻帧速度变化估计碰撞速度分布，报告 50/99 分位。

## 6. 常见报错
- `Volume expectancy too small`（particletemplate/sphere）：100 µm 级细颗粒必加 `volume_limit 1e-16`。
- `Pair granular with shear history requires newton pair off`：`read_restart` 之后要重新写 `newton off`（restart 不保存这个设置）。
- `Lost atoms`：时间步太大或颗粒飞出边界 → 检查 dt ≤ t_c/20、z 上界留足（≥ 2 cm）、`thermo_modify lost ignore` 只在确认是飞出时才用。
- `Neighbor list overflow`：`neigh_modify one 2000 page 200000`。
- `Mesh element has too many neighbours` / STL 法向问题：用 python 重新三角化，保证单位是 m（scale 1）。
- 速度爆炸（ke 指数增长）：刚度过高或重叠初始化 → 先 `insert/pack` 稀疏生成再沉降。
- `move/mesh` 叠加时报错：每个 move/mesh 的 fix-ID 不同，且都指向同一个 mesh fix。
- 并行加速差：颗粒都在底部薄层，`processors * * 1` 只在 xy 方向分区。
