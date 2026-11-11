# LAMMPS 官方源码背板索引 (SOURCE_MAP)

> 写任何 `pair_style`/`fix`/`compute`/`pair_coeff` 前，若不确定语法或参数含义，先来这张表定位官方源码，
> 在 `vendor/lammps-official/` 里 `read_file` 打开对齐。**本 skill 已内置完整官方 LAMMPS src+doc**，禁止凭记忆猜参数。

## 0. 已内置的官方源码（就在本 skill 里，非指针）

| 目录 | 内容 | 用途 |
| --- | --- | --- |
| `vendor/lammps-official/src/` | 全部 C++ 源码（每个 pair_style/fix/compute = 一对 `.cpp/.h`） | 命令语法/参数解析的**最终权威** |
| `vendor/lammps-official/doc/src/` | 官方 reStructuredText 命令手册（`*.rst`） | 每条命令的语法、参数、示例、注意事项 |

> **两种查法**：要快速看语法 → 读 `doc/src/<命令>.rst`；要看参数怎么解析/默认值/边界 → 读 `src/.../<file>.cpp` 的
> `settings()` / `coeff()` / `init_one()`。

## 一、命令 → 官方源码 / 文档定位

### 势函数 pair_style
| 你要写 | 文档 (doc/src/) | 源码 (src/) | 关键校验点 |
| --- | --- | --- | --- |
| `pair_style lj/cut` | `pair_lj_cut.rst` | `pair_lj_cut.cpp` | epsilon/sigma/cutoff 顺序 |
| `pair_style eam/alloy` | `pair_eam.rst` | `MANYBODY/pair_eam.cpp` | `pair_coeff * * file El1 El2 ...` 元素映射 |
| `pair_style tersoff` | `pair_tersoff.rst` | `MANYBODY/pair_tersoff.cpp` | 元素顺序 = data 里 atom type 顺序 |
| `pair_style sw` (Stillinger-Weber) | `pair_sw.rst` | `MANYBODY/pair_sw.cpp` | 同上元素映射 |
| `pair_style reaxff` (旧 `reax/c`) | `pair_reaxff.rst` | `REAXFF/pair_reaxff.cpp` | 需 `atom_style charge` + `fix qeq/reaxff`；data 无 Bonds |

### 系综 / 控温控压 fix
| 你要写 | 文档 | 源码 | 关键校验点 |
| --- | --- | --- | --- |
| `fix nve` | `fix_nve.rst` | `fix_nve.cpp` | 微正则 |
| `fix nvt` / `fix npt` | `fix_nh.rst` | `fix_nh.cpp`（Nosé-Hoover 基类） | `temp Tstart Tstop Tdamp`；Tdamp≈100×dt |
| `fix langevin` | `fix_langevin.rst` | `fix_langevin.cpp` | 需配 `fix nve`；控温 group 别挂含定向速度的 all |
| `fix qeq/reaxff` | `fix_qeq_reaxff.rst` | `REAXFF/fix_qeq_reaxff.cpp` | ReaxFF 必配，电荷平衡频率 1 |

### 基础命令
| 主题 | 文档 |
| --- | --- |
| units 各制含义与量纲 | `units.rst` |
| atom_style 列定义 | `atom_style.rst` |
| minimize 收敛判据 | `minimize.rst` |
| compute temp / 子 group 控温 | `compute_temp.rst` |
| thermo_style / dump | `thermo_style.rst` / `dump.rst` |

## 二、势文件 (potentials) 从哪来

- 官方势库在 LAMMPS 发行包的 `potentials/` 目录（EAM `.eam.alloy`、Tersoff `.tersoff`、ReaxFF `ffield.reax.*`）。
- 本 skill **未内置** `potentials/`（55MB，多为二进制/大数据）。生成算例时：
  1. 在 `in.*` 里按官方命名引用（如 `pair_coeff * * Cu_mishin1.eam.alloy Cu`）；
  2. 在 MANIFEST.md 注明"需从 LAMMPS 安装的 `potentials/` 或 `vendor` 获取该势文件"；
  3. 若本机装了 LAMMPS，用 `fetch_sources.*` 的 link 模式把 `potentials/` 软链进来核对元素。

## 三、验证生成结果对不对（拿官方源码对照）

1. 命令拼写：在 `doc/src/` 下确认命令名 `.rst` 存在（改名/弃用命令能立刻发现）。
2. 参数个数/顺序：读对应 `.cpp` 的 `settings()`（pair_style 后参数）与 `coeff()`（pair_coeff 参数）。
3. 元素映射：EAM/Tersoff/SW/ReaxFF 的 `pair_coeff * * file El1 El2 ...` 元素顺序**必须**等于 data 里 atom type 1..N。
4. 包依赖：某命令属于可选包（如 REAXFF/MANYBODY）→ 提醒用户编译 LAMMPS 时需带该 package。

> 若 `vendor/lammps-official/` 被清空：在 ALGORITHM.md/MANIFEST.md 顶部标注 `⚠ 未接入官方源码背板`，
> 提示用户运行 `fetch_sources.*`（link 本机 LAMMPS 或从 MDriver 自带包复制）。
