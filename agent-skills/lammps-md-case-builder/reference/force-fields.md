# LAMMPS 力场 (pair_style) 选型与写法

选力场 = 定 units + atom_style + pair_style + pair_coeff + 势文件。四者必须一致。

## 常见 pair_style 速查

| pair_style | units | atom_style | 适用 | pair_coeff 写法 |
| --- | --- | --- | --- | --- |
| `lj/cut 2.5` | lj | atomic | 通用/教学 LJ | `pair_coeff 1 1 1.0 1.0`（eps sigma） |
| `lj/cut/coul/long 10 10` | real | full/charge | 分子+库仑 | `pair_coeff i j eps sigma` + `kspace_style pppm 1e-4` |
| `eam/alloy` | metal | atomic | 金属合金 | `pair_coeff * * Cu.eam.alloy Cu`（元素映射列=type） |
| `eam/fs` | metal | atomic | Finnis-Sinclair 金属 | `pair_coeff * * FeCr.eam.fs Fe Cr` |
| `tersoff` | metal | atomic | 共价（Si/C/SiC/BN） | `pair_coeff * * SiC.tersoff Si C` |
| `sw` | metal | atomic | Stillinger-Weber（Si/水粗粒化 mW） | `pair_coeff * * Si.sw Si` |
| `meam/c` | metal | atomic | 修正 EAM（更广元素） | `pair_coeff * * library.meam El1 El2 El.meam El1 El2` |
| `reaxff` (新) / `reax/c`(旧) | real | charge | 反应/热解/燃烧 | `pair_coeff * * ffield.reax.CHON C H O N` + `fix qeq/reaxff` |
| `airebo 3.0` | metal | atomic | 碳氢（石墨烯/PAH） | `pair_coeff * * CH.airebo C H` |
| `comb3` | metal | charge | 氧化物界面变价 | `pair_coeff * * ffield.comb3 El...` |
| `harmonic/cut` / `morse` | any | atomic | 简单成键/双原子 | 按 style 文档 |
| `gran/hertz/history` | si | sphere | 颗粒 DEM | 按颗粒参数 |

## 分子力场（CHARMM / OPLS / AMBER，全原子有机/生物）

- `units real` + `atom_style full` + data 含 Bonds/Angles/Dihedrals/Impropers + q。
- 键合项：`bond_style harmonic`、`angle_style harmonic`、`dihedral_style opls/harmonic/charmm`、
  `improper_style ...`（由力场决定；CHARMM 用 `charmm` 系列，OPLS 用 `opls`）。
- 非键：`pair_style lj/cut/coul/long 10 10` + `kspace_style pppm 1e-4` +
  `special_bonds`（CHARMM `0.0 0.0 1.0`；OPLS/AMBER `0.0 0.0 0.5`，1-4 缩放！写错静电全乱）。
- data 与拓扑通常由 **Moltemplate / VMD-topotools / ligpargen(OPLS) / CHARMM-GUI** 生成，
  本技能生成 in.* 的力场引用与运行段。

## ReaxFF ffield 力场文件选择（元素体系决定）

ReaxFF 势文件形如 `ffield.reax.<体系>`，`pair_coeff * * ffield.reax.X <元素列表>` 的元素顺序
= data 里的 atom type 顺序。常见体系（来自 NullFlux/MDriver 实战目录）：

| ffield | 元素 | 适用 |
| --- | --- | --- |
| `ffield.reax.CHO` | C H O | 烃类燃烧、热解（经典 Chenoweth 2008） |
| `ffield.reax.CHON` | C H O N | 含氮聚合物、含能材料（Liu 2010） |
| `ffield.reax.CHONS` | C H O N S | 含硫聚合物、橡胶、煤热解（Kamat 2014） |
| `ffield.reax.AuCHO` | Au C H O | 金催化界面 CHO |
| `ffield.reax.FeOCHN` | Fe O C H N | 铁氧化物+有机（腐蚀/催化） |
| `ffield.reax.SiOH` | Si O H | 硅氧水（玻璃/沸石/水合） |

**选错 ffield（缺元素）→ `reaxff: atom X has no parameters`**。先按体系里出现的所有元素挑
覆盖全的 ffield，再核对 `pair_coeff` 末尾元素列与 atom type 一一对应。

## 势文件在哪找

- LAMMPS 安装目录 `potentials/`（EAM/Tersoff/SW/ReaxFF 官方势）。
- `examples/` 与 `bench/` 里有各 pair_style 的真实可跑样例——**照抄它的 pair_coeff 写法最稳**，
  不要凭记忆写参数个数/顺序（`Incorrect args for pair coefficients` 就是这么来的）。

## 写 pair_coeff 的通用铁律

1. 元素映射列的个数 = 体系 atom type 数，顺序 = type 1,2,3…。
2. 多体势（EAM/Tersoff/SW/ReaxFF）几乎都是 `pair_coeff * * <势文件> <元素列表>`。
3. 两体势（lj/morse）按 `pair_coeff i j <参数...>`，`i j` 可用 `*` 通配。
4. `hybrid`/`hybrid/overlay` 时每个子 style 都要各自 `pair_coeff`，且需 `pair_style hybrid ...` 先声明。
