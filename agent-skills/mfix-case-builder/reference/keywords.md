# MFiX keyword 速查 (.mfx / mfix.dat)

`.mfx`（GUI 新格式）与旧 `mfix.dat` 的 keyword 相同，语法 `KEYWORD = value`。相/BC/IC 用括号索引，从 1 起。
单位默认 SI。字符串加引号。逻辑值 `.TRUE.`/`.FALSE.`。

## Run 控制
```
RUN_NAME = 'FB2D'
DESCRIPTION = '2D bubbling fluidized bed'
UNITS = 'SI'
RUN_TYPE = 'NEW'          # NEW / RESTART_1(续算) / RESTART_2
TIME  = 0.0
TSTOP = 2.0               # 物理终止时间 s
DT    = 1.0E-3            # 初始时间步
DT_MIN = 1.0E-7
DT_MAX = 1.0E-2
ENERGY_EQ = .FALSE.       # 是否解能量方程(传热)
SPECIES_EQ(0:1) = .FALSE. .FALSE.   # 各相组分方程(0=气相,1=固相1)
```

## 几何 / 网格
```
COORDINATES = 'CARTESIAN'      # 或 'CYLINDRICAL'
XLENGTH = 0.20   IMAX = 20     # x 向物理长度 + 网格数
YLENGTH = 1.00   JMAX = 100
ZLENGTH = 0.01   KMAX = 1      # 2D 时 KMAX=1, NO_K=.TRUE.
NO_K = .TRUE.
# 复杂几何(cut-cell): CARTESIAN_GRID=.TRUE. + N_QUADRIC 或 STL(USE_STL=.TRUE.)
```

## 气相物性 (相 0)
```
RO_G0 = 1.2            # 气体密度 kg/m3 (常数); 变密度用理想气体则设 MW_AVG 等
MU_G0 = 1.8E-5         # 气体动力粘度 Pa·s
MW_AVG = 29.0          # 平均分子量(理想气体密度用)
```

## 固相物性 (颗粒相, MMAX 个)
```
MMAX = 1               # 固相数
RO_S0(1) = 2500        # 颗粒真密度 kg/m3
D_P0(1)  = 5.0E-4      # 颗粒直径 m (500 μm)
# TFM 颗粒相还需颗粒动理学(见 solids-models.md): KT_TYPE, FRICTION, EP_STAR
EP_STAR = 0.42         # 最大堆积空隙率(1 - 最大堆积分数)
```

## 求解模式 + 曳力
```
SOLIDS_MODEL(1) = 'TFM'    # 'TFM' / 'DEM' / 'PIC'
DRAG_TYPE = 'GIDASPOW'     # SYAM_OBRIEN/GIDASPOW/WEN_YU/BVK/HYS/USER_DRAG...
# DEM 追加: DES_INTERP_ON=.TRUE., DES_INTERP_SCHEME='LINEAR_HAT',
#           KN=... KT_FAC=... DES_EN_INPUT=... (碰撞刚度/恢复系数), PARTICLES=N
# PIC 追加: SOLIDS_MODEL(1)='PIC', 相关统计权重参数
```

## 边界条件 BC_（每个 BC_ID 一组，覆盖所有边界）
```
# 入口(气体分布板): 质量入口
BC_TYPE(1) = 'MI'                 # MI=质量入口 / PO=压力出口 / NSW=无滑移壁 / FSW=自由滑移 / PI=压力入口
BC_X_W(1)=0.0  BC_X_E(1)=0.20     # 该 BC 覆盖的空间范围
BC_Y_S(1)=0.0  BC_Y_N(1)=0.0
BC_EP_G(1) = 1.0                  # 入口空隙率(纯气)
BC_U_G(1) = 0.0   BC_V_G(1) = 0.25  # 气速分量 m/s (表观气速)
BC_P_G(1) = 101325.0
BC_T_G(1) = 300.0                 # 能量方程开时
# 出口: 压力出口
BC_TYPE(2) = 'PO'
BC_X_W(2)=0.0 BC_X_E(2)=0.20 BC_Y_S(2)=1.0 BC_Y_N(2)=1.0
BC_P_G(2) = 101325.0
# 侧壁: 无滑移(气) / 部分滑移(固)
BC_TYPE(3) = 'NSW'
BC_X_W(3)=0.0 BC_X_E(3)=0.0 BC_Y_S(3)=0.0 BC_Y_N(3)=1.0
BC_JJ_PS(3) = 0                   # Johnson-Jackson 部分滑移(固相壁面)
```

## 初始条件 IC_（每个 IC 区一组，覆盖整个域）
```
# 初始床层(下部装料)
IC_X_W(1)=0.0 IC_X_E(1)=0.20 IC_Y_S(1)=0.0 IC_Y_N(1)=0.40
IC_EP_G(1) = 0.42                 # 床内空隙率(=1-堆积分数)
IC_U_G(1)=0.0 IC_V_G(1)=0.0
IC_ROP_S(1,1) = 1450              # 或用 IC_EP_S(1,1)
IC_U_S(1,1)=0.0 IC_V_S(1,1)=0.0
IC_T_G(1)=300.0
# 上部自由空间(纯气)
IC_X_W(2)=0.0 IC_X_E(2)=0.20 IC_Y_S(2)=0.40 IC_Y_N(2)=1.0
IC_EP_G(2)=1.0
IC_U_G(2)=0.0 IC_V_G(2)=0.0
```

## 数值 / 求解控制
```
MAX_NIT = 50                      # 每步最大迭代
TOL_RESID = 1.0E-3                # 残差判据
NORM_G = 0                        # 归一化
LEQ_METHOD(1) = 2   LEQ_SWEEP(1) = 'ISIS'
DISCRETIZE(1:9) = 9*2             # 2=一阶迎风起步; 高阶=Superbee(3)/SMART 等
UR_FAC(1) = 0.8                   # 松弛因子
```

## 输出
```
RES_DT = 0.01          # restart 文件写出间隔
SPX_DT(1:9) = 9*0.05   # 旧 SPx 输出(legacy)
# VTK 输出(推荐, ParaView 可读):
WRITE_VTK_FILES = .TRUE.
VTK_DT = 0.02
VTK_VAR(1)=1 VTK_VAR(2)=2 ...     # 输出哪些变量(EP_g/P_g/U_g/U_s...)
```

## BC_TYPE 速查
| 值 | 含义 |
| --- | --- |
| `MI` | 质量入口(给速度/空隙率/温度/组分) |
| `PI` | 压力入口 |
| `PO` | 压力出口(给 P_g) |
| `MO` | 质量出口 |
| `NSW` | 无滑移壁 |
| `FSW` | 自由滑移壁 |
| `PSW` | 部分滑移壁(配 BC_JJ_PS / BC_HW) |
| `CG_NSW` 等 | cut-cell 几何对应壁面 |
