# MFiX 自定义 Fortran 源码植入 (usr*.f)

MFiX 允许在**算例目录**放同名 `usr*.f` 覆盖 `model/` 里的默认桩(stub)。`build_mfixsolver` 会优先编译
算例目录里的版本。本技能只生成源码文件，编译/运行由用户本机 MFiX 执行。

## 可覆盖的 usr 钩子（官方 model/ 里都有对应模板/桩）

| 文件 | 作用 | 官方参考(model/ 下) |
| --- | --- | --- |
| `usr0.f` / `usr1.f` | 初始化 / 每时间步开始的用户钩子 | `model/usr0.f`, `model/usr1.f` |
| `usr_drag.f` | 自定义气固曳力（`DRAG_TYPE='USER_DRAG'` 时调用） | `model/usr_drag.f` |
| `usr_rates.f` | TFM 均相/异相反应速率 | `model/usr_rates.f` |
| `usr_rates_des.f` | DEM 颗粒反应速率 | `model/des/usr_rates_des.f` |
| `usr_properties.f` | 变物性(密度/粘度/比热/导热/扩散) | `model/usr_properties.f` |
| `usr_mod.f` (usr) | 用户全局变量模块 | `model/usr_mod.f` |
| `write_usr0/1.f` | 自定义输出 | `model/write_usr1.f` |

## 植入流程（强制走背板）

1. **查 `backplane/SOURCE_MAP.md`** 找到对应 usr 桩与它调用/被调用的官方 subroutine。
2. 在 `vendor/MFiX/model/`（或本机 MFiX 安装的 model/）`read_file` 打开该桩，看它的：
   - `SUBROUTINE` 签名与参数（哪些 in/out）；
   - `USE` 的模块(如 `fldvar`, `physprop`, `constant`, `run`, `indices`, `compar`)——这些是访问场变量的入口；
   - 循环宏(`IJK` 索引、`DO IJK = IJKSTART3, IJKEND3`)与函数(`FUNIJK`, `FLUID_AT(IJK)`)。
3. **照桩的骨架写**，只填物理公式；模块名/参数名/索引宏逐字对齐官方，禁止杜撰。
4. 在 `ALGORITHM.md` 标注参照的官方源码路径。

## usr_drag.f 骨架（照官方接口）

```fortran
!  usr_drag.f — 自定义曳力系数; DRAG_TYPE = 'USER_DRAG' 时被 drag_gs 调用
!  官方参考: model/usr_drag.f (桩) + model/drag_gs.f (调用点/参数含义)
      SUBROUTINE DRAG_USR(IJK, M, lDgA, EPg, Mug, ROg, VREL, DPM, ROs, lUg,lVg,lWg, lUs,lVs,lWs)
      USE param
      USE param1
      USE constant     ! Pi 等常数
      IMPLICIT NONE
      INTEGER, INTENT(IN) :: IJK, M          ! 网格索引, 固相编号
      DOUBLE PRECISION, INTENT(OUT):: lDgA   ! 输出: 曳力系数 (per unit volume) beta = lDgA
      DOUBLE PRECISION, INTENT(IN) :: EPg    ! 气相空隙率
      DOUBLE PRECISION, INTENT(IN) :: Mug    ! 气相粘度
      DOUBLE PRECISION, INTENT(IN) :: ROg    ! 气相密度
      DOUBLE PRECISION, INTENT(IN) :: VREL   ! |Ug - Us| 相对速度模
      DOUBLE PRECISION, INTENT(IN) :: DPM    ! 颗粒直径
      DOUBLE PRECISION, INTENT(IN) :: ROs
      DOUBLE PRECISION, INTENT(IN) :: lUg,lVg,lWg, lUs,lVs,lWs
!     --- 局部变量 ---
      DOUBLE PRECISION :: Re, Cd, EPs
      EPs = ONE - EPg
!     示例: Wen-Yu 型 (请按你的模型替换)
      Re = EPg * ROg * VREL * DPM / (Mug + SMALL_NUMBER)
      IF (Re < 1000.0d0) THEN
         Cd = 24.0d0/(Re+SMALL_NUMBER)*(ONE + 0.15d0*Re**0.687d0)
      ELSE
         Cd = 0.44d0
      ENDIF
!     beta (interphase momentum exchange coeff), 单位与官方一致:
      lDgA = 0.75d0 * Cd * EPs * EPg * ROg * VREL / DPM * EPg**(-2.65d0)
      RETURN
      END SUBROUTINE DRAG_USR
```
> ⚠ 上面的参数列表与官方版本会随 MFiX 版本微调——**务必打开你那版的 `model/usr_drag.f` 核对签名**，
> 以官方为准。这里给的是结构与物理，签名以背板为准。

## usr_rates.f 骨架（反应速率）

```fortran
!  官方参考: model/usr_rates.f + tutorials 里带化学的算例
      SUBROUTINE USR_RATES(IJK, RATES)
      USE param, only: DIMENSION_LM
      USE rxns, only: NO_OF_RXNS
      USE fldvar     ! EP_g, ROP_s, T_g, X_g, ...
      USE physprop
      USE indices
      USE compar
      IMPLICIT NONE
      INTEGER, INTENT(IN) :: IJK
      DOUBLE PRECISION, INTENT(OUT) :: RATES(NO_OF_RXNS)
!     示例: Arrhenius k = A*exp(-E/RT) * [反应物浓度]
!     (按 reactions 段里定义的反应编号填 RATES(rxn_id))
      RATES(:) = ZERO
!     RATES(1) = ...
      RETURN
      END SUBROUTINE USR_RATES
```

## 编译（用户本机执行，本 skill 不代跑）

```bash
cd <case_dir>          # usr*.f 与 .mfx 同目录
build_mfixsolver        # 检测到算例目录的 usr*.f 会一并编译成定制 mfixsolver
# 运行:
./mfixsolver -f <project>.mfx        # 串行
mpirun -np N ./mfixsolver -f <project>.mfx   # 并行
```
