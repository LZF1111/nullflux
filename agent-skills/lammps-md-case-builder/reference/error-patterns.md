# LAMMPS 高频报错模式与静态自检

运行由用户本机 LAMMPS 执行。下表帮你在写 in.* 时规避，以及读到 log 报错时快速定位。

## 写完 in.* 的 12 类静态自检（零成本，先过一遍）

1. `units` / `atom_style` / `pair_style` 三者一致（见 force-fields.md 对照表）。
2. `pair_coeff` 元素映射列个数 = data 的 atom types 数，顺序对应 type 1,2,3…。
3. 势文件（.eam/.tersoff/.sw/ffield.reax.*）路径存在（在 case 目录或 potentials/）。
4. `read_data` 指向的 data 文件存在。
5. `pair_coeff` 出现在 `pair_style` **之后**，且在 read_data/create_box 之后。
6. ReaxFF：有 `pair_style reaxff|reax/c` 就必须有 `fix ... qeq/reaxff|qeq/reax`。
7. NPT/NVT 前有 `timestep`，且量级与 units 匹配（real fs / metal ps / lj τ）。
8. `atom_style charge|full` 时 data 的 Atoms 段每行有 q 列（列数对）。
9. `atom_style full|molecular|bond` 时 data 有 Bonds 段；`atomic|charge` 时**没有** Bonds 段。
10. `boundary` 三维都写了（缺省全 p，但显式更安全）；非周期 f 维度考虑 `fix wall/reflect`。
11. 初始构型有 `minimize`（或 soft pushoff）消重叠。
12. `velocity ... create` 有 `mom yes`（去质心漂移）。

## 高频报错（log 里出现时对症下药）

- **`Lost atoms: original N current M`** —— 最常见的崩溃
  - 因：① 初始重叠（势能爆→飞出）；② timestep 太大；③ 边界 f 没 wall 兜住；④ 没 velocity create；
    ⑤ region 用真实单位写，盒子非 lattice 整数倍切掉表层原子。
  - 修：**先 `minimize 0 1e-8 1000 10000` 再 run**；timestep 降档（ReaxFF 0.25fs / LJ 0.005 / real 0.5-1 / metal 1-2）；
    流-壁体系 `boundary p p f` + `fix wall/reflect`；`velocity all create T seed mom yes rot yes`。

- **`Bonds section not allowed / Bonds defined but no bond types`**
  - 因：`atom_style atomic|charge` 却读了含 Bonds 的 data（ReaxFF 用 charge 却给了拓扑）。
  - 修：ReaxFF 用 `atom_style charge` + data 无 Bonds；有机分子改 `atom_style full`。

- **`Incorrect atom format in data file`**
  - 因：data 的 Atoms 段列数与 atom_style 期望不符。
  - 修：`atomic`=`id type x y z`；`charge`=`id type q x y z`；`full`=`id mol type q x y z`。

- **`No pair coefficients set` / `Incorrect args for pair coefficients`**
  - 因：`pair_coeff` 缺失/被注释；参数个数或顺序与 pair_style 不匹配。
  - 修：每种 type-pair 都要 pair_coeff；照 `examples/` 里该 style 的真实样例写；hybrid 每子 style 都要设。

- **`Unknown pair_style X` / `Unknown fix style X`**
  - 因：对应包没编译进 LAMMPS（如 REAXFF / MANYBODY / MOLECULE 包）。
  - 修：`lmp -h | grep -i <style>` 查可用；让用户重编译加对应包。

- **`reaxff: atom X has no parameters`（或 Reaxff:...has no...parameters）**
  - 因：ffield.reax.* 缺该元素；或 pair_coeff 末尾元素列顺序错。
  - 修：换覆盖全元素的 ffield（见 force-fields.md 表）；核对 `pair_coeff * * ffield C H O N` 元素列与 type 对应。

- **`Out of range atoms - cannot compute PPPM`**
  - 因：原子飞出 box；周期性设置错；timestep 过大。
  - 修：检查 boundary 周期；减小 timestep 或先 minimize；`velocity ... zero linear/angular`。

- **`Bond atoms ... missing` / `Angle atoms missing`**
  - 因：communication cutoff 不够；原子飞出；data 键拓扑不一致。
  - 修：`neighbor` 调大 / `comm_modify cutoff N`；minimize 后再 run；核对 data 的 bond topology。

- **`Cannot open file ...`**
  - 因：路径错或文件未生成；cwd 不对。
  - 修：确认势文件/data 文件在 case 目录；用相对 case 的路径运行。

- **`Cannot use neighbor bins - box size << cutoff` / `Domain too large for neighbor bins`**
  - 因：box 比 cutoff 还小，或 box 异常大/维度错。
  - 修：增大 box 或减小 cutoff / `neighbor ... nsq`；`change_box` 调整；查 displace_atoms 是否漂移。

- **`Inconsistent image flags`**
  - 因：data 的 image flag 与位置不符。
  - 修：`reset_atoms image all`。

- **`Atom IDs must be consecutive`**
  - 因：delete_atoms 后 ID 不连续。
  - 修：`reset_atoms id sort yes`。

- **温度算错 / 体系"莫名升温"**
  - 因：控温器挂在含定向速度的 `all` 上；或 Langevin 忘配 nve。
  - 修：见 ensembles-thermostats.md 的控温 group 陷阱；Langevin/Berendsen 必须再加 `fix nve`。

## 渐进验证（别一上来就长跑）

`run 0`（纯语法/力场校验，最快）→ `run 200`（探针：看 temp/pe 有没有 NaN、Lost atoms、能量突变）→
`run 2000`（趋势稳不稳）→ 长跑。能在 200 步内发现 90% 的动力学问题，省算力。
读 log 的 `ERROR` 行通常紧跟 `Last command:`——先看它定位是哪条命令出错。
