"""放大设计 RSI 插件（Lu 2017 商业 DMTO）：几何（主反应区直径、高度）× 工况（床温、藏量、蒸汽比）联合寻优。
候选 = JSON {"D_m", "H_m", "T_K", "inv_t", "steam_ratio"}；甲醇处理量与新鲜剂量固定为原文商业装置值。
目标 neg_Y：Y = 气相 C2H4+C3H6 选择性 × 甲醇转化率 / 100（越大越好，取负）；门槛：转化率 ≥ eta_min、藏量守恒。
离线约束：表观气速在 EMMS 拟合设计点 ±20 % 内（否则曳力闭合失效）、床层充填比、空速、动力学插值范围。
代理：CSTR（与几何无关）→ 只用来排序；几何的作用（短路、返混）由 2D CFD 判。内置提议者，不需要 LLM。
保真度：short = 2D 30 s，full = 2D 60 s；3D 只对最终冠军人工复核。"""
import hashlib, json, math, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RSI_DIR = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, RSI_DIR); sys.path.insert(0, os.path.join(RSI_DIR, 'studies', 'mto_condition'))
from core.study import Study, Fidelity  # noqa: E402
import kinetics as K  # noqa: E402

CFG = json.load(open(os.path.join(HERE, 'config.json'), encoding='utf-8'))
KEYS = ('D_m', 'H_m', 'T_K', 'inv_t', 'steam_ratio')
ROUND = dict(D_m=2, H_m=2, T_K=1, inv_t=1, steam_ratio=3)


def derived(p):
    """离线可算的设计量：截面、表观气速（按原文 1.35 m/s 基准等比换算）、充填比、空速、CSTR"""
    B = CFG['base']
    A = math.pi * p['D_m'] ** 2 / 4
    P = B['p_gauge_MPa'] * 1e6 + 101325.

    def ug_feed(D, T, sr):
        n = B['meoh_kg_h'] / 32.042 + B['meoh_kg_h'] * sr / 18.015
        return n / 3.6 * 8.314 * T / P / (math.pi * D ** 2 / 4)
    ug = 1.35 * ug_feed(p['D_m'], p['T_K'], p['steam_ratio']) / ug_feed(B['D_m'], B['T_K'], B['steam_ratio'])
    fill = p['inv_t'] * 1000 / (1500 * 0.55 * A) / p['H_m']
    whsv = B['meoh_kg_h'] / (p['inv_t'] * 1000)
    c = K.solve(p['T_K'], 1.0, P=P, Is=p['inv_t'] * 1e6, Gs=B['gs_kg_h'] * 1e3 / 3600, wc_in=B['wc_in'],
                F_MeOH=B['meoh_kg_h'] * 1e3 / 3600, F_H2O=B['meoh_kg_h'] * p['steam_ratio'] * 1e3 / 3600)
    return dict(area_m2=A, Ug_prod=ug, bed_fill=fill, whsv_h=whsv, cstr_S_gas=c['S_gas'], cstr_conv=c['conv'],
                cstr_wc=c['wc'], cstr_ratio=c['ratio'], cstr_Y=c['S_gas'] * min(c['conv'], 100.0) / 100.0)


def canon(d): return {k: round(float(d[k]), ROUND[k]) for k in KEYS}


def hash_of(p): return hashlib.sha256(json.dumps(canon(p), sort_keys=True).encode()).hexdigest()[:10]


class ScaleUp(Study):
    code_suffix = '.json'

    def __init__(self, work_root=None, staged=True):
        R = self.RUN = CFG['run']; TH = self.TH = CFG['thresholds']
        self.name = f"scaleup-v{CFG['version']}"
        self.work_root = work_root or R['work_root']
        self.base_case = os.path.join(self.work_root, 'template')
        self.cfd_trial, self.np, self.reserve_cores = R['cfd_trial'], R['np'], R['reserve_cores']
        self.accept_min_gain, self.accept_kappa = TH['accept_min_gain'], TH['accept_kappa']
        self.screen_margin, self.screen_kappa = TH['screen_margin'], TH['screen_kappa']
        self.staged = staged
        self.control_path = os.path.join(HERE, 'control.json')
        self.base_conv = derived(canon(CFG['base']))['cstr_conv']
        self.task = '放大设计研究使用内置 CSTR 代理采样，不调用 LLM。'

    def init_template(self):
        """用生成器按基准工况建模板（system/constant/0）；模板只读，试验目录各自重新生成"""
        import shutil, subprocess
        if os.path.exists(self.base_case): return f'模板已存在 {self.base_case}'
        tmp = self.base_case + '.gen'; pj = tmp + '.json'
        os.makedirs(os.path.dirname(tmp), exist_ok=True)
        json.dump(dict(base='commercial', **{k: CFG['base'][k] for k in KEYS}), open(pj, 'w'))
        subprocess.run(['python3', os.path.join(HERE, 'gen_scale.py'), 'custom', tmp, str(self.np)], check=True,
                       env=dict(os.environ, GEN_PARAMS=pj, MAXDT=str(self.RUN['max_dt'])))
        os.makedirs(self.base_case)
        for sub in ('system', 'constant'): shutil.copytree(os.path.join(tmp, sub), os.path.join(self.base_case, sub))
        shutil.copytree(os.path.join(tmp, '0.orig'), os.path.join(self.base_case, '0'))
        shutil.rmtree(tmp); os.remove(pj)
        return f'模板已建 {self.base_case}'

    # ---- 保真度 ----
    def fidelities(self):
        full = Fidelity('full', dict(CFG['run']['full']), full=True)
        return [Fidelity('short', dict(CFG['run']['short'])), full] if self.staged else [full]

    # ---- 候选 ----
    def cell_of(self, p):
        de, te = CFG['cells']['D_edges'], CFG['cells']['T_edges']
        return f"D{sum(p['D_m'] >= e for e in de)}-T{sum(p['T_K'] >= e for e in te)}"

    def violations(self, p, f):
        C = CFG['constraints']; bad = []
        lo, hi = C['Ug_prod_m_s']
        if not lo <= f['Ug_prod'] <= hi: bad.append(f"表观气速 {f['Ug_prod']:.3f} m/s 超出 EMMS 拟合适用范围 [{lo}, {hi}]")
        if f['bed_fill'] > C['bed_fill_max']: bad.append(f"充填比 {f['bed_fill']:.3f} > {C['bed_fill_max']}（床层会顶到锥段）")
        if f['whsv_h'] > C['whsv_max_h']: bad.append(f"空速 {f['whsv_h']:.2f} h⁻¹ > {C['whsv_max_h']}")
        return bad

    def check(self, path):
        bad = []
        try: d = json.load(open(path, encoding='utf-8'))
        except (OSError, ValueError) as e: d = {}; bad.append(f'读不了候选：{e}')
        if d and set(d) != set(KEYS): bad.append(f'候选只能有 {", ".join(KEYS)} 五个键')
        try: p = canon(d)
        except (KeyError, TypeError, ValueError): p = None; bad.append('候选值缺失或不是数')
        feats = {}
        if p:
            for k, (lo, hi) in CFG['bounds'].items():
                if not lo <= p[k] <= hi: bad.append(f'{k} = {p[k]} 不在 [{lo}, {hi}]')
            if not bad:
                feats = dict(p, **derived(p)); bad += self.violations(p, feats)
        h = hash_of(p) if p else hashlib.sha256(repr(d).encode()).hexdigest()[:10]
        return dict(ok=not bad, violations=bad, hash=h, path=os.path.abspath(path),
                    cell=self.cell_of(p) if p and not bad else None, features=feats or dict(p or {}), params=p or {})

    def default_surrogate(self): return dict(bias=0.0, n=0)

    def surrogate(self, r, arch):
        """CSTR 收率 + 回标偏差；转化率门槛用"相对基准工况的变化量"平移到 CFD 参考值上
        （CSTR 在商业工况下比 2D CFD 低约 4.5 个百分点：94.2 vs 98.7，直接比门槛会把基准工况本身判成不达标）"""
        ft = r['features']
        if 'cstr_Y' not in ft: return 1e9
        eta = CFG['control_reference']['eta_MeOH_pct'] + ft['cstr_conv'] - self.base_conv
        pen = max(0.0, self.TH['eta_min_pct'] - eta) * 5
        return -(ft['cstr_Y'] + arch['surrogate'].get('bias', 0.0)) + pen

    def calibrate(self, trials, arch):
        d = [t['metrics_visible']['Y_pct'] - t['features']['cstr_Y'] for t in trials
             if (t.get('metrics_visible') or {}).get('Y_pct') is not None and 'cstr_Y' in (t.get('features') or {})]
        if len(d) < 3: return None
        b = sum(d) / len(d)
        return dict(bias=b, rmse=math.sqrt(sum((x - b) ** 2 for x in d) / len(d)), n=len(d))

    def propose_builtin(self, arch, n, out_dir, samples=400):
        """拟随机采样（种子 = 已有试验数，可复现）→ 违约束的丢掉 → 每个 MAP-Elites 格取代理最好、未试过的；已占格子降权"""
        os.makedirs(out_dir, exist_ok=True)
        rng = random.Random(1000 + len(arch['trials']))
        tried = set(arch['trials']) | {q['hash'] for q in arch.get('queue', [])}
        used = set(arch['cells']) | {q.get('cell') for q in arch.get('queue', [])}
        best = {}
        for _ in range(samples):
            p = canon({k: lo + (hi - lo) * rng.random() for k, (lo, hi) in CFG['bounds'].items()})
            h = hash_of(p)
            if h in tried: continue
            f = dict(p, **derived(p))
            if self.violations(p, f): continue
            c = self.cell_of(p); s = self.surrogate(dict(features=f), arch) + (0.5 if c in used else 0.0)
            if c not in best or s < best[c][0]: best[c] = (s, p, h)
        out = []
        for s, p, h in sorted(best.values(), key=lambda x: x[0])[:n]:
            fp = os.path.join(out_dir, f'scale_{h}.json')
            with open(fp, 'w', encoding='utf-8') as fh: json.dump(p, fh)
            out.append(fp)
        return out

    # ---- 试验 ----
    def trial_params(self, chk, fid, control):
        return dict(chk['params'], candidate_hash=chk['hash'], duration_s=fid.params['duration_s'],
                    avg_from_s=fid.params['avg_from_s'], max_dt=str(self.RUN['max_dt']), np=self.fidelity_np(fid),
                    control=bool(control))

    def pipeline(self, fid):
        to, TH = self.RUN['timeouts_ms'], self.TH
        dur, t0 = float(fid.params['duration_s']), float(fid.params['avg_from_s'])
        te = round(dur - 1e-4, 6)
        smin = TH['sample_min_full'] if fid.full else TH['sample_min_short']
        return dict(stages=dict(
            generate=dict(command=['python3', os.path.join(HERE, 'stage_generate.py')], timeoutMs=to['generate']),
            mesh=dict(command=['bash', os.path.join(HERE, 'stage_mesh.sh')], timeoutMs=to['mesh']),
            solve=dict(command=['bash', os.path.join(HERE, 'stage_solve.sh')], timeoutMs=to['solve']),
            verify=dict(command=['python3', os.path.join(HERE, 'verify.py')], timeoutMs=to['verify'])),
            acceptance=dict(
                endTime=te, objective='neg_Y',
                metrics=[dict(name='neg_Y', role='fit', min=-100, max=0),
                         dict(name='eta_MeOH_pct', role='fit', min=TH['eta_min_pct'], max=100),
                         dict(name='fit_consistent', role='fit', min=0, max=TH['fit_consistent_max']),
                         dict(name='sampleCount', role='fit', min=smin),
                         dict(name='inv_ratio', role='holdout', min=TH['inv_ratio_min'], max=TH['inv_ratio_max']),
                         dict(name='windowCoverage', role='holdout', min=TH['coverage_min'], max=1.0)],
                measurement=dict(windowStart=t0, windowEnd=te, windowMetric='windowCoverage', timingMetric='sampleCount',
                                 description=(f'2D wedge 从 CSTR 初值算 {dur:g} s，统计 {t0:g}–{dur:g} s；出口各组分质量流量'
                                              '（outletSpecies，每 20 步）窗口均值 ×72；前后半窗收率差作噪声；藏量守恒作留出检查。'))))

    # ---- 判据 ----
    def objective(self, m): return m['neg_Y']

    def noise(self, m): return 0.5 * m['fit_consistent']

    def control_check(self, m, valid):
        if not m: return False, 9.0
        d = m.get('kpi_dev_ref_max_pct', 9.0)
        return bool(valid and d <= self.TH['control_kpi_tol_pct']), d

    def context_text(self, arch):
        lines = []
        for h, t in arch['trials'].items():
            f, m = t.get('features') or {}, t.get('metrics_visible') or {}
            lines.append(f"- {h} {t.get('cell')} {t.get('state')} D={f.get('D_m')} H={f.get('H_m')} T={f.get('T_K')} "
                         f"inv={f.get('inv_t')} sr={f.get('steam_ratio')} Y={m.get('Y_pct')}")
        return '\n'.join(lines + [f"冠军 {arch['champion']}"])


def make(**kw): return ScaleUp(**kw)
