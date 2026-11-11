# 算例文件总览: <案例名>

框架: LAMMPS
体系: <物质/元素，如 Cu 单晶 / PE 热解 / SPC/E 水>
目标: <一句话：求什么量，如 熔点/扩散系数/RDF/热解产物>

## 文件清单
| 文件 | 作用 | 关键内容 | 必需 |
| --- | --- | --- | --- |
| in.<name> | 主输入脚本 | units/atom_style/pair_style/fix/run | ✅ |
| data.<name> | 初始构型 | 盒子/原子/(拓扑) | 读外部构型时 |
| <ff>.eam.alloy / *.tersoff / ffield.reax.* | 势文件 | 从 LAMMPS potentials/ 获取 | 对应势 |
| dump.atom / log.lammps | 输出(运行产生) | 轨迹/热力学 | 运行后 |

## 目录结构树
```
<案例名>/
├── in.<name>
├── [data.<name>]
└── [势文件: 需从 LAMMPS potentials/ 获取]
```

## 运行顺序（用户本机执行，本 skill 不代跑）
```bash
lmp -in in.<name>                    # 串行
# mpirun -np N lmp -in in.<name>     # 并行
# 先 run 200 探针, 确认无 Lost atoms 再长跑
```

## 势文件获取说明
<注明每个势文件的官方名与来源，如: Cu_mishin1.eam.alloy 来自 LAMMPS potentials/ 目录>
