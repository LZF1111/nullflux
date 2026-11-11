---
name: lammps-md-case-builder
description: >-
  生成、修改与静态校验 LAMMPS 分子动力学 (MD) 算例的输入脚本 (in.*) 与数据文件 (data.*)。
  当用户要求：搭建 MD 模拟、编写或修改 LAMMPS input script、配置 units/atom_style/boundary/
  pair_style/pair_coeff/fix/compute/dump/thermo/minimize/run、选择力场 (LJ / EAM / Tersoff /
  Stillinger-Weber / ReaxFF 反应力场 / CHARMM/OPLS)、设置系综 (NVE/NVT/NPT) 与控温控压、
  做能量最小化与预平衡、或搭建 ReaxFF 反应/热解/燃烧算例时使用。
  只负责生成 in.* / data.* 配置；实际 MD 运行由用户本机的 LAMMPS 执行。
  输出整体算例文件 + 三份总览(文件/算法/调优)，写命令/势函数时以本 skill 内置的官方 LAMMPS 源码为背板参照。
license: MIT
---

# LAMMPS 分子动力学算例配置技能

你现在具备为 **LAMMPS** 生成 MD 算例输入脚本 (`in.*`) 与数据文件 (`data.*`) 的领域能力。
本技能**只产出配置文件**——LAMMPS 的实际运行（`lmp -in in.xxx`）交给用户本机安装的 LAMMPS 执行。
**完整官方 LAMMPS 源码（src/ + doc/）已内置**在 `backplane/vendor/lammps-official/`，作为命令/势函数
语法的“反幻觉背板”。

## 交付契约（最高优先级，先读）

- **输出整体算例**：一次交付跑一个 MD 算例所需的**全部文件**（`in.*` 主脚本 + 按需的 `data.*`
  初始构型 + 势文件清单/获取说明），外加三份总览 `MANIFEST.md` / `ALGORITHM.md` / `TUNING.md`
  （模板见 `../_shared/OUTPUT_CONTRACT.md` 与 `templates/overviews/`）。
- **官方源码背板**：写任何 `pair_style`/`fix`/`compute`/`pair_coeff` 前，若不确定语法/参数，先按
  `backplane/SOURCE_MAP.md` 到 `vendor/lammps-official/src/` 或 `doc/src/` 打开对应命令源文件对齐。
  背板机制见 `../_shared/BACKPLANE.md`。
- **只生成、不代跑**：产出完整可读文件即完成；是否跑通由用户在 LAMMPS 上验证。

## 核心纪律（先读这段）

1. **三者必须自洽**：`units` ↔ `atom_style` ↔ `pair_style` ↔ `data 文件` 一环扣一环。
   - `units real` + 有机分子 → `atom_style full` + data 里有 Bonds/Angles/Dihedrals。
   - `units metal` + 金属 → `atom_style atomic` + EAM/MEAM 势。
   - `units lj` → 无量纲，教学/通用。
   - `units real` + ReaxFF → `atom_style charge`（带电荷列 q），data 里**不能有** Bonds 段。
   详见 `reference/input-script-anatomy.md`。
2. **timestep 与 units 量级匹配**（写错必飞）：`real`(fs) 有机 0.5–1、`metal`(ps) 1–2、
   `lj` 0.005、**ReaxFF 0.1–0.25 fs**。ReaxFF 写 ≥1fs 几乎必 Lost atoms。
3. **初始构型几乎总要先 `minimize`**，再 `run`：
   `minimize 1.0e-4 1.0e-6 1000 10000`。初始重叠是 Lost atoms 头号原因。
4. **`pair_coeff` 的元素映射列必须与 data 里的 atom type 顺序严格对应**（尤其 EAM/Tersoff/ReaxFF）。
   `pair_coeff * * ffield.reax.CHON C H O N` 里的元素顺序 = type 1,2,3,4。错位 = 参数用错原子。
5. **控温器别挂 `all`**（会把整体流向速度也当热运动扣掉）：流动/有定向速度的体系用
   `compute temp` 挂在去除质心/流向后的子 group，再 `fix ... temp` 引用它。
6. **写完 in.* 先做静态自检**（见 `reference/error-patterns.md` 的 12 类检查），再让用户短跑探针
   (`run 200` → `run 2000`) 验证动力学，最后才长跑。

## 标准工作流

### A. 从零搭建 MD 算例
1. **问清体系**：物质与元素、想要的系综(NVE/NVT/NPT)、温度/压力、是否反应(ReaxFF)、
   盒子与周期性、目标量（扩散系数/RDF/能量/应力…）。
2. **定 units + atom_style + pair_style**（三者联动，见纪律 1 与 `reference/force-fields.md`）。
3. **准备构型**：用 `lattice` + `region` + `create_atoms` 生成规则晶格；或 `read_data data.xxx`
   读外部构型（Packmol/Moltemplate/ASE 产出）。data 文件头见 `templates/data.header.example`。
4. **写 in.***：初始化 → 读/建构型 → 力场 → 邻居表 → minimize → velocity → fix(系综) →
   输出(thermo/dump) → run。用 `templates/` 里对应骨架改。
5. **输出**：`thermo_style custom step temp pe ke etotal press vol density`；
   `dump ... custom N dump.atom id type x y z` + `dump_modify sort id`。
7. **写三份总览**（MANIFEST/ALGORITHM/TUNING，模板见 `templates/overviews/`）。
8. **自检**：过一遍 error-patterns 的静态检查；提醒用户先 `run 200` 探针再长跑。

### B. ReaxFF 反应/热解/燃烧算例
见 `reference/reaxff-workflow.md`：`atom_style charge` + `pair_style reaxff`（旧版 `reax/c`）+
`fix qeq/reaxff` 电荷平衡 + timestep 0.1–0.25fs + 预松弛消重叠。选 ffield 见 `reference/force-fields.md`。

### C. 修改已有算例
1. 读 `in.*` 解析 units/atom_style/pair_style/fix/run，读 data 头确认 atom types 与是否含拓扑。
2. 只改相关行，保持三者自洽；改完过静态检查。

## 参考文件（按需读取）

- `reference/input-script-anatomy.md` — in.* 的 8 段结构、每段命令、units/atom_style 对照表。
- `reference/force-fields.md` — LJ/EAM/Tersoff/SW/ReaxFF/CHARMM/OPLS 选型 + pair_style/pair_coeff 写法 + ReaxFF ffield 目录。
- `reference/ensembles-thermostats.md` — NVE/NVT/NPT 与 Nosé-Hoover/Langevin/Berendsen，控温 group 陷阱。
- `reference/reaxff-workflow.md` — ReaxFF 完整脚手架、qeq、预松弛、软势消重叠、时间步。
- `reference/error-patterns.md` — LAMMPS 高频报错（Lost atoms / 拓扑不符 / 缺 pair_coeff / 势文件缺元素 等）与修法 + 12 类静态自检清单。

## 模板文件（可直接拷贝改数）

- `templates/in.lj_melt` — LJ 单位、lattice 建原子、NVT 熔化，最小可跑骨架。
- `templates/in.metal_eam` — metal 单位、EAM 金属、NPT，读 data 或 lattice。
- `templates/in.reaxff` — ReaxFF 反应力场完整流程（qeq + 预松弛 + NVT）。
- `templates/data.header.example` — data.* 文件头结构（原子数/类型/box/Masses/Atoms/Bonds 段）。
