# LAMMPS input script (in.*) 结构解剖

一个 `in.*` 脚本按执行顺序分 8 段。命令自上而下解释执行，顺序错了就报错
（如 `pair_coeff` 必须在 `pair_style` 之后、`read_data`/`create_box` 之后）。

## 8 段结构

```
# ---------- 1) 初始化（定义单位/维度/边界/原子风格，必须在建盒子之前）----------
units           metal            # lj / real / metal / si / cgs / electron
dimension       3
boundary        p p p            # 每维: p周期 / f固定 / s收缩 / m收缩带最小
atom_style      atomic           # atomic / charge / full / molecular / bond / sphere ...

# ---------- 2) 构型：建盒子+原子 或 读外部 data ----------
# 方式A：规则晶格
lattice         fcc 3.615
region          box block 0 10 0 10 0 10
create_box      1 box
create_atoms    1 box
mass            1 63.546
# 方式B：读外部构型（Packmol/Moltemplate/ASE 生成）
# read_data       data.system     # data 里已含 box/Masses/Atoms(/Bonds...)

# ---------- 3) 力场 ----------
pair_style      eam/alloy
pair_coeff      * * Cu_mishin1.eam.alloy Cu   # 元素映射列 = type 顺序

# ---------- 4) 邻居表设置 ----------
neighbor        2.0 bin
neigh_modify    delay 10 every 1 check yes

# ---------- 5) 能量最小化（消初始重叠，几乎必做）----------
min_style       cg
minimize        1.0e-4 1.0e-6 1000 10000     # etol ftol maxiter maxeval

# ---------- 6) 初速度 + 系综(fix) ----------
velocity        all create 300.0 4928459 mom yes rot yes dist gaussian
timestep        0.001            # 与 units 量级匹配！见下表
fix             1 all nvt temp 300 300 0.1    # NVT

# ---------- 7) 输出 ----------
thermo          100
thermo_style    custom step temp pe ke etotal press vol density
dump            1 all custom 1000 dump.atom id type x y z
dump_modify     1 sort id

# ---------- 8) 运行 ----------
run             20000
# write_data      data.final      # 存末态
```

## units 对照表（选错则 timestep/物性全错）

| units | 长度 | 能量 | 时间 | timestep 典型 | 适用 |
| --- | --- | --- | --- | --- | --- |
| `lj` | σ (无量纲) | ε | τ | 0.005 | 通用/教学，约化单位 |
| `real` | Å | kcal/mol | fs | 0.5–1.0（ReaxFF 0.1–0.25） | 有机分子、生物、ReaxFF |
| `metal` | Å | eV | ps | 0.001–0.002 (=1–2 fs) | 金属、无机晶体、EAM/Tersoff |
| `si` | m | J | s | ~1e-15 | 粗粒化/宏观（少用） |
| `electron` | Bohr | Hartree | fs | — | QM 相关 |

## atom_style 对照表

| atom_style | 每原子数据 | data 需要的段 | 配合 pair/力场 |
| --- | --- | --- | --- |
| `atomic` | id type x y z | Masses, Atoms | LJ, EAM, Tersoff, SW（无电荷无键） |
| `charge` | + q（电荷） | Masses, Atoms(带 q) | ReaxFF, COMB, 需库仑的无机 |
| `molecular` | + 键连接 | + Bonds/Angles/Dihedrals | 无长程库仑的分子力场 |
| `full` | q + 键连接 | + Bonds/Angles/... + q | CHARMM/OPLS/AMBER 全原子 |
| `bond` | 仅键 | + Bonds | 粗粒化聚合物 |
| `sphere` | 半径+密度 | Atoms(带 diameter) | 颗粒/DEM (granular) |

**关键自洽**：`atom_style full/molecular/bond` → data 必须有对应 Bonds/Angles 段；反之
`atomic/charge` 的 data **不能**有 Bonds 段（否则 `Bonds section not allowed`）。
ReaxFF 用 `charge`（键由力场动态判断，不写在 data 里）。

## boundary 取值

- `p` 周期性（最常用）。
- `f` 固定非周期（原子飞出即丢失 → 常配 `fix wall/reflect` 兜住）。
- `s` 收缩包裹（盒子随原子伸缩）。
- `m` 收缩但不小于初始（minimum）。
- 例：流-壁体系 `boundary p p f` + 顶/底 `fix wall/reflect`。

## 命令顺序硬约束

1. `units`/`atom_style`/`boundary`/`dimension` 必须在 `create_box`/`read_data` **之前**。
2. `pair_coeff` 必须在 `pair_style` **之后**，且盒子/原子类型已知（read_data 或 create_box 后）。
3. `velocity`/`fix`/`run` 在力场与构型都就绪之后。
4. `minimize` 与 `run` 之间可 `reset_timestep 0`。
