# 算例文件总览: <案例名>

框架: <自研 Python/NumPy | Palabos C++ | OpenLB C++>
格子/碰撞: <D2Q9-BGK | D3Q19-MRT | ...>
目标: <一句话：流动类型/Re/求什么量，如 Re=1000 顶盖方腔求稳态涡结构>

## 文件清单
| 文件 | 作用 | 关键内容 | 必需 |
| --- | --- | --- | --- |
| solver.py (或 main.cpp) | 求解器主程序 | 格子常数/init/collision/streaming/BC/收敛 | ✅ |
| params.py | 参数与单位换算 | Re, N, u_lb → nu_lb, tau | ✅ |
| postprocess.py | 后处理出图 | 速度/涡量场 → VTK/png | 推荐 |
| geometry / mask | 障碍/复杂几何掩码 | | 复杂几何 |
| Makefile / CMakeLists | 编译(C++框架) | | Palabos/OpenLB |

## 目录结构树
```
<案例名>/
├── solver.py (或 src/main.cpp)
├── params.py
├── postprocess.py
└── [geometry / Makefile]
```

## 运行顺序（用户本机执行，本 skill 不代跑）
```bash
# 自研 Python:
python params.py        # 查换算参数
python solver.py        # 运行, 输出场文件
python postprocess.py   # 出图/VTK

# Palabos/OpenLB (C++):
make        # 或 cmake . && make
./solver
```
