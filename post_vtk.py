#!/usr/bin/env python3
"""CFDriver 三维后处理工作进程（VTK，常驻）。stdin 每行一个 JSON 请求 {id, cmd, args}，stdout 每行一个 JSON 回复。
只读算例：唯一写入的是算例根目录下一个空的 .cfdpost.foam（vtkOpenFOAMReader 需要一个文件名来定位算例）。
命令：
  info   {case}                         时刻、场（标量/矢量）、边界 patch（类型、是否 wedge）、包围盒、重力方向
  scene  {case, time, layers:[...]}     每层一个操作，返回三角面/线（base64 float32/uint32）+ 标量 + 统计
  volume {case, time, field, comp, n}   重采样到规则网格（体渲染用），无效点为 NaN
  line   {case, time, p1, p2, n, fields} 沿线取值
层类型：surface（边界面）、slice、clip、iso、threshold、stream（流线）、glyph（矢量箭头，在截面上）、outline（包围盒）。"""
import base64, json, math, os, re, sys, time, traceback
from collections import OrderedDict

import numpy as np
import vtk
from vtk.util import numpy_support as ns

vtk.vtkObject.GlobalWarningDisplayOff()
SKIP_PATCH_TYPES = {'wedge', 'empty', 'symmetryPlane', 'processor'}


def b64(a, dt):
    return base64.b64encode(np.ascontiguousarray(a, dtype=dt).tobytes()).decode()


def clean_time(t):
    """1.2e2 写成 120、121.61792199999999 → 121.617922（目录名才是准的，这里只是显示）"""
    return float(f'{float(t):.10g}')


# ---------------------------------------------------------------- 读取（带缓存）
class Case:
    def __init__(self, path):
        self.path = os.path.abspath(path)
        if not os.path.isdir(os.path.join(self.path, 'system')): raise ValueError('不是 OpenFOAM 算例（没有 system/）')
        self.foam = os.path.join(self.path, '.cfdpost.foam')
        if not os.path.exists(self.foam):
            try: open(self.foam, 'a').close()
            except OSError: raise ValueError('算例目录不可写，无法建立 .cfdpost.foam 读入点')
        self.boundary = self._boundary()
        root_times = [d for d in os.listdir(self.path) if re.fullmatch(r'[0-9.eE+-]+', d) and os.path.isdir(os.path.join(self.path, d))]
        p0 = os.path.join(self.path, 'processor0')
        proc_times = [d for d in os.listdir(p0) if re.fullmatch(r'[0-9.eE+-]+', d)] if os.path.isdir(p0) else []
        # 分解数据的时刻更多（求解中、或只重构了个别时刻）就读分解数据
        self.decomposed = len(proc_times) > len(root_times) or (proc_times and not [t for t in root_times if float(t) > 0])
        r = self.reader = vtk.vtkPOpenFOAMReader() if hasattr(vtk, 'vtkPOpenFOAMReader') else vtk.vtkOpenFOAMReader()
        r.SetFileName(self.foam)
        if hasattr(r, 'SetCaseType'): r.SetCaseType(0 if self.decomposed else 1)
        elif self.decomposed: raise ValueError('算例只有分解数据（processor*），这台机器的 VTK 没有并行读取器：先 reconstructPar')
        for m, *v in (('CreateCellToPointOn',), ('SetDecomposePolyhedra', 0), ('ReadZonesOff',), ('CacheMeshOn',), ('SkipZeroTimeOff',),
                      ('ListTimeStepsByControlDictOff',)):
            if hasattr(r, m): getattr(r, m)(*v)
        r.UpdateInformation()
        for i in range(r.GetNumberOfCellArrays()): r.SetCellArrayStatus(r.GetCellArrayName(i), 1)
        for i in range(r.GetNumberOfPatchArrays()):
            n = r.GetPatchArrayName(i)
            pname = n.split('/')[-1]
            r.SetPatchArrayStatus(n, 1 if n == 'internalMesh' or self.boundary.get(pname, {}).get('type') not in SKIP_PATCH_TYPES else 0)
        tv = r.GetTimeValues()
        self.times = [tv.GetValue(i) for i in range(tv.GetNumberOfValues())] if tv else [0.0]
        # 求解器正在写的最新时刻：读到的是半截场（某些 processor 还没写），先不列出
        self.partial = None
        if len(self.times) > 1 and not self._complete(self.times[-1]): self.partial = self.times.pop()
        self.cache = OrderedDict()
        self.mtime = self._mtime()

    def _complete(self, t):
        """最新时刻是否写完：首尾两个 processor 都有该时刻、场文件数不少于 processor0，且 2 s 内没有文件还在变"""
        import time as _time
        def tdir(base):
            if not os.path.isdir(base): return None
            for d in os.listdir(base):
                if re.fullmatch(r'[0-9.eE+-]+', d):
                    try:
                        if abs(float(d) - t) <= 1e-9 * max(1.0, abs(t)): return os.path.join(base, d)
                    except ValueError: pass
            return None
        if self.decomposed:
            bases = [os.path.join(self.path, p) for p in os.listdir(self.path) if re.fullmatch(r'processor\d+', p)]
            bases.sort(key=lambda x: int(re.sub(r'\D', '', os.path.basename(x)) or 0))
        else:
            bases = [self.path]
        if not bases: return True
        ref = tdir(bases[0])
        if not ref: return False
        n0 = len([x for x in os.listdir(ref) if os.path.isfile(os.path.join(ref, x))])
        now = _time.time()
        for base in {bases[0], bases[-1]}:
            d = tdir(base)
            if not d: return False
            files = [os.path.join(d, x) for x in os.listdir(d) if os.path.isfile(os.path.join(d, x))]
            if len(files) < n0: return False
            if any(now - os.path.getmtime(x) < 2 for x in files): return False
        return True

    def _mtime(self):
        """目录本身的 mtime 只在增删条目（新写出时刻）时变；日志追加不算"""
        out = 0
        for d in (self.path, os.path.join(self.path, 'processor0')):
            try: out = max(out, os.path.getmtime(d))
            except OSError: pass
        return out

    def _boundary(self):
        for p in ('constant/polyMesh/boundary', 'processor0/constant/polyMesh/boundary'):
            f = os.path.join(self.path, p)
            if os.path.exists(f):
                s = open(f, 'rb').read().decode('latin-1')
                s = re.sub(r'//.*', '', s)
                out = {}
                for m in re.finditer(r'(\w[\w.:-]*)\s*\{([^{}]*)\}', s):
                    t = re.search(r'\btype\s+(\w+)\s*;', m.group(2))
                    nf = re.search(r'\bnFaces\s+(\d+)\s*;', m.group(2))
                    if t: out[m.group(1)] = dict(type=t.group(1), nFaces=int(nf.group(1)) if nf else None)
                return out
        return {}

    def nearest(self, t):
        if t is None or t == '' or t == 'latest': return self.times[-1]
        t = float(t); return min(self.times, key=lambda x: abs(x - t))

    def data(self, t):
        t = self.nearest(t)
        if t in self.cache: self.cache.move_to_end(t); return self.cache[t]
        r = self.reader; r.UpdateTimeStep(t); r.Update()
        out = r.GetOutput()
        internal, patches = None, {}
        it = out.NewIterator(); it.UnRegister(None); it.InitTraversal()
        while not it.IsDoneWithTraversal():
            name = it.GetCurrentMetaData().Get(vtk.vtkCompositeDataSet.NAME()) or ''
            ds = it.GetCurrentDataObject()
            if name == 'internalMesh': internal = _copy(ds)
            elif ds is not None and ds.GetNumberOfCells(): patches[name] = _copy(ds)
            it.GoToNextItem()
        if internal is None: raise ValueError(f'时刻 {t} 没有读到内部网格')
        d = dict(t=t, internal=internal, patches=patches)
        self.cache[t] = d
        while len(self.cache) > 3: self.cache.popitem(last=False)
        return d


def _copy(ds):
    c = ds.NewInstance(); c.DeepCopy(ds); return c


CASES = OrderedDict()


def get_case(path):
    path = os.path.abspath(path)
    c = CASES.get(path)
    if c is not None and (c._mtime() != c.mtime or (c.partial is not None and c._complete(c.partial))): c = None  # 新时刻写出/半截时刻已写完：重读时刻表
    if c is None:
        c = CASES[path] = Case(path)
        while len(CASES) > 3: CASES.popitem(last=False)
    CASES.move_to_end(path)
    return c


# ---------------------------------------------------------------- 场
def field_kind(ds, name):
    a = ds.GetPointData().GetArray(name) or ds.GetCellData().GetArray(name)
    return None if a is None else a.GetNumberOfComponents()


def fields_of(ds):
    out = []
    pd = ds.GetCellData()
    for i in range(pd.GetNumberOfArrays()):
        a = pd.GetArray(i)
        if a is None or (a.GetName() or '').startswith('__'): continue
        out.append(dict(name=a.GetName(), ncomp=a.GetNumberOfComponents()))
    return out


def scalar_of(arr, comp):
    a = ns.vtk_to_numpy(arr).astype(np.float64)
    if a.ndim == 1: return a
    if comp in ('x', 'y', 'z'): return a[:, 'xyz'.index(comp)]
    return np.linalg.norm(a, axis=1)


def point_scalars(ds, field, comp):
    if not field: return None
    a = ds.GetPointData().GetArray(field)
    return None if a is None else scalar_of(a, comp)


def cell_scalars(ds, field, comp):
    if not field: return None
    a = ds.GetCellData().GetArray(field)
    return None if a is None else scalar_of(a, comp)


def add_scalar(ds, field, comp, name='__s'):
    """把（分量/模的）标量写成点数据 __s，供 contour/threshold 使用"""
    s = point_scalars(ds, field, comp)
    if s is None: raise ValueError(f'没有场 {field}')
    arr = ns.numpy_to_vtk(s.astype(np.float64), deep=1); arr.SetName(name)
    ds.GetPointData().AddArray(arr)
    c = cell_scalars(ds, field, comp)
    if c is not None:
        ca = ns.numpy_to_vtk(c.astype(np.float64), deep=1); ca.SetName(name); ds.GetCellData().AddArray(ca)
    return s


# ---------------------------------------------------------------- 几何输出
def to_poly(ds):
    if isinstance(ds, vtk.vtkPolyData): return ds
    f = vtk.vtkDataSetSurfaceFilter(); f.SetInputData(ds); f.Update(); return f.GetOutput()


def tri_pack(poly, field, comp, flat=False):
    """三角化 → positions/indices + 点标量 + 每三角形的单元标量（逐单元着色用）"""
    t = vtk.vtkTriangleFilter(); t.SetInputData(poly); t.PassLinesOff(); t.PassVertsOff(); t.Update()
    p = t.GetOutput()
    n = p.GetNumberOfCells()
    if n == 0: return None
    pts = ns.vtk_to_numpy(p.GetPoints().GetData()).astype(np.float32)
    conn = ns.vtk_to_numpy(p.GetPolys().GetConnectivityArray()).astype(np.uint32)
    out = dict(kind='mesh', nverts=int(len(pts)), ntris=int(len(conn) // 3), positions=b64(pts, '<f4'), indices=b64(conn, '<u4'))
    s = point_scalars(p, field, comp)
    if s is not None:
        out['scalars'] = b64(s, '<f4'); out['range'] = [float(np.nanmin(s)), float(np.nanmax(s))]
    c = cell_scalars(p, field, comp)
    if c is not None and len(c) == out['ntris']:
        out['cellScalars'] = b64(c, '<f4')
        out['range'] = [float(min(np.nanmin(c), out.get('range', [np.inf])[0])), float(max(np.nanmax(c), out.get('range', [0, -np.inf])[1]))]
    return out


def line_pack(poly, field, comp):
    pts = ns.vtk_to_numpy(poly.GetPoints().GetData()).astype(np.float32) if poly.GetPoints() else np.zeros((0, 3), np.float32)
    lines = poly.GetLines()
    if lines.GetNumberOfCells() == 0: return None
    off = ns.vtk_to_numpy(lines.GetOffsetsArray()); con = ns.vtk_to_numpy(lines.GetConnectivityArray())
    seg = []
    for i in range(len(off) - 1):
        ids = con[off[i]:off[i + 1]]
        if len(ids) > 1: seg.append(np.stack([ids[:-1], ids[1:]], 1))
    seg = np.concatenate(seg).astype(np.uint32).ravel() if seg else np.zeros(0, np.uint32)
    out = dict(kind='lines', nverts=int(len(pts)), positions=b64(pts, '<f4'), indices=b64(seg, '<u4'), nlines=int(lines.GetNumberOfCells()))
    s = point_scalars(poly, field, comp)
    if s is not None: out['scalars'] = b64(s, '<f4'); out['range'] = [float(np.nanmin(s)), float(np.nanmax(s))]
    return out


def area_stats(poly, field, comp):
    """面积加权平均（截面/剖面用）+ 面积；体数据用体积加权"""
    if not field: return {}
    ia = vtk.vtkIntegrateAttributes(); ia.SetInputData(poly); ia.Update()
    o = ia.GetOutput()
    if o is None or o.GetNumberOfPoints() == 0: return {}
    meas = None
    for nm in ('Area', 'Volume', 'Length'):
        a = o.GetCellData().GetArray(nm)
        if a is not None and a.GetValue(0) > 0: meas = (nm, a.GetValue(0)); break
    pa = o.GetPointData().GetArray(field)
    if meas is None or pa is None: return {}
    v = np.array(pa.GetTuple(0))
    val = float(np.linalg.norm(v)) if (len(v) > 1 and comp == 'mag') else float(v['xyz'.index(comp)] if len(v) > 1 else v[0])
    return {'measure': meas[0], 'size': meas[1], 'mean': val / meas[1]}


# ---------------------------------------------------------------- 操作
def plane(origin, normal):
    p = vtk.vtkPlane(); p.SetOrigin(*origin); p.SetNormal(*normal); return p


def mirror(ds, info):
    """2D 轴对称（wedge）展开：关于轴线平面镜像，看起来像整个截面"""
    if not info.get('axisym'): return ds
    f = vtk.vtkReflectionFilter(); f.SetInputData(ds); f.SetPlane(vtk.vtkReflectionFilter.USE_X_MIN); f.CopyInputOn(); f.Update()
    return f.GetOutput()


def contour_lines(ug, L, field, comp, info):
    """截面上的等值线（ParaView: Slice → Contour）。水平按当前色标范围等分"""
    cut = vtk.vtkCutter(); cut.SetInputData(ug); cut.SetCutFunction(plane(L['origin'], L['normal'])); cut.Update()
    poly = cut.GetOutput()
    if L.get('mirror'): poly = to_poly(mirror(poly, info))
    if poly.GetNumberOfPoints() == 0: return None
    s = add_scalar(poly, field, comp)
    lo, hi = (L.get('lo'), L.get('hi')) if L.get('lo') is not None and L.get('hi') is not None else (float(np.nanmin(s)), float(np.nanmax(s)))
    n = int(L['contours']); poly.GetPointData().SetActiveScalars('__s')
    cf = vtk.vtkContourFilter(); cf.SetInputData(poly)
    for i in range(n): cf.SetValue(i, lo + (hi - lo) * (i + 1) / (n + 1))
    cf.Update()
    o = line_pack(cf.GetOutput(), None, comp)
    return dict(positions=o['positions'], indices=o['indices']) if o else None


def op_layer(c, d, L, info):
    kind = L.get('type'); field = L.get('field') or None; comp = L.get('comp') or 'mag'
    ug = d['internal'] if d else None
    stats = {}
    if kind == 'slice' and L.get('contours'):
        res = op_layer(c, d, dict(L, contours=0), info)
        if res and res.get('kind') == 'mesh' and field:
            res['clines'] = contour_lines(ug, L, field, comp, info)
        return res
    if kind == 'surface':
        names = L.get('patches') or list(d['patches'])
        app = vtk.vtkAppendPolyData()
        for n in names:
            if n in d['patches']: app.AddInputData(to_poly(d['patches'][n]))
        if app.GetNumberOfInputConnections(0) == 0: return None
        app.Update(); poly = app.GetOutput()
        res = tri_pack(poly, field, comp)
    elif kind == 'slice':
        cut = vtk.vtkCutter(); cut.SetInputData(ug); cut.SetCutFunction(plane(L['origin'], L['normal'])); cut.GenerateTrianglesOff(); cut.Update()
        poly = cut.GetOutput()
        if L.get('mirror'): poly = to_poly(mirror(poly, info))
        res = tri_pack(poly, field, comp); stats = area_stats(poly, field, comp)
        if res and L.get('edges'):
            # 网格线：切出来的多边形边（就是被切到的单元的轮廓）
            ex = vtk.vtkExtractEdges(); ex.SetInputData(poly); ex.Update()
            e = line_pack(ex.GetOutput(), None, comp)
            if e and e['indices']: res['edges'] = dict(positions=e['positions'], indices=e['indices'])
    elif kind == 'clip':
        cl = vtk.vtkTableBasedClipDataSet(); cl.SetInputData(ug); cl.SetClipFunction(plane(L['origin'], L['normal']))
        cl.SetInsideOut(1 if L.get('invert') else 0); cl.Update()
        res = tri_pack(to_poly(cl.GetOutput()), field, comp)
    elif kind == 'iso':
        g = _copy(ug); add_scalar(g, L['isoField'], L.get('isoComp', 'mag'))
        g.GetPointData().SetActiveScalars('__s')
        cf = vtk.vtkContourFilter(); cf.SetInputData(g)
        vals = L.get('values') or []
        for i, v in enumerate(vals): cf.SetValue(i, float(v))
        cf.ComputeScalarsOff(); cf.Update()
        res = tri_pack(cf.GetOutput(), field, comp); stats = area_stats(cf.GetOutput(), field, comp)
    elif kind == 'threshold':
        g = _copy(ug); add_scalar(g, L['thrField'], L.get('thrComp', 'mag'))
        th = vtk.vtkThreshold(); th.SetInputData(g)
        th.SetInputArrayToProcess(0, 0, 0, vtk.vtkDataObject.FIELD_ASSOCIATION_CELLS, '__s')
        th.SetLowerThreshold(float(L['lo'])); th.SetUpperThreshold(float(L['hi']))
        th.SetThresholdFunction(vtk.vtkThreshold.THRESHOLD_BETWEEN); th.Update()
        res = tri_pack(to_poly(th.GetOutput()), field, comp)
        vol = vtk.vtkIntegrateAttributes(); vol.SetInputData(th.GetOutput()); vol.Update()
        va = vol.GetOutput().GetCellData().GetArray('Volume') if vol.GetOutput() else None
        stats = {'measure': 'Volume', 'size': float(va.GetValue(0)) if va else 0.0, 'cells': int(th.GetOutput().GetNumberOfCells())}
    elif kind == 'stream':
        vf = L.get('vector') or 'U.gas'
        if field_kind(ug, vf) != 3: raise ValueError(f'{vf} 不是矢量场')
        ug.GetPointData().SetActiveVectors(vf)
        seeds = vtk.vtkLineSource(); seeds.SetPoint1(*L['p1']); seeds.SetPoint2(*L['p2']); seeds.SetResolution(int(L.get('n', 40)))
        if L.get('seedType') == 'plane':
            seeds = vtk.vtkPlaneSource(); seeds.SetOrigin(*L['p1']); seeds.SetPoint1(*L['p2']); seeds.SetPoint2(*L['p3'])
            k = max(2, int(math.sqrt(int(L.get('n', 100))))); seeds.SetResolution(k, k)
        seeds.Update()
        b = ug.GetBounds(); diag = math.dist(b[0::2], b[1::2])
        st = vtk.vtkStreamTracer(); st.SetInputData(ug); st.SetSourceData(seeds.GetOutput())
        st.SetInputArrayToProcess(0, 0, 0, vtk.vtkDataObject.FIELD_ASSOCIATION_POINTS, vf)
        st.SetIntegratorTypeToRungeKutta45(); st.SetIntegrationDirectionToBoth()
        st.SetMaximumPropagation(diag * float(L.get('maxLen', 2.0))); st.SetInitialIntegrationStep(0.2)
        st.SetMaximumNumberOfSteps(4000); st.SetComputeVorticity(False); st.Update()
        poly = st.GetOutput()
        if L.get('tubes', True) and poly.GetNumberOfPoints():
            tb = vtk.vtkTubeFilter(); tb.SetInputData(poly); tb.SetRadius(diag * float(L.get('radius', 0.0015))); tb.SetNumberOfSides(6)
            tb.CappingOff(); tb.Update()
            res = tri_pack(tb.GetOutput(), field or vf, comp)
        else:
            res = line_pack(poly, field or vf, comp)
        stats = {'lines': int(poly.GetNumberOfLines())}
    elif kind == 'glyph':
        vf = L.get('vector') or 'U.gas'
        cut = vtk.vtkCutter(); cut.SetInputData(ug); cut.SetCutFunction(plane(L['origin'], L['normal'])); cut.Update()
        poly = cut.GetOutput()
        if poly.GetNumberOfPoints() == 0: return None
        mk = vtk.vtkMaskPoints(); mk.SetInputData(poly); mk.SetMaximumNumberOfPoints(int(L.get('n', 1500))); mk.RandomModeOn()
        mk.SetRandomModeType(2); mk.GenerateVerticesOn(); mk.Update()
        pts = mk.GetOutput(); pts.GetPointData().SetActiveVectors(vf)
        arrow = vtk.vtkArrowSource(); arrow.SetTipResolution(6); arrow.SetShaftResolution(6)
        b = ug.GetBounds(); diag = math.dist(b[0::2], b[1::2])
        u = ns.vtk_to_numpy(pts.GetPointData().GetArray(vf)); umax = float(np.linalg.norm(u, axis=1).max() or 1)
        gl = vtk.vtkGlyph3D(); gl.SetInputData(pts); gl.SetSourceConnection(arrow.GetOutputPort())
        gl.SetVectorModeToUseVector(); gl.SetScaleModeToScaleByVector(); gl.OrientOn()
        gl.SetScaleFactor(diag * float(L.get('scale', 0.04)) / umax); gl.Update()
        res = tri_pack(gl.GetOutput(), field or vf, comp)
    elif kind == 'stl':
        # constant/triSurface/*.stl（网格生成前的几何），每个文件里的每个 solid 一块
        import glob as _g
        files = sorted(_g.glob(os.path.join(c.path, 'constant', 'triSurface', '*.stl')))
        if L.get('files'): files = [f for f in files if os.path.basename(f) in L['files']]
        parts = []
        for f in files[:12]:
            rd = vtk.vtkSTLReader(); rd.SetFileName(f); rd.Update()
            r = tri_pack(rd.GetOutput(), None, comp)
            if r: r['name'] = os.path.basename(f); parts.append(r)
        return dict(kind='parts', parts=parts)
    elif kind == 'patches':
        parts = []
        for n in (L.get('patches') or list(d['patches'])):
            if n not in d['patches']: continue
            r = tri_pack(to_poly(d['patches'][n]), None, comp)
            if r: r['name'] = n; parts.append(r)
        return dict(kind='parts', parts=parts)
    elif kind == 'outline':
        b = ug.GetBounds(); return dict(kind='box', bounds=list(b))
    else:
        raise ValueError(f'未知层类型 {kind}')
    if res is None: return dict(kind='empty', note='这一层没有几何（平面/等值没切到网格？）')
    res['stats'] = stats
    return res


# ---------------------------------------------------------------- 计算器（ParaView Calculator 的安全子集）
import ast
CALC_FUNCS = {'mag': lambda a: np.linalg.norm(a, axis=1) if a.ndim == 2 else np.abs(a), 'sqrt': np.sqrt, 'abs': np.abs, 'log': np.log,
              'log10': np.log10, 'exp': np.exp, 'min': np.minimum, 'max': np.maximum,
              'x': lambda a: a[:, 0], 'y': lambda a: a[:, 1], 'z': lambda a: a[:, 2],
              'dot': lambda a, b: np.sum(a * b, axis=1), 'clip': np.clip}
CALC_NODES = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Call, ast.Name, ast.Load, ast.Constant, ast.Add, ast.Sub, ast.Mult,
              ast.Div, ast.Pow, ast.USub, ast.UAdd)


def calc_eval(expr, arrays):
    """表达式里直接写场名（如 mag(U.gas - U.particles)、alpha.particles*1500）。只允许四则、乘方和白名单函数。"""
    names = sorted(arrays, key=len, reverse=True); tok = {}
    expr = expr.replace('^', '**')
    for i, n in enumerate(names):
        if n in expr:
            t = f'__f{i}'; expr = re.sub(r'(?<![\w.])' + re.escape(n) + r'(?![\w])', t, expr); tok[t] = arrays[n]
    tree = ast.parse(expr, mode='eval')
    for node in ast.walk(tree):
        if not isinstance(node, CALC_NODES): raise ValueError(f'表达式里不允许 {type(node).__name__}')
        if isinstance(node, ast.Call) and not (isinstance(node.func, ast.Name) and node.func.id in CALC_FUNCS): raise ValueError('只能用这些函数：' + ', '.join(CALC_FUNCS))
        if isinstance(node, ast.Name) and node.id not in tok and node.id not in CALC_FUNCS: raise ValueError(f'不认识的名字 {node.id}（场名要写全，如 U.gas）')
        if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float)): raise ValueError('只能用数字常量')
    with np.errstate(all='ignore'):
        return np.asarray(eval(compile(tree, '<calc>', 'eval'), {'__builtins__': {}}, {**CALC_FUNCS, **tok}), dtype=np.float64)


def apply_derived(ds, derived):
    """把派生场写进单元数据和点数据（与原场同名规则，后面的操作都能用）"""
    for dv in derived or []:
        name = re.sub(r'[^\w.-]', '_', str(dv.get('name') or ''))[:40]
        if not name or not dv.get('expr'): continue
        for data in (ds.GetCellData(), ds.GetPointData()):
            arrays = {}
            for i in range(data.GetNumberOfArrays()):
                a = data.GetArray(i)
                if a is not None and a.GetName() and not a.GetName().startswith('__'): arrays[a.GetName()] = ns.vtk_to_numpy(a).astype(np.float64)
            v = calc_eval(str(dv['expr']), arrays)
            if v.ndim == 0: v = np.full(data.GetNumberOfTuples(), float(v))
            arr = ns.numpy_to_vtk(np.ascontiguousarray(v), deep=1); arr.SetName(name); data.AddArray(arr)


def stats_cmd(c, a):
    """全场体积加权统计 + 直方图（ParaView: Descriptive Statistics / Histogram / Integrate Variables）"""
    d = c.data(a.get('time')); ug = d['internal']; apply_derived(ug, a.get('derived'))
    cs = vtk.vtkCellSizeFilter(); cs.SetInputData(ug); cs.ComputeVertexCountOff(); cs.ComputeLengthOff(); cs.ComputeAreaOff(); cs.Update()
    vol = ns.vtk_to_numpy(cs.GetOutput().GetCellData().GetArray('Volume')).astype(np.float64)
    s = cell_scalars(ug, a['field'], a.get('comp', 'mag'))
    if s is None: raise ValueError(f"没有场 {a['field']}")
    ok = np.isfinite(s) & (vol > 0); s, vol = s[ok], vol[ok]
    lo, hi = float(s.min()), float(s.max())
    h, e = np.histogram(s, bins=int(a.get('bins', 40)), range=(lo, hi if hi > lo else lo + 1), weights=vol)
    m = float((s * vol).sum() / vol.sum())
    return dict(field=a['field'], time=clean_time(d['t']), min=lo, max=hi, mean_vol=m, std_vol=float(math.sqrt(max(0.0, ((s - m) ** 2 * vol).sum() / vol.sum()))),
                volume=float(vol.sum()), integral=float((s * vol).sum()), cells=int(len(s)), hist=(h / vol.sum()).tolist(), edges=e.tolist())


def timeseries(c, a):
    """单点随时间变化（ParaView: Plot Data Over Time / Probe）"""
    pt = vtk.vtkPolyData(); P = vtk.vtkPoints(); P.InsertNextPoint(*a['point']); pt.SetPoints(P)
    times = c.times[-int(a.get('maxTimes', 200)):]
    out = dict(t=[], series={f: [] for f in a.get('fields') or []})
    for t in times:
        d = c.data(t); ug = d['internal']; apply_derived(ug, a.get('derived'))
        pr = vtk.vtkProbeFilter(); pr.SetInputData(pt); pr.SetSourceData(ug); pr.Update()
        o = pr.GetOutput()
        if not o.GetPointData().GetArray('vtkValidPointMask').GetValue(0): continue
        out['t'].append(clean_time(t))
        for f in out['series']:
            arr = o.GetPointData().GetArray(f)
            out['series'][f].append(float(scalar_of(arr, a.get('comp', 'mag'))[0]) if arr is not None else None)
    if not out['t']: raise ValueError('这个点不在计算域里')
    return out


def info(c):
    d = c.data(None)
    ug = d['internal']
    b = list(ug.GetBounds())
    g = (0, -9.81, 0)
    try:
        s = open(os.path.join(c.path, 'constant', 'g')).read()
        m = re.search(r'value\s*\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)', s)
        if m: g = tuple(float(x) for x in m.groups())
    except OSError: pass
    up = int(np.argmax(np.abs(g)))
    wedge = any(v['type'] == 'wedge' for v in c.boundary.values())
    patches = [dict(name=n, type=v['type'], nFaces=v['nFaces'], shown=v['type'] not in SKIP_PATCH_TYPES) for n, v in c.boundary.items()]
    fl = fields_of(ug)
    for f in fl:
        a = ug.GetCellData().GetArray(f['name'])
        try:
            s = scalar_of(a, 'mag'); s = s[np.isfinite(s)]
            f['range'] = [float(s.min()), float(s.max())] if s.size else [0.0, 1.0]
            if f['ncomp'] == 3:
                f['compRange'] = {k: [float(np.nanmin(v)), float(np.nanmax(v))] for k, v in zip('xyz', ns.vtk_to_numpy(a).T)}
        except Exception: f['range'] = [0.0, 1.0]
    stl = sorted(os.path.basename(p) for p in __import__('glob').glob(os.path.join(c.path, 'constant', 'triSurface', '*.stl')))
    return dict(case=c.path, times=[clean_time(t) for t in c.times], latest=clean_time(c.times[-1]), decomposed=c.decomposed,
                cells=int(ug.GetNumberOfCells()), points=int(ug.GetNumberOfPoints()), bounds=b, up='xyz'[up], g=list(g),
                axisym=wedge, patches=patches, fields=fl, stl=stl, time=clean_time(d['t']),
         writing=clean_time(c.partial) if c.partial is not None else None)


def volume(c, a):
    d = c.data(a.get('time')); ug = d['internal']
    b = ug.GetBounds(); ext = np.array([b[1] - b[0], b[3] - b[2], b[5] - b[4]])
    n = int(a.get('n', 2_000_000)); h = (np.prod(np.maximum(ext, 1e-12)) / n) ** (1 / 3)
    dims = [int(max(2, min(256, round(e / h) + 1))) for e in ext]
    rs = vtk.vtkResampleToImage(); rs.SetInputDataObject(ug); rs.SetSamplingDimensions(*dims); rs.SetUseInputBounds(True); rs.Update()
    img = rs.GetOutput()
    s = scalar_of(img.GetPointData().GetArray(a['field']), a.get('comp', 'mag')).astype(np.float32)
    mask = img.GetPointData().GetArray('vtkValidPointMask')
    if mask is not None: s[ns.vtk_to_numpy(mask) == 0] = np.nan
    ok = s[np.isfinite(s)]
    return dict(dims=dims, bounds=list(b), data=b64(s, '<f4'), range=[float(ok.min()), float(ok.max())] if ok.size else [0, 1])


def line(c, a):
    d = c.data(a.get('time')); ug = d['internal']
    ls = vtk.vtkLineSource(); ls.SetPoint1(*a['p1']); ls.SetPoint2(*a['p2']); ls.SetResolution(int(a.get('n', 200)) - 1); ls.Update()
    pr = vtk.vtkProbeFilter(); pr.SetInputData(ls.GetOutput()); pr.SetSourceData(ug); pr.Update()
    o = pr.GetOutput(); valid = ns.vtk_to_numpy(o.GetPointData().GetArray('vtkValidPointMask')).astype(bool)
    pts = ns.vtk_to_numpy(o.GetPoints().GetData()); s = np.linalg.norm(pts - pts[0], axis=1)
    out = dict(s=s[valid].tolist(), series={})
    for f in a.get('fields') or []:
        arr = o.GetPointData().GetArray(f)
        if arr is None: continue
        out['series'][f] = scalar_of(arr, a.get('comp', 'mag'))[valid].tolist()
    return out


def stl_only_info(path):
    """还没网格、只有 STL 的算例：包围盒取所有 STL 的并集，只能看几何"""
    import glob as _g
    files = sorted(_g.glob(os.path.join(path, 'constant', 'triSurface', '*.stl')))
    if not files: return None
    b = [np.inf, -np.inf] * 3
    for f in files:
        rd = vtk.vtkSTLReader(); rd.SetFileName(f); rd.Update(); bb = rd.GetOutput().GetBounds()
        for k in range(3): b[2 * k] = min(b[2 * k], bb[2 * k]); b[2 * k + 1] = max(b[2 * k + 1], bb[2 * k + 1])
    return dict(case=os.path.abspath(path), times=[0.0], latest=0.0, decomposed=False, cells=0, points=0, bounds=b, up='z', g=[0, 0, -9.81],
                axisym=False, patches=[], fields=[], stl=[os.path.basename(f) for f in files], time=0.0, nomesh=True)


def has_mesh(path):
    for p in ('constant/polyMesh', 'processor0/constant/polyMesh'):
        if any(os.path.exists(os.path.join(path, p, f)) for f in ('owner', 'owner.gz')): return True
    return False


def handle(req):
    a = req.get('args') or {}
    cmd = req.get('cmd')
    if cmd == 'ping': return dict(pong=True, vtk=vtk.vtkVersion.GetVTKVersion())
    if not has_mesh(a['case']):
        si = stl_only_info(a['case'])
        if si is None: raise ValueError('这个算例还没有网格（constant/polyMesh），也没有 STL 几何')
        if cmd == 'info': return si
        if cmd == 'scene':
            class _C: path = os.path.abspath(a['case'])
            layers = []
            for L in a.get('layers') or []:
                if L.get('type') == 'stl': r = op_layer(_C, None, L, {})
                elif L.get('type') == 'outline': r = dict(kind='box', bounds=si['bounds'])
                else: r = dict(kind='empty', note='还没有网格，只能看 STL 几何')
                r['id'] = L.get('id'); layers.append(r)
            return dict(time=0.0, layers=layers)
        raise ValueError('还没有网格，只能看 STL 几何')
    c = get_case(a['case'])
    if cmd == 'info': return info(c)
    if cmd == 'scene':
        d = c.data(a.get('time')); inf = dict(axisym=any(v['type'] == 'wedge' for v in c.boundary.values()))
        apply_derived(d['internal'], a.get('derived'))
        for p in d['patches'].values():
            try: apply_derived(p, a.get('derived'))
            except Exception: pass
        layers = []
        for L in a.get('layers') or []:
            t0 = time.time()
            try: r = op_layer(c, d, L, inf)
            except Exception as e: r = dict(kind='error', error=f'{type(e).__name__}: {e}')
            if r is not None: r['id'] = L.get('id'); r['ms'] = int((time.time() - t0) * 1000)
            layers.append(r or dict(kind='empty', id=L.get('id')))
        return dict(time=clean_time(d['t']), layers=layers)
    if cmd == 'volume': apply_derived(c.data(a.get('time'))['internal'], a.get('derived')); return volume(c, a)
    if cmd == 'line': apply_derived(c.data(a.get('time'))['internal'], a.get('derived')); return line(c, a)
    if cmd == 'stats': return stats_cmd(c, a)
    if cmd == 'timeseries': return timeseries(c, a)
    if cmd == 'calccheck':
        d = c.data(a.get('time')); ug = d['internal']; apply_derived(ug, [dict(name='__chk', expr=a['expr'])])
        s = ns.vtk_to_numpy(ug.GetCellData().GetArray('__chk')); ok = s[np.isfinite(s)]
        return dict(ncomp=1 if s.ndim == 1 else s.shape[1], range=[float(ok.min()), float(ok.max())] if ok.size else [0, 0], nan=int((~np.isfinite(s)).sum()))
    raise ValueError(f'未知命令 {cmd}')


def main():
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw: continue
        try:
            req = json.loads(raw)
        except ValueError:
            continue
        try:
            out = dict(id=req.get('id'), ok=True, result=handle(req))
        except Exception as e:
            out = dict(id=req.get('id'), ok=False, error=f'{type(e).__name__}: {e}', trace=traceback.format_exc()[-1500:])
        sys.stdout.write(json.dumps(out) + '\n'); sys.stdout.flush()


if __name__ == '__main__':
    main()
