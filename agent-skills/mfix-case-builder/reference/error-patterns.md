# MFiX 高频报错与调优

运行由用户本机 MFiX 执行。下表帮你在写输入卡时规避，以及读 .LOG/.OUT 报错时定位。

## 输入卡 / 启动期报错

- **`Error: BC_TYPE not specified for BC N` / `Undefined BC`**
  - 因：某 BC_ID 缺 `BC_TYPE` 或缺该类型必需的场。
  - 修：每个 BC_ID 给全 `BC_TYPE` + 入口(速度/EP_G/T/组分)或出口(P_G)；范围 BC_X/Y/Z 覆盖真实边界面。

- **`IC region not covering domain` / 初始条件未覆盖**
  - 因：IC 区没铺满整个计算域。
  - 修：IC 区并集 = 整个 [0,XLENGTH]×[0,YLENGTH]×[0,ZLENGTH]；床层区+自由空间区拼满。

- **相索引 / MMAX 不一致**
  - 因：用了 `IC_ROP_S(1,2)` 但 `MMAX=1`；或 `SOLIDS_MODEL(2)` 越界。
  - 修：相索引 ≤ MMAX；气相是 0，固相 1..MMAX。

- **单位混用 / 数量级离谱**
  - 因：CGS 值写进 SI（如 MU_G 写 1.8e-4 poise 而非 1.8e-5 Pa·s）。
  - 修：`UNITS='SI'` 下全用 kg/m/s/K/Pa。

## 运行期发散 / 物理异常

- **`EP_g < 0` 或 `EP_g > 1`（空隙率越界）→ 发散**
  - 因：DT 过大 / 曳力过强 / 初始堆积>最大堆积 / 数值格式过激进。
  - 修：减小 `DT`（用 `DT_MAX/DT_MIN` 自适应）；`IC_EP_G ≥ EP_STAR`；`DISCRETIZE` 起步用一阶(2)；
    松弛 `UR_FAC` 调小；曳力换 `GIDASPOW_BLEND` 消不连续。

- **压力/速度不收敛，`MAX_NIT` 用满残差不降**
  - 修：增大 `MAX_NIT`；`NORM_G=0`；减小 DT；检查 BC 是否物理（入口气速是否远超 U_mf）。

- **床层"喷飞"/整体上抛**
  - 因：入口表观气速远超颗粒终端速度/最小流化速度 U_mf。
  - 修：核对 U_mf（Wen-Yu/Ergun 估）与 U_t；入口 `BC_V_G` 设为 1–5×U_mf 合理区间。

## DEM 专属

- **颗粒初始重叠 → 力爆 / 颗粒飞散**
  - 修：`GENER_PART_CONFIG` 自动生成时降初始堆积；或外部 `particle_input.dat` 保证不重叠；
    起步先小 `DES_EN_INPUT`（低恢复系数耗散）预平衡。

- **碰撞时间步过大 → 穿透**
  - 修：`DES_MIN_DT` 按 Rayleigh/接触时间 (∝ sqrt(m/KN)) 取 1/20~1/50；或降 `KN`（软化，注意过软失真）。

- **颗粒-流体耦合噪声**
  - 修：`DES_INTERP_ON=.TRUE.` + 合适 `DES_INTERP_SCHEME`（`GARG_2012`/`LINEAR_HAT`）。

## 调优方向

- **网格无关性**：IMAX/JMAX 加密对比床层膨胀高度/压降，变化<5% 即够。
- **时间步**：气固强耦合优先自适应 `DT_MAX/DT_MIN`，跟 CFL 与耦合稳定性。
- **曳力选择**：鼓泡稠密床首选 `GIDASPOW(_BLEND)`；稀相/输运用 `WEN_YU`；多分散用 `BVK`。
- **KT_TYPE**：快速起步 `ALGEBRAIC`；要精度/多分散用 `GHD`/`LUN_1984`。
- **并行**：`NODESI/NODESJ/NODESK` 域分解与 `mpirun -np` 一致。

## 物理合理性自查清单
- [ ] BC 覆盖所有边界面，每个 BC_TYPE 的必需场齐全
- [ ] IC 区并集铺满整域，`IC_EP_G ≥ EP_STAR`
- [ ] 相索引 ≤ MMAX，单位 SI
- [ ] 入口气速在 U_mf~U_t 合理区间
- [ ] DEM: 无初始重叠，碰撞时间步足够小
- [ ] 输出(VTK/RES/SPX)频率能覆盖关注的瞬态现象
