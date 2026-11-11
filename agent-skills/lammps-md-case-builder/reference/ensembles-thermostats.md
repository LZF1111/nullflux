# LAMMPS 系综与控温控压

系综通过 `fix` 施加。同一时刻**只能有一个积分器 fix**（nve/nvt/npt/nph 之一）作用于同一 group。

## 三大系综

| 系综 | 守恒 | fix 写法 | 用途 |
| --- | --- | --- | --- |
| NVE | 粒子数/体积/能量 | `fix 1 all nve` | 平衡后取动力学量（扩散/RDF）；需外部控温则配 Langevin |
| NVT | 粒子数/体积/温度 | `fix 1 all nvt temp Tstart Tstop Tdamp` | 恒温模拟（最常用） |
| NPT | 粒子数/压力/温度 | `fix 1 all npt temp Ts Te Tdamp iso Ps Pe Pdamp` | 恒温恒压，盒子随压力伸缩（求密度/相变） |

- `Tdamp` 阻尼：`metal` 单位常用 0.1（ps），`real` 用 100（fs）。经验 Tdamp ≈ 100×timestep。
- `Pdamp` ≈ 1000×timestep（更大）。
- NPT 的压力耦合：`iso`（各向同性）/ `aniso`（三轴独立）/ `tri`（含剪切，可变形盒子）。

## 控温方式

| 方式 | 写法 | 特点 |
| --- | --- | --- |
| Nosé-Hoover | `fix 1 all nvt temp ...`（内建） | 正则系综严格，最常用 |
| Langevin | `fix lang all langevin Ts Te Tdamp seed` + `fix nve all nve` | 随机热浴，需**配一个 nve 积分**；适合非平衡/含流动 |
| Berendsen | `fix 1 all temp/berendsen Ts Te Tdamp` + `fix nve all nve` | 弛豫快但非正则系综，仅用于快速预平衡，不用于取样 |
| rescale | `fix 1 all temp/rescale N 1 Ts Te win frac` | 粗暴，仅升温/退火用 |

**Langevin/Berendsen/rescale 只控温不积分**，必须再加一个 `fix ... all nve` 做时间积分，否则原子不动。

## 控温 group 陷阱（重要）

**控温器别挂 `all`（含定向速度的体系）**：若体系有整体流向速度（如剪切流、泊肃叶流），
把流向速度当热运动会被错误"扣掉"，温度算错。正确做法：

```
group           flow region ...              # 只对流动子域
compute         mobileT flow temp/partial 0 1 1   # 只统计非流向分量的温度
fix             1 flow nvt temp 300 300 0.1
fix_modify      1 temp mobileT               # 让控温器用去流向的温度定义
```

或用 `compute temp/deform`（配 `fix deform` 剪切）、`compute temp/profile`（去除流场剖面）。
平衡态无定向流的体系可直接 `fix ... all nvt`。

## velocity 初始化

```
velocity        all create 300.0 4928459 mom yes rot yes dist gaussian
```

- `mom yes` 去除整体平动（否则质心漂移，控温出错）。
- `rot yes` 去除整体转动（有限团簇/非周期时重要）。
- seed 换个整数即可复现不同初速度。
- 从某温度继续升/降温：NVT 的 `Tstart Tstop` 写不同值即线性 ramp。

## 常见组合配方

```
# 平衡 + 取样标准流程
minimize        1.0e-4 1.0e-6 1000 10000        # 消重叠
velocity        all create 300 12345 mom yes rot yes dist gaussian
fix             1 all npt temp 300 300 0.1 iso 1.0 1.0 1.0   # 先 NPT 定密度
run             50000
unfix           1
fix             2 all nvt temp 300 300 0.1       # 再 NVT 取样
run             100000

# 退火（升温再缓冷）
fix             1 all nvt temp 300 1000 0.1
run             50000                             # 升到 1000K
unfix 1
fix             2 all nvt temp 1000 300 0.1
run             200000                            # 缓冷回 300K
```
