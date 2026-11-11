#!/usr/bin/env python3
"""foam_locate.py <case> [nTimes] — 发散定位：对最近 n 个写出时刻跑 fieldMinMax(location)，
给出各场极值单元位置、随时间的增长、最近 patch 及该处网格质量。输出 JSON（末行）。"""
import json, os, re, subprocess, sys, math

case = os.path.abspath(sys.argv[1]); ntimes = int(sys.argv[2]) if len(sys.argv) > 2 else 3
os.chdir(case)
procs = sorted([d for d in os.listdir('.') if re.fullmatch(r'processor\d+', d)], key=lambda s: int(s[9:]))
base = procs[0] if procs else '.'
def is_time(n):
    try: return float(n) > 0 and os.path.isdir(os.path.join(base, n))
    except ValueError: return False
times = sorted([d for d in os.listdir(base) if is_time(d)], key=float)[-ntimes:]
if not times: print(json.dumps({'ok': False, 'error': '没有已写出的时间步（求解前先设 writeInterval / purgeWrite 保留发散前场）'})); sys.exit(0)

# 场：最后时刻目录里的所有 volScalar/volVector 场（速度、体积分数、压力、温度、组分…），不含派生/临时场
def field_class(p):
    try:
        with open(p, errors='replace') as fh: head = fh.read(1200)
    except OSError: return None
    m = re.search(r'class\s+(\w+)\s*;', head); return m.group(1) if m else None
last_dir = os.path.join(base, times[-1])
fields = sorted(f for f in os.listdir(last_dir)
                if os.path.isfile(os.path.join(last_dir, f)) and not re.search(r'(_0|\.orig|Mean|Prime2Mean)$|^(phi|nut|nu|alphat|Co)', f)
                and field_class(os.path.join(last_dir, f)) in ('volScalarField', 'volVectorField'))[:24]
dict_txt = 'FoamFile { version 2.0; format ascii; class dictionary; object nfLocate; }\nfunctions\n{\n  nfLocate\n  {\n    type fieldMinMax; libs (fieldFunctionObjects); mode magnitude; location true; log true;\n    fields (%s);\n  }\n}\n' % ' '.join(fields)
# 字典写到 /tmp，不碰算例的 system/（算例可能还在跑，runTimeModifiable 会重读 system/）
import tempfile
dfd, dpath = tempfile.mkstemp(prefix='nfLocate_', suffix='Dict'); os.close(dfd)
open(dpath, 'w').write(dict_txt)
res = {}
try:
    # 一次 postProcess 处理全部时刻（以前每个时刻启动一次 MPI）
    cmd = ['postProcess', '-dict', dpath, '-fields', '(%s)' % ' '.join(fields), '-time', ','.join(times)]
    if procs: cmd = ['mpirun', '--bind-to', 'none', '-np', str(len(procs))] + cmd + ['-parallel']
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=1800).stdout
    cur = None
    for line in out.splitlines():
        mt = re.match(r'^Time = ([-\d.eE+]+)', line)
        if mt: cur = float(mt.group(1)); continue
        m = re.search(r'(min|max)\((?:mag\()?([\w.]+)\)?\) = ([-\d.eE+]+) in cell (\d+) at location \(([^)]*)\)(?: on processor (\d+))?', line)
        if not m or cur is None: continue
        kind, f, v, cell, loc, proc = m.groups()
        res.setdefault(f, {}).setdefault(kind, []).append({'t': cur, 'v': float(v), 'cell': int(cell), 'loc': [float(x) for x in loc.split()], 'proc': int(proc) if proc else None})
finally:
    try: os.remove(dpath)
    except OSError: pass

# 最近 patch：只解析边界面（不读全部 faces 列表）；未重构时用 processor0 的网格（极值在别的分块时距离只是参考）
def read_ascii_list(fn):
    t = open(fn, errors='replace').read(); t = t[t.find('}', t.find('FoamFile')) + 1:]
    m = re.search(r'\n\s*(\d+)\s*\n\s*\(', t)
    if not m: raise ValueError('二进制或无法解析的列表: ' + fn)
    return int(m.group(1)), t[m.end():]
patch_hit = {}
pm = 'constant/polyMesh' if os.path.exists('constant/polyMesh/points') else os.path.join(base, 'constant', 'polyMesh')
try:
    import numpy as np
    bnd = open(f'{pm}/boundary').read()
    patches = [(m.group(1), int(m.group(2)), int(m.group(3))) for m in re.finditer(r'(\w+)\s*\{[^}]*?nFaces\s+(\d+);\s*startFace\s+(\d+);', bnd)]
    empty = {m.group(1) for m in re.finditer(r'(\w+)\s*\{[^}]*?type\s+empty\s*;', bnd)}  # 2D 的前后面，不是物理边界
    patches = [p for p in patches if not p[0].startswith('proc') and p[1] > 0 and p[0] not in empty]
    targets = {f: d['max'][-1]['loc'] for f, d in res.items() if 'max' in d and re.match(r'U|alpha', f)}
    if patches and targets:
        n, b = read_ascii_list(f'{pm}/points')
        P = np.array(re.findall(r'\(([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\)', b)[:n], dtype=float)
        nf, bf = read_ascii_list(f'{pm}/faces')
        lo = min(p[2] for p in patches); hi = max(p[2] + p[1] for p in patches)
        it = re.finditer(r'\d+\(([^()]*)\)', bf)
        cent = {}
        for i, m in enumerate(it):
            if i < lo: continue
            if i >= hi: break
            idx = np.array(m.group(1).split(), dtype=int)
            cent[i] = P[idx].mean(axis=0)
        # 每个 patch 最多取 20000 个面中心，避免超大网格上过慢
        pc = {}
        for name, nF, sF in patches:
            step = max(1, nF // 20000)
            pc[name] = np.array([cent[i] for i in range(sF, sF + nF, step) if i in cent])
        for f, loc in targets.items():
            L = np.array(loc, dtype=float)
            best = sorted((float(np.sqrt(((c - L) ** 2).sum(axis=1).min())), name) for name, c in pc.items() if len(c))
            patch_hit[f] = [{'patch': nm, 'dist_m': round(d, 4)} for d, nm in best[:3]]
        if pm != 'constant/polyMesh': patch_hit['_note'] = '未重构：只用 processor0 的边界面，极值不在该分块时距离偏大'
except Exception as e:
    patch_hit['_error'] = str(e)

summary = []
for f, d in res.items():
    if 'max' not in d: continue
    s = d['max']; first, last = s[0], s[-1]
    grow = (last['v'] / first['v']) if first['v'] else None
    same = len({(x['cell'], x['proc']) for x in s}) == 1 and len(s) > 1
    summary.append({'field': f, 'max_series': [(x['t'], round(x['v'], 4)) for x in s], 'growth': round(grow, 2) if grow else None,
                    'pinned_same_cell': same, 'loc': last['loc'], 'nearest_patches': patch_hit.get(f)})
out = {'ok': True, 'times': times, 'fields': fields, 'summary': summary}
if '_note' in patch_hit or '_error' in patch_hit: out['patch_note'] = patch_hit.get('_note') or patch_hit.get('_error')
print(json.dumps(out, ensure_ascii=False))
