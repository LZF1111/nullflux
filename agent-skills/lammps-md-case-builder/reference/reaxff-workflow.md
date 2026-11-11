# ReaxFF 反应力场完整工作流

ReaxFF = 可断键成键的反应力场，用于热解 / 燃烧 / 氧化 / 催化。比经典力场贵得多，
timestep 必须很小，初始构型必须先消重叠，否则秒崩。

## 关键约束

- `units real`（长度 Å、能量 kcal/mol、时间 fs）。
- `atom_style charge`（每原子带电荷 q；data 里**不能有** Bonds/Angles，键由力场动态判断）。
- `pair_style reaxff`（新版）或 `reax/c`（旧版，LAMMPS 版本决定）。
- **必须配电荷平衡** `fix qeq/reaxff`（旧版 `fix qeq/reax`），每步动态分配电荷。
- **timestep 0.1–0.25 fs**（写 ≥1fs 几乎必 Lost atoms）。
- 需编译进 `REAXFF`（旧称 `USER-REAXC`）包，否则 `Unknown pair_style reaxff`。

## 完整脚手架

```
# ---------- 初始化 ----------
units           real
atom_style      charge
dimension       3
boundary        p p p

# ---------- 读构型（先消重叠，见下）----------
read_data       data.system          # 或 data.relaxed（软势预平衡后）

# ---------- ReaxFF 力场 ----------
pair_style      reaxff NULL           # 旧版: reax/c NULL
pair_coeff      * * ffield.reax.CHON C H O N   # 元素列=atom type 顺序！
neighbor        2.0 bin
neigh_modify    delay 0 every 1 check no

# 电荷平衡（每步）——必需！
fix             qeq all qeq/reaxff 1 0.0 10.0 1e-6 reaxff   # 旧版: qeq/reax ... reax/c

# 键级/物种分析（可选但常用）
fix             sp all reaxff/species 1 10 100 species.out  # 输出分子物种演化
# compute       reax all pair reaxff                        # 分解能量项

# ---------- 预松弛：消初始重叠（防能量爆/力 NaN）----------
min_style       cg
minimize        1.0e-4 1.0e-6 1000 10000
reset_timestep  0
velocity        all create 300.0 4928459 mom yes rot yes dist gaussian
timestep        0.1                    # warmup 更保守
fix             warm all nve/limit 0.1 # 限位积分，温和推开重叠
thermo          100
run             5000
unfix           warm

# ---------- 生产 NVT ----------
timestep        0.25                   # ReaxFF 上限 ~0.25 fs
fix             1 all nvt temp 300 300 100.0   # real 单位 Tdamp~100fs
thermo          100
thermo_style    custom step temp pe ke etotal press
dump            1 all custom 1000 dump.reax id type q x y z
dump_modify     1 sort id
run             100000
write_data      data.final
```

## 初始重叠严重时：软势预平衡（soft pushoff）

若初始构型能量爆（如 1e8 kcal/mol）、力 NaN、或直接 Lost atoms，先用软势温和推开重叠再交给 ReaxFF：

```
# 单独一个预处理脚本 in.pushoff
units           real
atom_style      charge
read_data       data.system
pair_style      soft 3.0
pair_coeff      * * 0.0
variable        prefactor equal ramp(0,30)     # 前置因子从 0 缓升
fix             push all adapt 1 pair soft a * * v_prefactor
velocity        all create 300 12345 mom yes
fix             nve all nve/limit 0.1
timestep        0.1
run             5000
unfix push
min_style       cg
minimize        1e-4 1e-6 1000 10000
write_data      data.relaxed            # 用它作 ReaxFF 的 read_data
```

## 版本自适应（reaxff vs reax/c）

- LAMMPS 2022+：`pair_style reaxff`、`fix qeq/reaxff`、`fix reaxff/species`。
- 老版本：`pair_style reax/c`、`fix qeq/reax`、`fix reax/c/species`。
- 不确定时让用户 `lmp -h | grep -i reax` 看装的是哪个；或先按新版写，报 `Unknown pair_style`
  再退回 `reax/c`。

## ReaxFF 常见坑

- **Lost atoms**：timestep 太大（降到 0.1–0.25）；初始重叠（先 minimize / soft pushoff）。
- **`atom X has no parameters`**：选的 ffield 不含该元素 → 换覆盖全元素的 ffield.reax.*。
- **忘了 fix qeq**：电荷不平衡，能量/力乱飞 → ReaxFF 必须有 qeq。
- **data 里带了 Bonds 段**：ReaxFF 的 data 只要 Masses + Atoms(带 q)，不要拓扑段。
- **timestep 单位**：real 单位下 `timestep 0.25` = 0.25 fs（不是 0.25 ps）。
