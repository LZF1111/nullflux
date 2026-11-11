#!/usr/bin/env python3
"""
快速检查 case_template 完整性：
  1. 列出所有文件
  2. 检查 blockMeshDict 顶点数和区块数
  3. 检查 0/ 目录包含必需场文件
  4. 检查 seeds 通过 zone_eval
"""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, 'case_template')

print("=== case_template 文件清单 ===")
for root, dirs, files in os.walk(TEMPLATE):
    dirs.sort()
    for f in sorted(files):
        rel = os.path.relpath(os.path.join(root, f), TEMPLATE)
        print(f"  {rel}")

print()
print("=== blockMeshDict 检查 ===")
bmd = open(os.path.join(TEMPLATE, 'system', 'blockMeshDict')).read()
verts = re.findall(r'\(\s*[-\d.]+\s+[-\d.]+\s+[-\d.]+\s*\)', bmd)
blocks = re.findall(r'\bhex\b', bmd)
patches = re.findall(r'\b(zone\d_inlet|outlet|left_wall|right_wall|front|back)\b', bmd)
print(f"  Vertices found  : {len(verts)}  (expect 16)")
print(f"  hex blocks      : {len(blocks)}  (expect 3)")
print(f"  Boundary patches: {sorted(set(patches))}")

print()
print("=== 0/ 场文件检查 ===")
required = ['alpha.air', 'U.air', 'U.water', 'p_rgh', 'k.water', 'epsilon.water', 'k.air', 'epsilon.air']
zero_dir = os.path.join(TEMPLATE, '0')
present = os.listdir(zero_dir)
for f in required:
    status = "OK" if f in present else "MISSING"
    print(f"  {f:25s} {status}")

print()
print("=== constant/ 文件检查 ===")
req_const = ['phaseProperties', 'transportProperties', 'g',
             'turbulenceProperties.air', 'turbulenceProperties.water']
const_dir = os.path.join(TEMPLATE, 'constant')
present_c = os.listdir(const_dir)
for f in req_const:
    status = "OK" if f in present_c else "MISSING"
    print(f"  {f:40s} {status}")

print()
print("=== Seeds 验证 ===")
sys.path.insert(0, HERE)
import zone_eval as ZE, importlib.util
seed_dir = os.path.join(HERE, 'seeds')
all_ok = True
for sfile in sorted(os.listdir(seed_dir)):
    if not sfile.endswith('.py'): continue
    path = os.path.join(seed_dir, sfile)
    spec = importlib.util.spec_from_file_location('_s', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    r = ZE.check(mod.zones(ZE.context()))
    if r['ok']:
        f = r['features']
        print(f"  {sfile:25s} OK  hash={r['hash']}  asym={f['asymmetry']:+.3f}  cell={ZE.cell(f)}")
    else:
        print(f"  {sfile:25s} FAIL  {r['violations']}")
        all_ok = False

print()
print("=== 结论 ===")
print(f"  Seeds: {'全部通过' if all_ok else '有失败'}")
