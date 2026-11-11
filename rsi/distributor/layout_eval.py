"""分布器布孔 RSI：候选校验 + 制造约束 + 开孔率锁定 + 廉价特征/筛选代理。
候选是一个只能 import math 的 Python 文件，定义 layout(ctx) -> [(x_m, y_m, d_mm), ...]。
开孔率是原文明确值：评估器把所有孔径按同一比例缩放到正好 5 %，缩放超过 max_rescale 视为候选违反约束。
代理（surrogate）只用于排序和合成验证，不是物理证据；晋级与接受只看 CFD。"""
import ast, hashlib, json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT = json.load(open(os.path.join(HERE, 'contract.json'), encoding='utf-8'))
G = CONTRACT['locked_geometry']; PH = CONTRACT['physics']; MF = CONTRACT['manufacturing']
SAFE_BUILTINS = ('abs', 'min', 'max', 'range', 'len', 'sum', 'float', 'int', 'zip', 'enumerate', 'round', 'list', 'tuple',
                 'dict', 'sorted', 'reversed', 'map', 'filter', 'any', 'all', 'ValueError', 'True', 'False', 'None')
BANNED = {'open', 'exec', 'eval', 'compile', '__import__', 'input', 'globals', 'locals', 'vars', 'getattr', 'setattr',
          'delattr', 'breakpoint', 'type', 'object', 'super', 'memoryview', 'help'}


def validate_source(src):
    tree = ast.parse(src)
    for n in ast.walk(tree):
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            mods = [a.name.split('.')[0] for a in n.names] if isinstance(n, ast.Import) else [(n.module or '').split('.')[0]]
            if any(m != 'math' for m in mods): raise ValueError(f'禁止导入: {mods}')
        if isinstance(n, ast.Name) and n.id in BANNED: raise ValueError(f'禁止调用: {n.id}')
        if isinstance(n, ast.Attribute) and n.attr.startswith('_'): raise ValueError('禁止下划线属性')
        if isinstance(n, (ast.While,)): raise ValueError('禁止 while（防死循环），用 range')
    if 'layout' not in {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}:
        raise ValueError('缺少函数 layout(ctx)')


def context():
    """候选可见的上下文（不含封存量、不含目标数据）"""
    return dict(R_R=G['R_R'], R_M=G['R_M'], phi=G['opening_ratio'], u_hole=PH['u_hole'], h_plate_mm=G['h_plate_mm'],
                n_min=MF['n_min'], n_max=MF['n_max'], d_min_mm=MF['d_min_mm'], d_max_mm=MF['d_max_mm'],
                ligament_min_mm=MF['ligament_min_mm'], edge_margin_mm=MF['edge_margin_mm'])


def load_layout(path):
    with open(path, encoding='utf-8') as fh: src = fh.read()
    validate_source(src)
    import builtins
    ns = {'__builtins__': {k: getattr(builtins, k) for k in SAFE_BUILTINS if hasattr(builtins, k)}, 'math': math}
    ns['__builtins__']['__import__'] = lambda name, *a, **k: math if name == 'math' else (_ for _ in ()).throw(ImportError(name))
    exec(compile(src, path, 'exec'), ns)
    return src, ns['layout']


def _holes(raw):
    if not isinstance(raw, (list, tuple)) or not raw: raise ValueError('layout 须返回非空 [(x, y, d_mm), ...]')
    if len(raw) > MF['n_max'] * 2: raise ValueError('孔数远超上限')
    out = []
    for h in raw:
        x, y, d = (float(v) for v in h)
        if not all(math.isfinite(v) for v in (x, y, d)) or d <= 0: raise ValueError('孔坐标/孔径须为有限正数')
        out.append((x, y, d))
    return out


def lock_opening(holes):
    """按开孔率 5 % 统一缩放孔径；返回 (holes, k)"""
    a_target = G['opening_ratio'] * math.pi * (G['R_M'] ** 2 - G['R_R'] ** 2)
    a = sum(math.pi * (d * 1e-3) ** 2 / 4 for _, _, d in holes)
    k = math.sqrt(a_target / a)
    return [(x, y, d * k) for x, y, d in holes], k


def manufacturing(holes, k):
    """返回违反项列表（空 = 通过）"""
    bad = []
    n = len(holes)
    if not MF['n_min'] <= n <= MF['n_max']: bad.append(f'孔数 {n} 不在 [{MF["n_min"]}, {MF["n_max"]}]')
    if abs(k - 1) > MF['max_rescale']: bad.append(f'开孔率缩放 {k:.3f} 超出 ±{MF["max_rescale"]}（候选没按 5 % 设计）')
    d_res = 2 * math.sqrt(0.5 * G['h_plate_mm'] ** 2 / math.pi)
    for i, (x, y, d) in enumerate(holes):
        r = math.hypot(x, y) * 1e3; rm = d / 2 + MF['edge_margin_mm']
        if not MF['d_min_mm'] <= d <= MF['d_max_mm']: bad.append(f'孔{i} 孔径 {d:.2f} mm 越界'); break
        if d < d_res: bad.append(f'孔{i} 孔径 {d:.2f} mm < 网格可分辨 {d_res:.2f} mm'); break
        if r - rm < G['R_R'] * 1e3 or r + rm > G['R_M'] * 1e3: bad.append(f'孔{i} 超出环形区'); break
    lig = MF['ligament_min_mm']
    for i in range(n):
        xi, yi, di = holes[i]
        for j in range(i + 1, n):
            xj, yj, dj = holes[j]
            if math.hypot(xi - xj, yi - yj) * 1e3 - (di + dj) / 2 < lig:
                bad.append(f'孔{i}/孔{j} 孔间筋 < {lig} mm'); return bad
    return bad


def penetration_m(d_mm):
    """Merry (1975) 竖直射流穿透深度，只用于特征/排序"""
    d0 = d_mm * 1e-3; g = 9.81
    return d0 * 5.2 * (PH['rho_g'] * d0 / (PH['rho_s'] * PH['dp'])) ** 0.3 * (1.3 * (PH['u_hole'] ** 2 / (g * d0)) ** 0.2 - 1)


def features(holes):
    n = len(holes); a = [d * d for _, _, d in holes]; A = sum(a)
    r = [math.hypot(x, y) for x, y, _ in holes]
    rm = sum(ai * ri for ai, ri in zip(a, r)) / A / G['R_M']
    d_eq = math.sqrt(A / n)
    pitch = []
    for i, (xi, yi, _) in enumerate(holes):
        pitch.append(min((math.hypot(xi - xj, yi - yj) for j, (xj, yj, _) in enumerate(holes) if j != i), default=0.0))
    return dict(n_holes=n, d_eq_mm=d_eq, r_mean_over_R=rm, pitch_min_mm=1e3 * min(pitch), pitch_mean_mm=1e3 * sum(pitch) / n,
                L_jet_m=penetration_m(d_eq), d_cv=math.sqrt(sum((math.sqrt(ai) - d_eq) ** 2 for ai in a) / n) / d_eq)


def cell(f):
    nb = min(5, max(0, int(math.log2(max(f['n_holes'], 8) / 8))))      # 8-15,16-31,...,256+
    rb = 0 if f['r_mean_over_R'] < 0.6 else (1 if f['r_mean_over_R'] < 0.75 else 2)
    return f'n{nb}-r{rb}'


def surrogate_line(holes, Z, xs, lam=0.03, amp=0.6):
    """玩具射流模型：y=0 线上 C2H4/壁 = 1 − amp·Σ 孔贡献；孔贡献随 Z 超过穿透深度后按 lam 衰减、按 Z 展宽。
    只用于合成可辨识性测试和候选排序。"""
    R = G['R_M']; A = sum(d * d for _, _, d in holes)
    prof = []
    for xr in xs:
        x = xr * R; s = 0.0
        for hx, hy, d in holes:
            L = penetration_m(d); sig = 0.004 + 0.25 * Z
            w = d * d / A * math.exp(-max(0.0, Z - L) / lam)
            s += w * math.exp(-((x - hx) ** 2 + hy ** 2) / (2 * sig * sig)) * (2 * math.pi * sig * sig) / (math.pi * R * R) * len(holes)
        prof.append(s)
    wall = 0.5 * (prof[0] + prof[-1])
    return [1 - amp * (p - wall) for p in prof]


def paper_rmse(sim_x, sim_over_wall, Z):
    """模拟 y=0 线（÷壁）与原文 Fig.12b 点（÷壁）在原文 x 处的 RMSE；线性插值"""
    t = CONTRACT['targets']['fig12b'][Z]; px, pc = t['x'], t['C2H4']; w = pc[0]
    def interp(x):
        if x <= sim_x[0]: return sim_over_wall[0]
        for i in range(1, len(sim_x)):
            if x <= sim_x[i]:
                f = (x - sim_x[i - 1]) / (sim_x[i] - sim_x[i - 1]); return sim_over_wall[i - 1] * (1 - f) + sim_over_wall[i] * f
        return sim_over_wall[-1]
    return math.sqrt(sum((interp(x) - c / w) ** 2 for x, c in zip(px, pc)) / len(px))


def surrogate_score(holes):
    xs = [i / 20 - 1 for i in range(41)]
    return 0.5 * (paper_rmse(xs, surrogate_line(holes, 0.06, xs), '0.06') + paper_rmse(xs, surrogate_line(holes, 0.1, xs), '0.1'))


def check(path):
    """完整候选检查：沙箱 → 返回值 → 开孔率锁定 → 制造约束 → 特征/格子/代理分"""
    src, fn = load_layout(path)
    raw = _holes(fn(context()))
    holes, k = lock_opening(raw)
    bad = manufacturing(holes, k)
    f = features(holes)
    return dict(hash=hashlib.sha1(src.encode()).hexdigest()[:10], path=os.path.abspath(path), ok=not bad, violations=bad,
                rescale=k, features=f, cell=cell(f), surrogate=surrogate_score(holes),
                holes=[[round(x, 6), round(y, 6), round(d, 4)] for x, y, d in holes])
