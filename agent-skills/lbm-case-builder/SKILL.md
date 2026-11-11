---
name: lbm-case-builder
description: >-
  生成、修改与校验格子玻尔兹曼方法 (LBM, Lattice Boltzmann Method) 的求解代码与算例配置。
  当用户要求：搭建 LBM 流动仿真（顶盖驱动方腔/圆柱绕流/多孔介质/多相流/热对流）、编写或修改
  格子模型 (D2Q9/D3Q19/D3Q27)、碰撞算子 (BGK/MRT/TRT/Cumulant/正则化)、边界条件
  (bounce-back 反弹/Zou-He/非平衡外推/周期)、三大核心步骤 (equilibrium 平衡分布/collision 碰撞/
  streaming 迁移)、单位换算 (物理↔格子单位)、或选择求解框架 (Palabos/OpenLB/自研 Python/C++) 时使用。
  LBM 无固定输入卡格式——本技能产出完整可读可编译的求解器源码文件（Python/C++）与配置，
  实际运行由用户执行。输出整体代码文件 + 三份总览(文件/算法/调优)，写核心算法时以官方
  Palabos/OpenLB 源代码为背板参照。
license: MIT
---

# LBM 格子玻尔兹曼算例配置技能

你现在具备为 **格子玻尔兹曼方法 (LBM)** 生成流动/传热仿真求解代码与算例配置的领域能力。
LBM **没有统一输入卡格式**：可用成熟框架（Palabos C++、OpenLB C++）或自研求解器（Python/NumPy、C++）。
本技能**只产出完整代码文件**——实际编译与运行交给用户执行。

## 交付契约（最高优先级，先读）

- **输出整体算例**：一次交付跑一个 LBM 算例所需的**全部文件**（求解器主程序 + 参数/配置 +
  必要的后处理脚本），外加三份总览 `MANIFEST.md` / `ALGORITHM.md` / `TUNING.md`
  （模板见 `../_shared/OUTPUT_CONTRACT.md`）。
- **官方源码背板**：写碰撞/平衡/边界核心算法前，必须照 `backplane/SOURCE_MAP.md` 在 Palabos/OpenLB
  官方源码里定位参考实现（如 `BGKdynamics`、`MRTdynamics`、`ZouHeVelocityBoundary`），照其公式与
  权重/声速常数写。背板机制见 `../_shared/BACKPLANE.md`，获取源码用 `backplane/fetch_sources.*`。
- **只生成、不代跑**：产出完整可编译/可读的文件即完成。

## 核心纪律（先读这段）

1. **格子单位是命门**：LBM 内部一切用**格子单位**（Δx=Δt=1，声速 $c_s^2=1/3$）。物理量必须先无量纲化：
   - 特征速度 `u_lb < 0.1`（越小越准，太大失稳/可压缩误差）。典型 0.02~0.1。
   - 由 Re 反推松弛时间：$\nu_{lb}=u_{lb}L_{lb}/Re$，$\tau=3\nu_{lb}+0.5$。**τ 必须 > 0.5**，
     越接近 0.5 越易失稳（BGK 尤甚），实用下限 ~0.51。
   - 换算关系写进 MANIFEST/ALGORITHM，别把物理 SI 直接塞进 collision。
2. **三大核心步骤缺一不可**，顺序固定：
   - **equilibrium** 平衡分布 $f_i^{eq}=w_i\rho\left[1+\frac{\mathbf{c}_i\cdot\mathbf{u}}{c_s^2}
     +\frac{(\mathbf{c}_i\cdot\mathbf{u})^2}{2c_s^4}-\frac{\mathbf{u}\cdot\mathbf{u}}{2c_s^2}\right]$
   - **collision** 碰撞（BGK/MRT…）：$f_i^*=f_i-\frac{1}{\tau}(f_i-f_i^{eq})$（+ 外力项）
   - **streaming** 迁移：$f_i(\mathbf{x}+\mathbf{c}_i,t+1)=f_i^*(\mathbf{x},t)$
   宏观量 $\rho=\sum_i f_i$，$\rho\mathbf{u}=\sum_i \mathbf{c}_i f_i$（+ 半步力修正）。
3. **格子选型**：2D 用 **D2Q9**；3D 用 **D3Q19**（性价比高）或 **D3Q27**（各向同性/高 Re/湍流更好）。
   权重 $w_i$ 与离散速度 $\mathbf{c}_i$ 必须成套，别混。详见 `reference/lattice-schemes.md`。
4. **碰撞算子选型**：BGK 单松弛（最简，高 Re/近 τ=0.5 易失稳）→ TRT 双松弛（边界更准、稳）→
   MRT 多松弛（稳定性/精度最好，成本略高）→ Cumulant/正则化（高 Re 首选）。详见
   `reference/collision-operators.md`。
5. **边界条件**：固壁常用 **bounce-back**（半程/全程，半程更准且位于半格）；速度/压力入口用 **Zou-He**
   或**非平衡外推**；出口常用外推/对流出流；**周期**边界直接环绕。每条边界要指明作用在哪些
   $f_i$（指向域内的未知分布）。详见 `reference/boundary-conditions.md`。
6. **收敛判据**：稳态用相对速度残差 $\frac{\|\mathbf{u}^{n+1}-\mathbf{u}^n\|_2}{\|\mathbf{u}^n\|_2}<\epsilon$
   （如 1e-6）；瞬态跑到物理终止时间。监控 $\rho$ 不发散（NaN/负值即失稳）。
7. **自研代码的静态自检**（交付前）：权重和 $\sum_i w_i=1$；对称速度集齐全；τ>0.5；u_lb<0.1；
   bounce-back 的反向索引 (opposite) 表正确；数组维度含所有 Q 个方向。

## 标准工作流

### A. 从零搭建算例
1. **问清工况**（一次问完给默认）：几何/流动类型（方腔/绕流/通道/多孔/多相/热对流）、维度(2D/3D)、
   雷诺数 Re、分辨率（格子数 Nx×Ny×[Nz]）、框架偏好（自研 Python 快速验证 / Palabos·OpenLB 高性能 C++）、
   碰撞算子（默认 D2Q9-BGK 起步）、边界类型、稳态或瞬态。
2. **单位换算**：定 u_lb（默认 0.1）→ 由 Re 算 $\nu_{lb}$、τ → 记录物理↔格子映射表（进 ALGORITHM）。
3. **选骨架**：自研走 `templates/`；高性能走 `backplane/SOURCE_MAP.md` 指的 Palabos/OpenLB 例子。
4. **写求解器**：初始化(f=feq)→主循环{collision→streaming→apply BC→(compute macros)}→收敛判据→输出。
   核心三步照 `reference/code-structure.md`，碰撞/边界公式照 SOURCE_MAP 官方参照。
5. **后处理**：导出速度/涡量场（VTK 或 .npy + matplotlib），对标基准（如方腔 Ghia 数据）。
6. **写三份总览**（MANIFEST/ALGORITHM/TUNING）。

### B. 修改/扩展已有 LBM 代码
1. 先读懂现有格子/碰撞/边界约定（Q 数、权重、索引顺序、opposite 表）。
2. 按需替换：BGK→MRT（加变换矩阵 M 与松弛率对角阵）、加外力（Guo forcing）、加温度场（双分布 DDF）、
   加多相（Shan-Chen 伪势 / 自由能）。改动照 SOURCE_MAP 官方对应实现。
3. 保持权重/声速/opposite 一致性；改完跑静态自检。

### C. 植入核心算法（照官方背板）
1. 查 `backplane/SOURCE_MAP.md` 找目标算法（如 MRT、Zou-He、Shan-Chen）的官方类/文件。
2. `backplane/fetch_sources.*` 接入 Palabos/OpenLB 源码到 `vendor/`。
3. 照官方公式/常数（变换矩阵、松弛率、权重）实现，在 `ALGORITHM.md` 标注来源文件与类名。

## reference/（按需深入）
- `reference/lattice-schemes.md` — D2Q9/D3Q19/D3Q27 速度集、权重、opposite 表、声速
- `reference/collision-operators.md` — BGK/TRT/MRT/Cumulant/正则化 公式与选型
- `reference/boundary-conditions.md` — bounce-back(半/全)、Zou-He、非平衡外推、周期、对流出流
- `reference/code-structure.md` — 求解器骨架、数据布局(AoS/SoA)、push/pull streaming、外力/热/多相扩展
- `reference/error-patterns.md` — 失稳/发散/边界渗漏/单位错 常见问题与修法

## backplane/（官方源码背板）
- `backplane/SOURCE_MAP.md` — LBM 生成任务 → Palabos/OpenLB 官方文件/类映射
- `backplane/fetch_sources.sh` / `.ps1` — 克隆或登记本机 Palabos/OpenLB 到 vendor/

## templates/（可拷贝骨架）
- `templates/lbm_cavity_d2q9_bgk.py` — 完整 D2Q9-BGK 顶盖驱动方腔（NumPy，可直接跑）
- `templates/params.example.py` — 参数/单位换算配置
- `templates/overviews/{MANIFEST.md,ALGORITHM.md,TUNING.md}` — 三份总览填空示例
