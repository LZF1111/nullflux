#!/usr/bin/env python3
"""轻量 OpenFOAM 流场后处理（只用 numpy/scipy/matplotlib，不依赖 ParaView）。
只读算例：网格派生量（单元中心、体积）缓存到 ~/.cache/cfdriver_post，不往算例目录写任何东西。
  post_field.py info  <case> [time]
  post_field.py slice <case> <json-args>       输出 PNG + JSON（stdout 最后一行）
支持重构算例（case/<t>/）与分解算例（processor*/<t>/），binary/ascii，标量与矢量。"""
import sys, os, re, json, glob, gzip, hashlib, tempfile, warnings
import numpy as np
warnings.filterwarnings('ignore')

CACHE = os.path.expanduser('~/.cache/cfdriver_post')

def _read(path):
    if os.path.exists(path): return open(path, 'rb').read()
    if os.path.exists(path + '.gz'): return gzip.open(path + '.gz', 'rb').read()
    raise FileNotFoundError(path)

def _header(t):
    i = t.find(b'FoamFile')
    j = t.find(b'}', i) if i >= 0 else -1
    head = t[i:j] if i >= 0 else b''
    binary = re.search(rb'format\s+binary', head) is not None
    m = re.search(rb'label\s*=\s*(\d+)', head)
    lab = np.int64 if (m and m.group(1) == b'64') else np.int32
    cls = re.search(rb'class\s+(\w+)', head)
    return binary, lab, (cls.group(1).decode() if cls else ''), (j + 1 if j >= 0 else 0)

def _list_at(t, pos, binary, dtype, nc=1):
    """读 pos 之后的第一个 `N (` 列表，返回 (array, 结束位置)"""
    m = re.compile(rb'(\d+)\s*\(').search(t, pos)
    if not m: raise ValueError('找不到列表')
    n, s = int(m.group(1)), m.end()
    if binary:
        size = np.dtype(dtype).itemsize * n * nc
        a = np.frombuffer(t[s:s + size], dtype=dtype).copy()
        return (a.reshape(n, nc) if nc > 1 else a), s + size + 1
    e = t.find(b'\n)', s)
    body = t[s:e].decode('ascii', 'replace')
    if nc > 1: body = body.replace('(', ' ').replace(')', ' ')
    a = np.array(body.split(), dtype=np.float64 if dtype == np.float64 else np.int64)
    return (a.reshape(n, nc) if nc > 1 else a.astype(dtype)), e + 2

def _faces(t):
    binary, lab, cls, p = _header(t)
    if binary or cls == 'faceCompactList':
        off, p = _list_at(t, p, binary, lab)
        labels, _ = _list_at(t, p, binary, lab)
        return off.astype(np.int64), labels.astype(np.int64)
    m = re.compile(rb'(\d+)\s*\(').search(t, p)
    sizes, flat = [], []
    for g in re.finditer(rb'(\d+)\(([^)]*)\)', t[m.end():]):
        v = g.group(2).split(); sizes.append(len(v)); flat.extend(v)
    off = np.concatenate([[0], np.cumsum(sizes)]).astype(np.int64)
    return off, np.array(flat, dtype=np.int64)

def _mesh_geom(meshdir):
    """单元中心 C、体积 V（散度定理）；按 owner 文件 mtime/size 缓存"""
    st = os.stat(os.path.join(meshdir, 'owner') if os.path.exists(os.path.join(meshdir, 'owner')) else os.path.join(meshdir, 'owner.gz'))
    key = hashlib.sha1(f'{os.path.abspath(meshdir)}|{st.st_mtime}|{st.st_size}|v1'.encode()).hexdigest()[:20]
    cf = os.path.join(CACHE, key + '.npz')
    if os.path.exists(cf):
        z = np.load(cf); return z['C'], z['V']
    tp = _read(os.path.join(meshdir, 'points')); b, lab, _, p = _header(tp)
    pts, _ = _list_at(tp, p, b, np.float64, 3)
    off, labels = _faces(_read(os.path.join(meshdir, 'faces')))
    to = _read(os.path.join(meshdir, 'owner')); b, lab, _, p = _header(to); own, _ = _list_at(to, p, b, lab)
    tn = _read(os.path.join(meshdir, 'neighbour')); b, lab, _, p = _header(tn); nei, _ = _list_at(tn, p, b, lab)
    own = own.astype(np.int64); nei = nei.astype(np.int64)
    nf = len(off) - 1; fsz = np.diff(off)
    P = pts[labels]; fi = np.repeat(np.arange(nf), fsz)
    fc = np.add.reduceat(P, off[:-1], axis=0) / fsz[:, None]
    nxt = np.arange(len(labels)) + 1; nxt[off[1:] - 1] = off[:-1]
    a, c = P - fc[fi], P[nxt] - fc[fi]
    Sf = 0.5 * np.add.reduceat(np.cross(a, c), off[:-1], axis=0)
    ncell = int(max(own.max(), nei.max() if len(nei) else 0)) + 1
    d = (fc * Sf).sum(1) / 3.0
    V = np.bincount(own, d, ncell) - np.bincount(nei, d[:len(nei)], ncell)
    cnt = np.bincount(own, minlength=ncell) + np.bincount(nei, minlength=ncell)
    C = np.stack([(np.bincount(own, fc[:, k], ncell) + np.bincount(nei, fc[:len(nei), k], ncell)) / np.maximum(cnt, 1) for k in range(3)], 1)
    os.makedirs(CACHE, exist_ok=True)
    np.savez(cf, C=C, V=np.abs(V))
    return C, np.abs(V)

def _field(path, ncell):
    t = _read(path); binary, _, cls, p = _header(t)
    nc = 3 if 'Vector' in cls else (1 if 'Scalar' in cls else 0)
    if nc == 0: raise ValueError(f'不支持的场类型 {cls}')
    i = t.find(b'internalField', p)
    m = re.match(rb'\s*uniform\s+([^;]+);', t[i + 13:])
    if m:
        v = np.array(m.group(1).decode().replace('(', ' ').replace(')', ' ').split(), float)
        return np.tile(v, (ncell, 1)) if nc == 3 else np.full(ncell, v[0])
    a, _ = _list_at(t, i, binary, np.float64, nc)
    return a

def _times(case):
    num = lambda d: re.fullmatch(r'-?\d+(\.\d+)?([eE][-+]?\d+)?', os.path.basename(d))
    rec = sorted([os.path.basename(d) for d in glob.glob(os.path.join(case, '*')) if os.path.isdir(d) and num(d)], key=float)
    dec = sorted([os.path.basename(d) for d in glob.glob(os.path.join(case, 'processor0', '*')) if os.path.isdir(d) and num(d)], key=float)
    return rec, dec

def _procs(case):
    return sorted(glob.glob(os.path.join(case, 'processor[0-9]*')), key=lambda d: int(re.sub(r'\D', '', os.path.basename(d))))

def _source(case, time, field=None):
    """优先重构场；重构目录没有这个场时用分解场"""
    rec_ok = os.path.isdir(os.path.join(case, time)) and os.path.isdir(os.path.join(case, 'constant', 'polyMesh'))
    if rec_ok and (field is None or os.path.exists(os.path.join(case, time, field)) or os.path.exists(os.path.join(case, time, field) + '.gz')):
        if field is not None or os.listdir(os.path.join(case, time)): return 'reconstructed'
    if os.path.isdir(os.path.join(case, 'processor0', time)): return 'decomposed'
    return 'reconstructed' if rec_ok else None

def _fields_at(case, time):
    out = {}
    for src, d in [('reconstructed', os.path.join(case, time)), ('decomposed', os.path.join(case, 'processor0', time))]:
        if not os.path.isdir(d): continue
        for f in sorted(os.listdir(d)):
            fp = os.path.join(d, f)
            if os.path.isdir(fp) or f in out: continue
            name = f[:-3] if f.endswith('.gz') else f
            try:
                cls = _header(open(fp, 'rb').read(1500) if not f.endswith('.gz') else gzip.open(fp, 'rb').read(1500))[2]
            except Exception: continue
            if cls in ('volScalarField', 'volVectorField'): out[name] = {'kind': 'vector' if 'Vector' in cls else 'scalar', 'source': src}
    return out

def load(case, time, field):
    src = _source(case, time, field)
    if src == 'reconstructed':
        C, V = _mesh_geom(os.path.join(case, 'constant', 'polyMesh'))
        return C, V, _field(os.path.join(case, time, field), len(V)), src
    if src == 'decomposed':
        Cs, Vs, Fs = [], [], []
        for pd in _procs(case):
            C, V = _mesh_geom(os.path.join(pd, 'constant', 'polyMesh'))
            Cs.append(C); Vs.append(V); Fs.append(_field(os.path.join(pd, time, field), len(V)))
        return np.concatenate(Cs), np.concatenate(Vs), np.concatenate(Fs), src
    raise FileNotFoundError(f'{time} 下找不到场 {field}')

def geom_only(case, time):
    src = _source(case, time)
    if src == 'decomposed':
        parts = [_mesh_geom(os.path.join(pd, 'constant', 'polyMesh')) for pd in _procs(case)]
        return np.concatenate([p[0] for p in parts]), np.concatenate([p[1] for p in parts])
    return _mesh_geom(os.path.join(case, 'constant', 'polyMesh'))

def cmd_info(case, time=None):
    rec, dec = _times(case)
    times = sorted(set(rec) | set(dec), key=float)
    out = {'times': times, 'reconstructed': rec, 'decomposed': dec, 'nProcs': len(_procs(case))}
    t = time if time in times else None
    if t is None:
        # 默认取最新的、含瞬时场的时刻
        for cand in reversed(times):
            if len(_fields_at(case, cand)) >= 3: t = cand; break
        t = t or (times[-1] if times else None)
    out['time'] = t
    if t is not None:
        out['fields'] = _fields_at(case, t)
        C, V = geom_only(case, t)
        out['bounds'] = [C.min(0).round(5).tolist(), C.max(0).round(5).tolist()]
        out['nCells'] = int(len(V))
    print(json.dumps(out, ensure_ascii=False))

def _patches(meshdir):
    """boundary 文件（总是 ascii）→ [(name, type, startFace, nFaces)]"""
    t = _read(os.path.join(meshdir, 'boundary')).decode('utf-8', 'replace')
    t = t[t.find('}', t.find('FoamFile')) + 1:]
    out = []
    for m in re.finditer(r'\n\s*([A-Za-z_][\w.:-]*)\s*\{(.*?)\}', t, re.S):
        b = m.group(2)
        ty = re.search(r'\btype\s+(\w+);', b); n = re.search(r'\bnFaces\s+(\d+);', b); s = re.search(r'\bstartFace\s+(\d+);', b)
        if ty and n and s: out.append((m.group(1), ty.group(1), int(s.group(1)), int(n.group(1))))
    return out

def _topo(meshdir):
    """网格拓扑（点、面、owner/neighbour、patch 表），按 owner 文件 mtime/size 缓存"""
    own_f = os.path.join(meshdir, 'owner') if os.path.exists(os.path.join(meshdir, 'owner')) else os.path.join(meshdir, 'owner.gz')
    st = os.stat(own_f)
    key = hashlib.sha1(f'{os.path.abspath(meshdir)}|{st.st_mtime}|{st.st_size}|topo1'.encode()).hexdigest()[:20]
    cf = os.path.join(CACHE, key + '.npz')
    if os.path.exists(cf):
        z = np.load(cf)
        return dict(pts=z['pts'], off=z['off'], lab=z['lab'], own=z['own'], nei=z['nei'], patches=json.loads(str(z['patches'])))
    tp = _read(os.path.join(meshdir, 'points')); b, _, _, p = _header(tp); pts, _ = _list_at(tp, p, b, np.float64, 3)
    off, lab = _faces(_read(os.path.join(meshdir, 'faces')))
    to = _read(os.path.join(meshdir, 'owner')); b, lb, _, p = _header(to); own, _ = _list_at(to, p, b, lb)
    tn = _read(os.path.join(meshdir, 'neighbour')); b, lb, _, p = _header(tn); nei, _ = _list_at(tn, p, b, lb)
    T = dict(pts=pts, off=off.astype(np.int64), lab=lab.astype(np.int32), own=own.astype(np.int32), nei=nei.astype(np.int32),
             patches=_patches(meshdir))
    os.makedirs(CACHE, exist_ok=True)
    np.savez(cf, pts=T['pts'], off=T['off'], lab=T['lab'], own=T['own'], nei=T['nei'], patches=json.dumps(T['patches']))
    return T

def _cut(T, ia, pos, ix, iy):
    """平面 x[ia]=pos 精确切多面体单元：每个被切单元得到一个凸多边形（面边与平面交点按角度排序），
    外边界（非 processor patch）得到线段。返回 (cells, polys, segs, seg_kinds)"""
    P = T['pts']; off = T['off']; lab = T['lab'].astype(np.int64); own = T['own'].astype(np.int64); nei = T['nei'].astype(np.int64)
    s = P[:, ia] - pos
    s[np.abs(s) < 1e-12] = 1e-12                                   # 点恰在平面上时稍微挪开，避免退化
    sl = s[lab]
    smin = np.minimum.reduceat(sl, off[:-1]); smax = np.maximum.reduceat(sl, off[:-1])
    fc = np.where((smin < 0) & (smax > 0))[0]
    if not len(fc): return np.zeros(0, int), [], [], []
    sizes = np.diff(off)[fc]; starts = off[fc]
    rep = np.repeat(np.arange(len(fc)), sizes)
    k = np.arange(sizes.sum()) - np.repeat(np.cumsum(sizes) - sizes, sizes)
    a = lab[starts[rep] + k]; b = lab[starts[rep] + (k + 1) % sizes[rep]]
    sa, sb = s[a], s[b]; cr = sa * sb < 0
    t = (sa[cr] / (sa[cr] - sb[cr]))[:, None]
    X = (P[a[cr]] + t * (P[b[cr]] - P[a[cr]]))[:, [ix, iy]]
    face = fc[rep[cr]]
    nInt = len(nei); internal = face < nInt
    cells = np.concatenate([own[face], nei[face[internal]]]); Q = np.concatenate([X, X[internal]])
    # 单元多边形：按单元分组，绕组内均值按极角排序
    ncell = int(cells.max()) + 1
    cnt = np.bincount(cells, minlength=ncell)
    cx = np.bincount(cells, Q[:, 0], ncell) / np.maximum(cnt, 1); cy = np.bincount(cells, Q[:, 1], ncell) / np.maximum(cnt, 1)
    ang = np.arctan2(Q[:, 1] - cy[cells], Q[:, 0] - cx[cells])
    o = np.lexsort((ang, cells)); cs = cells[o]; Qs = Q[o]
    uc, first, num = np.unique(cs, return_index=True, return_counts=True)
    keep = num >= 3
    polys = [Qs[f:f + n] for f, n, kk in zip(first, num, keep) if kk]
    # 外边界线段：非 processor 的边界面，每面恰好 2 个交点
    segs, kinds = [], []
    for name, ty, st0, n in T['patches']:
        if ty in ('processor', 'processorCyclic', 'empty') or n == 0: continue
        m = (face >= st0) & (face < st0 + n)
        if not m.any(): continue
        fm, Xm = face[m], X[m]
        u, fi, nc = np.unique(fm, return_index=True, return_counts=True)
        oo = np.argsort(fm, kind='stable'); fm, Xm = fm[oo], Xm[oo]
        u, fi, nc = np.unique(fm, return_index=True, return_counts=True)
        for f0, c0 in zip(fi, nc):
            if c0 == 2: segs.append(Xm[f0:f0 + 2]); kinds.append(ty)
    return uc[keep], polys, segs, kinds

LATEX = {'alpha.particles': r'$\alpha_\mathrm{s}$', 'alpha.gas': r'$\alpha_\mathrm{g}$', 'alpha.particlesMean': r'$\langle\alpha_\mathrm{s}\rangle$',
         'U.gas': r'$\mathbf{u}_\mathrm{g}$', 'U.particles': r'$\mathbf{u}_\mathrm{s}$', 'p': r'$p$', 'p_rgh': r'$p_{\rho gh}$',
         'T.gas': r'$T_\mathrm{g}$', 'Theta.particles': r'$\Theta_\mathrm{s}$', 'coke.particles': r'$Y_\mathrm{coke}$'}
UNITS = {'U': 'm s$^{-1}$', 'p': 'Pa', 'T': 'K', 'Theta': 'm$^2$ s$^{-2}$'}

def _label(field, comp):
    base = LATEX.get(field)
    if base is None:
        m = re.match(r'([A-Za-z0-9]+)\.gas(Mean)?$', field)
        if m and m.group(1)[0].isupper() and m.group(1) not in ('U', 'T'):
            sp = re.sub(r'(\d+)', r'_{\1}', m.group(1))
            base = (r'$\langle Y_{\mathrm{%s}}\rangle$' if m.group(2) else r'$Y_{\mathrm{%s}}$') % sp
        else: base = field
    vm = re.fullmatch(r'\$\\mathbf\{u\}_\\mathrm\{(\w+)\}\$', base)
    if vm: base = f'$|\\mathbf{{u}}_\\mathrm{{{vm.group(1)}}}|$' if comp == 'mag' else f'$u_{{\\mathrm{{{vm.group(1)}}},{comp}}}$'
    unit = next((u for k, u in UNITS.items() if field.split('.')[0] == k), '')
    return base + (f' [{unit}]' if unit else '')

def _slice_parts(case, time, field, ia, pos, ix, iy):
    """各分区分别切、拼接；返回多边形、对应场值、体积、外边界线段"""
    src = _source(case, time, field)
    if src is None: raise FileNotFoundError(f'{time} 下找不到场 {field}')
    dirs = [case] if src == 'reconstructed' else _procs(case)
    polys, vals, vols, segs, kinds = [], [], [], [], []
    for d in dirs:
        md = os.path.join(d, 'constant', 'polyMesh'); T = _topo(md)
        if T['pts'][:, ia].min() > pos or T['pts'][:, ia].max() < pos: continue
        cells, pp, ss, kk = _cut(T, ia, pos, ix, iy)
        if not len(cells): continue
        _, V = _mesh_geom(md)
        F = _field(os.path.join(d, time, field), len(V))
        polys += pp; vals.append(F[cells]); vols.append(V[cells]); segs += ss; kinds += kk
    if not polys: raise ValueError(f'平面 {"xyz"[ia]}={pos:g} 与网格不相交')
    return polys, np.concatenate(vals), np.concatenate(vols), segs, kinds, src

def _style(plt):
    plt.rcParams.update({
        'font.family': 'serif', 'font.serif': ['DejaVu Serif', 'Noto Serif CJK SC', 'Times New Roman'],
        'mathtext.fontset': 'dejavuserif', 'axes.unicode_minus': False, 'font.size': 9,
        'axes.linewidth': 0.8, 'xtick.direction': 'in', 'ytick.direction': 'in', 'xtick.top': True, 'ytick.right': True,
        'xtick.major.size': 3.5, 'ytick.major.size': 3.5, 'xtick.minor.visible': True, 'ytick.minor.visible': True,
        'xtick.minor.size': 2, 'ytick.minor.size': 2, 'savefig.bbox': 'tight', 'savefig.pad_inches': 0.04})

def slice_data(case, a):
    """切片数据（不画图）：polys/F/Vc/segs/kinds/ext/vmin/vmax 等，供 cmd_slice 和报告脚本共用"""
    time, field = str(a['time']), a['field']
    comp = a.get('component', 'mag')
    axis = a.get('axis', 'y'); ia = {'x': 0, 'y': 1, 'z': 2}[axis]; ix, iy = [(1, 2), (0, 2), (0, 1)][ia]
    if a.get('pos') not in (None, ''): pos = float(a['pos'])
    else: C, _ = geom_only(case, time); pos = float(0.5 * (C[:, ia].min() + C[:, ia].max()))
    if a.get('F') is not None:
        polys, F, Vc, segs, kinds, src = a['F']
    else:
        polys, F, Vc, segs, kinds, src = _slice_parts(case, time, field, ia, pos, ix, iy)
    if F.ndim == 2: F = np.linalg.norm(F, axis=1) if comp == 'mag' else F[:, {'x': 0, 'y': 1, 'z': 2}[comp]]
    crop = a.get('crop') or {}
    allp = np.concatenate(polys)
    ext = [float(crop.get('x0', allp[:, 0].min())), float(crop.get('x1', allp[:, 0].max())),
           float(crop.get('y0', allp[:, 1].min())), float(crop.get('y1', allp[:, 1].max()))]
    cen = np.array([p.mean(0) for p in polys])
    inb = (cen[:, 0] >= ext[0]) & (cen[:, 0] <= ext[1]) & (cen[:, 1] >= ext[2]) & (cen[:, 1] <= ext[3])
    vals = F[inb]
    vmin = float(a['vmin']) if a.get('vmin') not in (None, '') else float(np.nanpercentile(vals, 1))
    vmax = float(a['vmax']) if a.get('vmax') not in (None, '') else float(np.nanpercentile(vals, 99))
    if vmax <= vmin: vmax = vmin + 1e-12
    return dict(time=time, field=field, comp=comp, axis=axis, ia=ia, ix=ix, iy=iy, pos=pos, polys=polys, F=F, Vc=Vc, segs=segs,
                kinds=kinds, src=src, ext=ext, cen=cen, inb=inb, vmin=vmin, vmax=vmax)

def draw_slice(ax, d, cmap='viridis', shading='flat', mesh=False, contours=0, walls=True):
    """把 slice_data 的结果画进已有坐标轴；返回可给 colorbar 用的 mappable"""
    from matplotlib.collections import PolyCollection, LineCollection
    import matplotlib.tri as mtri
    polys, F, cen, vmin, vmax = d['polys'], d['F'], d['cen'], d['vmin'], d['vmax']
    base = PolyCollection(polys, array=F, cmap=cmap, edgecolors='face', linewidths=0.3, antialiaseds=False)
    base.set_clim(vmin, vmax); ax.add_collection(base); m = base
    if shading == 'smooth' and len(cen) > 3:
        tri = mtri.Triangulation(cen[:, 0], cen[:, 1])
        hc = np.sqrt(np.abs([0.5 * (p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]).sum() for p in polys]))
        e = tri.triangles
        L = np.max([np.hypot(*(cen[e[:, i]] - cen[e[:, (i + 1) % 3]]).T) for i in range(3)], 0)
        tri.set_mask(L > 2.2 * np.maximum.reduce([hc[e[:, 0]], hc[e[:, 1]], hc[e[:, 2]]]))
        m = ax.tricontourf(tri, np.clip(F, vmin, vmax), levels=np.linspace(vmin, vmax, 64), cmap=cmap)
    if mesh:
        ax.add_collection(PolyCollection(polys, facecolors='none', edgecolors='k', linewidths=0.08, alpha=0.5))
    if contours:
        tri = mtri.Triangulation(cen[:, 0], cen[:, 1])
        ax.tricontour(tri, F, levels=np.linspace(vmin, vmax, int(contours) + 2)[1:-1], colors='k', linewidths=0.35, alpha=0.6)
    if walls:
        wall = [s for s, k in zip(d['segs'], d['kinds']) if k == 'wall']; other = [s for s, k in zip(d['segs'], d['kinds']) if k != 'wall']
        if wall: ax.add_collection(LineCollection(wall, colors='k', linewidths=0.7))
        if other: ax.add_collection(LineCollection(other, colors='0.35', linewidths=0.6, linestyles=(0, (2, 1.5))))
    ext = d['ext']; ax.set_xlim(ext[0], ext[1]); ax.set_ylim(ext[2], ext[3]); ax.set_aspect('equal')
    return m

def colorbar(fig, m, ax, label, **kw):
    from matplotlib.ticker import MaxNLocator
    if kw.get('cax') is not None:
        # 多面板图：色标放在面板右侧的 inset 轴里，不挤占 gridspec 布局
        cb = fig.colorbar(m, cax=kw['cax'])
    else:
        cb = fig.colorbar(m, ax=ax, fraction=kw.pop('fraction', 0.05), pad=kw.pop('pad', 0.03), aspect=kw.pop('aspect', 30), **kw)
    cb.locator = MaxNLocator(6); cb.update_ticks()
    cb.set_label(label); cb.ax.tick_params(direction='in', labelsize=8); cb.outline.set_linewidth(0.6)
    return cb

def cmd_slice(case, a):
    """精确切片：平面切多面体单元得到真实单元截面（snappy 贴体面保持原样），外边界画实线；
    shading=flat 逐单元着色，smooth 在单元中心做三角化插值（三角形不跨出几何）。"""
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    from matplotlib.collections import PolyCollection, LineCollection
    import matplotlib.tri as mtri
    _style(plt)
    d = slice_data(case, a)
    time, field, comp, axis, pos = d['time'], d['field'], d['comp'], d['axis'], d['pos']
    ix, iy, ia, ext, inb, F, Vc, src = d['ix'], d['iy'], d['ia'], d['ext'], d['inb'], d['F'], d['Vc'], d['src']
    vals = F[inb]
    C, _ = geom_only(case, time); lo, hi = C.min(0), C.max(0)
    W = ext[1] - ext[0]; H = ext[3] - ext[2]; asp = H / max(W, 1e-12)
    # 单栏图宽 3.5 in；很高的切片限高 7.5 in
    if asp <= 1.3: fw = 3.5 if not a.get('wide') else 7.0; fh = fw * asp * 0.9 + 0.55
    else: fh = min(2.6 * asp, 7.5); fw = max(fh / asp + 1.6, 2.8)
    fig, ax = plt.subplots(figsize=(fw, fh), dpi=int(a.get('dpi', 200)))
    m = draw_slice(ax, d, cmap=a.get('cmap', 'viridis'), shading=a.get('shading', 'flat'), mesh=a.get('mesh'), contours=a.get('contours'))
    names = 'xyz'
    ax.set_xlabel(f'${names[ix]}$ [m]'); ax.set_ylabel(f'${names[iy]}$ [m]')
    if asp > 3:                                                    # 细高切片：横轴刻度要少，避免标签重叠
        from matplotlib.ticker import MaxNLocator, FormatStrFormatter
        if asp > 6 and ext[0] < 0 < ext[1]:
            # 极细高（如全塔 y=0 切片）：只标对称的两端，"-0.2  0.2"
            r = float(f'{min(-ext[0], ext[1]):.1g}')
            ax.set_xticks([-r, r]); ax.xaxis.set_major_formatter(FormatStrFormatter('%g'))
        else:
            ax.xaxis.set_major_locator(MaxNLocator(2 if asp > 6 else 3, symmetric=ext[0] < 0 < ext[1]))
    for sp in ('top', 'right', 'bottom', 'left'): ax.spines[sp].set_visible(bool(a.get('frame', True)))
    colorbar(fig, m, ax, _label(field, comp))
    wall = [s for s, k in zip(d['segs'], d['kinds']) if k == 'wall']
    if a.get('title', True):
        ax.set_title(f'$t$ = {float(time):.2f} s,  ${axis}$ = {pos:.3g} m', fontsize=8, loc='left')
    out = a.get('out') or tempfile.mktemp(suffix='.png', prefix='cfdpost_')
    fig.savefig(out); plt.close(fig)
    w = Vc[inb]; vmin, vmax = d['vmin'], d['vmax']
    stats = {'min': float(np.nanmin(vals)), 'max': float(np.nanmax(vals)), 'mean_vol': float((vals * w).sum() / max(w.sum(), 1e-30)),
             'nCells': int(inb.sum()), 'nWallSegs': len(wall)}
    print(json.dumps({'png': out, 'time': time, 'field': field, 'component': comp, 'axis': axis, 'pos': pos, 'vmin': vmin, 'vmax': vmax,
                      'source': src, 'range': [float(lo[ia]), float(hi[ia])], 'stats': stats}, ensure_ascii=False))

if __name__ == '__main__':
    try:
        cmd, case = sys.argv[1], sys.argv[2]
        if cmd == 'info': cmd_info(case, sys.argv[3] if len(sys.argv) > 3 else None)
        elif cmd == 'slice': cmd_slice(case, json.loads(sys.argv[3]))
        else: raise SystemExit('未知命令 ' + cmd)
    except SystemExit: raise
    except Exception as e:
        print(json.dumps({'error': f'{type(e).__name__}: {e}'}, ensure_ascii=False)); sys.exit(1)
