# MFiX 求解模式与子模型选型

## 三种气固求解模式

| 模式 | 全称 | 颗粒描述 | 适用 | 关键 keyword | 代价 |
| --- | --- | --- | --- | --- | --- |
| **TFM** | Two-Fluid Model（欧拉-欧拉） | 颗粒当拟流体(连续相) | 稠密、大规模、工业尺度、不关心单颗粒 | `SOLIDS_MODEL(1)='TFM'`、`MMAX`、`KT_TYPE`、`EP_STAR`、`FRICTION` | 低-中 |
| **DEM** | Discrete Element Method（欧拉-拉格朗日） | 逐颗粒牛顿方程+碰撞 | 中等颗粒数(1e3–1e7)、碰撞细节、非球/粘结/传热 | `SOLIDS_MODEL(1)='DEM'`、`PARTICLES`、`KN`/`KT_FAC`、`DES_EN_INPUT`、`DES_INTERP_ON` | 高 |
| **PIC** | MP-PIC / CGP（粗粒化包裹粒） | parcel 统计代表多颗粒 | 海量颗粒、工业规模、可接受统计近似 | `SOLIDS_MODEL(1)='PIC'`、统计权重、`PIC` 相关参数 | 中 |

选型口诀：**要单颗粒细节→DEM；要工业大规模稠密→TFM；海量颗粒又要拉格朗日味道→PIC**。

## TFM 必配子模型

- **曳力 DRAG_TYPE**（见下表）。
- **颗粒动理学 KT_TYPE**：`ALGEBRAIC`（代数,快）/ `LUN_1984` / `IA_NONEP` / `GHD`（多分散） /
  `GD_99`。决定颗粒相"温度"(granular temperature)与固相应力。
- **摩擦应力 FRICTION**：稠密堆积区的摩擦（`FRICTION=.TRUE.` + `SCHAEFFER` 或 `PRINCETON`）。
- **最大堆积** `EP_STAR`（最大堆积空隙率，典型 0.42，即堆积分数 0.58）。
- **固相壁面** Johnson-Jackson 部分滑移 `BC_JJ_PS`。

## DEM 必配

- 碰撞模型：线性弹簧-阻尼(LSD, `DES_COLL_MODEL='LSD'`)或 Hertz-Mindlin(`'HERTZIAN'`)。
- 刚度 `KN`(法向)/`KT_FAC`(切向比)、恢复系数 `DES_EN_INPUT`(相间)/`DES_EN_WALL_INPUT`(壁面)、
  摩擦系数 `MEW`/`MEW_W`。
- 颗粒-流体耦合插值 `DES_INTERP_ON=.TRUE.` + `DES_INTERP_SCHEME`(如 `'LINEAR_HAT'`/`'GARG_2012'`)。
- 初始颗粒：`particle_input.dat`（外部给）或 `GENER_PART_CONFIG=.TRUE.`（按 IC 自动生成）。
- 碰撞时间步 `DES_MIN_DT` 由 Rayleigh 时间/接触刚度定，通常 << 流体 DT，用子循环。

## PIC 必配

- `SOLIDS_MODEL(1)='PIC'`；parcel 统计权重、固相应力模型(如 `PIC_...` 参数)、
  最大堆积与滑移的经验闭合。适合快速工业尺度，牺牲颗粒级精度。

## 曳力模型 DRAG_TYPE 速查

| 值 | 适用 | 说明 |
| --- | --- | --- |
| `SYAM_OBRIEN` | 通用,可调 | 需 `DRAG_C1`/`DRAG_D1` 调参 |
| `GIDASPOW` | 鼓泡/稠密流化床(经典默认) | Ergun+Wen-Yu 分段 |
| `GIDASPOW_BLEND` | 同上,分段平滑 | 消除 EP=0.8 处不连续 |
| `WEN_YU` | 稀相 | |
| `BVK` | Beetstra-van der Hoef-Kuipers,基于 lattice-Boltzmann 拟合 | 多分散较好 |
| `HYS` | Yin-Sundaresan | |
| `KOCH_HILL` | 低 Re 悬浮 | |
| `USER_DRAG` | 自定义 | 写 `usr_drag.f`（见 custom-fortran.md + SOURCE_MAP） |

## 化学反应 / 传热

- 能量方程：`ENERGY_EQ=.TRUE.`，给各相 `IC_T_*`/`BC_T_*`、比热/导热(物性或 usr_properties)。
- 组分：`SPECIES_EQ(0:MMAX)=.TRUE. ...`，定义 `NMAX`、组分名、`MW`；反应速率写 `usr_rates.f`
  （异相反应 `usr_rates_des.f`）。机理与热力学数据 `mfix.dat` 的 THERMO DATA 段或 `species.inc`。
