!----------------------------------------------------------------------!
!  usr_drag.f — 自定义气固曳力系数骨架                                   !
!  放在算例目录, build_mfixsolver 会覆盖 model/usr_drag.f 默认桩          !
!  DRAG_TYPE = 'USER_DRAG' 时被 drag_gs 调用                             !
!                                                                       !
!  ⚠ 参数列表随 MFiX 版本会微调 —— 提交前必须打开你那版的                  !
!     vendor/MFiX/model/usr_drag.f 核对 SUBROUTINE 签名, 以官方为准。       !
!----------------------------------------------------------------------!
      SUBROUTINE DRAG_USR(IJK, M, lDgA, EPg, Mug, ROg, VREL, DPM, ROs, &
                          lUg, lVg, lWg, lUs, lVs, lWs)
      USE param
      USE param1
      USE constant
      IMPLICIT NONE
!     ---- arguments ----
      INTEGER, INTENT(IN)          :: IJK    ! fluid cell index
      INTEGER, INTENT(IN)          :: M      ! solids phase index
      DOUBLE PRECISION, INTENT(OUT):: lDgA   ! OUT: drag coeff beta (per volume)
      DOUBLE PRECISION, INTENT(IN) :: EPg    ! gas voidage
      DOUBLE PRECISION, INTENT(IN) :: Mug    ! gas viscosity
      DOUBLE PRECISION, INTENT(IN) :: ROg    ! gas density
      DOUBLE PRECISION, INTENT(IN) :: VREL   ! |Ug - Us|
      DOUBLE PRECISION, INTENT(IN) :: DPM    ! particle diameter
      DOUBLE PRECISION, INTENT(IN) :: ROs
      DOUBLE PRECISION, INTENT(IN) :: lUg, lVg, lWg, lUs, lVs, lWs
!     ---- locals ----
      DOUBLE PRECISION :: Re, Cd, EPs
!-----------------------------------------------------------------------
      EPs = ONE - EPg

!     particle Reynolds number
      Re = EPg * ROg * VREL * DPM / (Mug + SMALL_NUMBER)

!     ---- 示例: Wen-Yu 单颗粒阻力 + 空隙率修正 (请替换成你的模型) ----
      IF (Re < 1000.0D0) THEN
         Cd = 24.0D0 / (Re + SMALL_NUMBER) * (ONE + 0.15D0 * Re**0.687D0)
      ELSE
         Cd = 0.44D0
      ENDIF

!     interphase momentum exchange coefficient beta = lDgA
      lDgA = 0.75D0 * Cd * EPs * EPg * ROg * VREL / DPM * EPg**(-2.65D0)

      RETURN
      END SUBROUTINE DRAG_USR
