# 算例文件总览: <案例名>

框架: MFiX 24.x
求解模式: <TFM | DEM | PIC>
目标: <一句话：床型/工况/求什么量，如 2D 鼓泡床求床层膨胀高度与压降>

## 文件清单
| 文件 | 作用 | 关键 keyword/内容 | 必需 |
| --- | --- | --- | --- |
| project.mfx (或 mfix.dat) | 主输入卡 | RUN/几何/物性/BC_/IC_/数值/输出 | ✅ |
| usr_drag.f | 自定义曳力 | DRAG_USR | 仅 USER_DRAG |
| usr_rates.f | 反应速率 | USR_RATES | 仅化学反应 |
| usr_properties.f | 变物性 | | 仅变物性 |
| particle_input.dat | DEM 初始颗粒 | id,type,x,y,z,r,ρ,vx,vy,vz | DEM(非自动生成时) |
| geometry.stl | cut-cell 几何 | | 复杂几何 |
| species.inc / THERMO DATA | 组分/热力学 | | 化学/传热 |

## 目录结构树
```
<案例名>/
├── <name>.mfx
├── [usr_drag.f / usr_rates.f / usr_properties.f]
├── [particle_input.dat]
└── [geometry.stl]
```

## 使用/编译顺序（用户本机 MFiX 执行，本 skill 不代跑）
```bash
cd <案例名>
build_mfixsolver            # 若有 usr*.f 会一并编译
./mfixsolver -f <name>.mfx              # 串行
# mpirun -np N ./mfixsolver -f <name>.mfx   # 并行(需 NODESI/J/K)
# ParaView 打开 VTK 输出后处理
```
