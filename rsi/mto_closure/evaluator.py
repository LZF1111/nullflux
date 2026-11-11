"""闭合式 RSI 评估器：LLM 写 closure.py → 沙箱校验 → 在 micro/pilot/demo 上打分 → paired_t 对冠军 → MAP-Elites 存档；
commercial 封存，只在 --final 时打开。"""
import argparse, ast, hashlib, json, math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mto_model as M

TRAIN = ('micro', 'pilot', 'demo')
HOLDOUT = ('commercial',)
SAFE_MODULES = {'math'}
BANNED = {'open', 'exec', 'eval', 'compile', '__import__', 'input', 'globals', 'locals', 'vars', 'getattr', 'setattr', 'delattr', 'breakpoint'}

def validate_source(src):
    tree = ast.parse(src)
    for n in ast.walk(tree):
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            mods = [a.name.split('.')[0] for a in n.names] if isinstance(n, ast.Import) else [(n.module or '').split('.')[0]]
            if any(m not in SAFE_MODULES for m in mods): raise ValueError(f'禁止导入: {mods}')
        if isinstance(n, ast.Name) and n.id in BANNED: raise ValueError(f'禁止调用: {n.id}')
        if isinstance(n, ast.Attribute) and n.attr.startswith('__'): raise ValueError('禁止 dunder 属性')
    names = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    for need in ('solids_age', 'contact_efficiency'):
        if need not in names: raise ValueError(f'缺少函数 {need}(s)')

def load_closure(path):
    src = open(path, encoding='utf-8').read()
    validate_source(src)
    ns = {'__builtins__': {k: __builtins__[k] if isinstance(__builtins__, dict) else getattr(__builtins__, k)
                           for k in ('abs', 'min', 'max', 'range', 'len', 'sum', 'float', 'int', 'zip', 'enumerate', 'round', 'list', 'tuple', 'dict', 'ValueError')}}
    # AST 已限定只能 import math，这里只放行 math
    ns['__builtins__']['__import__'] = lambda name, *a, **k: math if name == 'math' else (_ for _ in ()).throw(ImportError(name))
    ns['math'] = math
    exec(compile(src, path, 'exec'), ns)
    return src, ns['solids_age'], ns['contact_efficiency']

def _check_ages(ages):
    if not isinstance(ages, (list, tuple)) or not 1 <= len(ages) <= 400: raise ValueError('solids_age 须返回 1..400 个 (weight, theta)')
    w = [float(a) for a, _ in ages]; th = [float(b) for _, b in ages]
    if any(not math.isfinite(x) or x < 0 for x in w + th) or sum(w) <= 0: raise ValueError('权重/龄须为有限非负')
    s = sum(w); mean = sum(a * b for a, b in zip(w, th)) / s
    # 物料守恒：连续流动床的颗粒平均停留时间必须等于 inventory/Gs，即 mean(theta)=1
    if abs(mean - 1.0) > 0.02: raise ValueError(f'平均龄 mean(theta)={mean:.3f} ≠ 1（违反 inventory/Gs 守恒）')
    return [(a / s, b) for a, b in zip(w, th)]

def predict(scale, age_fn, eta_fn):
    s = M.features(scale)
    eta = float(eta_fn(dict(s)))
    if not (math.isfinite(eta) and 0.05 <= eta <= 1.0): raise ValueError(f'contact_efficiency={eta} 超出 [0.05,1]')
    if s['batch']:
        return M._outputs(s['T'], [(1.0, M.SCALES[scale]['wc_state'])]), dict(eta=eta, n_ages=1, age_cv=0.0)
    ages = _check_ages(age_fn(dict(s)))
    mean = 1.0; cv = math.sqrt(sum(w * (t - mean) ** 2 for w, t in ages))
    return M.population(scale, ages, eta), dict(eta=eta, n_ages=len(ages), age_cv=cv)

def score_scale(pred, scale):
    exp = M.EXP[scale]
    e = M.errors(pred, exp)
    ratio_err = abs(math.log(pred['ratio'] / (exp['C2H4'] / exp['C3H6'])))
    lump = sum(e[k] for k in M.LUMPS) / len(M.LUMPS)
    loss = 2.0 * ratio_err + lump + (e.get('wc', 0.0))
    return dict(loss=loss, ratio=pred['ratio'], ratio_exp=exp['C2H4'] / exp['C3H6'], ratio_err=ratio_err, lump=lump,
                wc=pred['wc'], wc_exp=exp.get('wc'), olefin=pred['C2H4'] + pred['C3H6'])

def evaluate(path, scales):
    src, age_fn, eta_fn = load_closure(path)
    out = {'scales': {}, 'desc': {}}
    for sc in scales:
        pred, d = predict(sc, age_fn, eta_fn)
        out['scales'][sc] = score_scale(pred, sc); out['desc'][sc] = d
    out['loss'] = sum(v['loss'] for v in out['scales'].values()) / len(scales)
    out['hash'] = hashlib.sha1(src.encode()).hexdigest()[:10]
    return out

def paired_test(deltas, minimum_gain=0.01, kappa=1.0, max_regression=0.05):
    """与 hl-rsi-bubble-column 同一判据：均值高于下限且超过 kappa 个标准误，且单个条件无显著退步。"""
    n = len(deltas); mean = sum(deltas) / n
    sd = math.sqrt(sum((d - mean) ** 2 for d in deltas) / (n - 1)) if n > 1 else 0.0
    se = sd / math.sqrt(n) if n > 1 else 0.0
    passed = mean > minimum_gain and mean > kappa * se and min(deltas) >= -max_regression
    return passed, dict(mean=mean, se=se, min=min(deltas), n=n)

def cell_of(res):
    """MAP-Elites 行为格：由闭合式在训练尺度上的实际行为决定（不看源码）。"""
    cv = max(res['desc'][s]['age_cv'] for s in ('pilot', 'demo'))
    etas = [res['desc'][s]['eta'] for s in TRAIN]
    span = max(etas) - min(etas)
    cv_bin = 0 if cv < 0.3 else 1 if cv < 0.8 else 2      # plug-like / 部分返混 / 近 CSTR 及以上
    eta_bin = 0 if span < 0.05 else 1 if span < 0.25 else 2  # 接触效率随尺度几乎不变 / 中等 / 强流型依赖
    return f'cv{cv_bin}_eta{eta_bin}'

class Archive:
    def __init__(self, d):
        self.d = d; os.makedirs(d, exist_ok=True)
        self.p = os.path.join(d, 'archive.json')
        self.s = json.load(open(self.p, encoding='utf-8')) if os.path.exists(self.p) else {'champion': None, 'cells': {}, 'history': []}
    def save(self):
        tmp = self.p + '.tmp'; json.dump(self.s, open(tmp, 'w', encoding='utf-8'), indent=1, ensure_ascii=False); os.replace(tmp, self.p)

    def submit(self, path):
        res = evaluate(path, TRAIN)
        cell = cell_of(res)
        champ = self.s['champion']
        if champ is None:
            accepted, test = True, {'note': 'first'}
        else:
            deltas = [champ['scales'][s]['loss'] - res['scales'][s]['loss'] for s in TRAIN]
            accepted, test = paired_test(deltas)
        rec = dict(path=os.path.abspath(path), hash=res['hash'], cell=cell, loss=res['loss'], scales=res['scales'], desc=res['desc'],
                   test=test, accepted=accepted, t=time.time())
        self.s['history'].append({k: rec[k] for k in ('hash', 'cell', 'loss', 'accepted', 'test')})
        elite = self.s['cells'].get(cell)
        if elite is None or res['loss'] < elite['loss']: self.s['cells'][cell] = rec
        if accepted: self.s['champion'] = rec
        self.save()
        return rec

def holdout(path):
    """封存的外推检验：commercial 只在最终评估时打开。"""
    return evaluate(path, TRAIN + HOLDOUT)

def baselines():
    rows = {}
    for sc in TRAIN + HOLDOUT:
        p = M.meanfield(sc)
        rows[sc] = dict(meanfield=score_scale(p, sc), tfm_ratio=M.TFM[sc]['C2H4'] / M.TFM[sc]['C3H6'], tfm_wc=M.TFM[sc]['wc'])
    return rows

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['baseline', 'eval', 'submit', 'final', 'status'])
    ap.add_argument('closure', nargs='?')
    ap.add_argument('--run', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'runs', 'default'))
    a = ap.parse_args()
    if a.cmd == 'baseline': print(json.dumps(baselines(), indent=1, ensure_ascii=False))
    elif a.cmd == 'eval': print(json.dumps(evaluate(a.closure, TRAIN), indent=1, ensure_ascii=False))
    elif a.cmd == 'submit':
        try: r = Archive(a.run).submit(a.closure)
        except Exception as e: print(json.dumps({'error': f'{type(e).__name__}: {e}'}, ensure_ascii=False)); sys.exit(2)
        print(json.dumps({k: r[k] for k in ('hash', 'cell', 'loss', 'accepted', 'test', 'scales')}, indent=1, ensure_ascii=False))
    elif a.cmd == 'final': print(json.dumps(holdout(a.closure), indent=1, ensure_ascii=False))
    elif a.cmd == 'status':
        s = Archive(a.run).s
        print(json.dumps({'champion': s['champion'] and {k: s['champion'][k] for k in ('hash', 'cell', 'loss', 'path')},
                          'cells': {c: (e['hash'], round(e['loss'], 4)) for c, e in s['cells'].items()}, 'n': len(s['history'])}, indent=1, ensure_ascii=False))
