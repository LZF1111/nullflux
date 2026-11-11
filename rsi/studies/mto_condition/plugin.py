"""MTO 工况研究插件（进料缩放 × 床温），用来验证通用 RSI 核心不依赖分布板。
候选 = JSON 文件 {"feed_scale": f, "T_K": T}。网格、布孔与分布板对照相同（211 孔），mesh 阶段直接复用分布板的 stage_mesh.sh。
目标 neg_S（−气相 C2+C3 选择性，越小越好）；门槛：MeOH 转化率 ≥ eta_min。对照 = 基准工况，必须复现 kpi_paper_cfd ±1 %。
内置提议者：CSTR 代理（kinetics.solve）在网格上打分，按 MAP-Elites 格每格取最好、跳过已试过的；不需要 LLM。"""
import hashlib, importlib.util, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RSI_DIR = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, RSI_DIR); sys.path.insert(0, HERE)
from core.study import Study, Fidelity  # noqa: E402
import kinetics as K  # noqa: E402

CFG = json.load(open(os.path.join(HERE, 'config.json'), encoding='utf-8'))
DIST_DIR = os.path.join(RSI_DIR, 'distributor')


def _control_holes(dist_dir):
    spec = importlib.util.spec_from_file_location('layout_eval_cond', os.path.join(dist_dir, 'layout_eval.py'))
    L = importlib.util.module_from_spec(spec); spec.loader.exec_module(L)
    return L.check(os.path.join(dist_dir, 'seeds', 's0_uniform211.py'))['holes']


class MtoCondition(Study):
    code_suffix = '.json'

    def __init__(self, work_root=None, staged=True, dist_dir=DIST_DIR, grid=9):
        R = self.RUN = CFG['run']; TH = self.TH = CFG['thresholds']
        self.name = f"mto-cond-v{CFG['version']}"
        self.work_root = work_root or R['work_root']
        self.base_case = os.path.join(self.work_root, 'template')
        self.cfd_trial, self.np, self.reserve_cores = R['cfd_trial'], R['np'], R['reserve_cores']
        self.accept_min_gain, self.accept_kappa = TH['accept_min_gain'], TH['accept_kappa']
        self.screen_margin, self.screen_kappa = TH['screen_margin'], TH['screen_kappa']
        self.staged, self.dist_dir, self.grid = staged, dist_dir, grid
        self.holes = _control_holes(dist_dir)
        self.base_conv = K.solve(CFG['base']['T_K'], CFG['base']['feed_scale'])['conv']
        self.control_path = os.path.join(HERE, 'control.json')
        self.task = '工况研究使用内置 CSTR 代理采样，不调用 LLM。'

    def init_template(self):
        """从分布板模板复制（system/constant/0，不含网格；分布板模板本身是只读源，不改）"""
        import shutil
        if os.path.exists(self.base_case): return f'模板已存在 {self.base_case}'
        shutil.copytree(self.RUN['template_from'], self.base_case, symlinks=False)
        return f'模板已建 {self.base_case}'

    # ---- 保真度 ----
    def fidelities(self):
        full = Fidelity('full', dict(CFG['run']['full']), full=True)
        if not self.staged: return [full]
        return [Fidelity('short', dict(CFG['run']['short'])), full]

    # ---- 候选 ----
    def cell_of(self, f, T):
        fe, te = CFG['cells']['feed_edges'], CFG['cells']['T_edges']
        return f"f{sum(f >= e for e in fe)}-T{sum(T >= e for e in te)}"

    def check(self, path):
        d = json.load(open(path, encoding='utf-8'))
        bad = []
        if set(d) != {'feed_scale', 'T_K'}: bad.append('候选只能有 feed_scale 和 T_K 两个键')
        try: f, T = float(d.get('feed_scale')), float(d.get('T_K'))
        except (TypeError, ValueError): f = T = float('nan'); bad.append('feed_scale/T_K 不是数')
        (lo, hi), (tl, th) = CFG['bounds']['feed_scale'], CFG['bounds']['T_K']
        if not (lo <= f <= hi): bad.append(f'feed_scale {f} 不在 [{lo}, {hi}]')
        if not (tl <= T <= th): bad.append(f'T_K {T} 不在 [{tl}, {th}]')
        f, T = round(f, 4), round(T, 2)
        h = hashlib.sha256(json.dumps(dict(feed_scale=f, T_K=T), sort_keys=True).encode()).hexdigest()[:10]
        feats = dict(feed_scale=f, T_K=T)
        if not bad:
            c = K.solve(T, f); feats.update(cstr_S_gas=c['S_gas'], cstr_conv=c['conv'], cstr_wc=c['wc'])
        return dict(ok=not bad, violations=bad, hash=h, path=os.path.abspath(path), cell=self.cell_of(f, T) if not bad else None,
                    features=feats, params=dict(feed_scale=f, T_K=T))

    def default_surrogate(self): return dict(bias=0.0, n=0)

    def surrogate(self, r, arch):
        """CSTR 选择性 + 回标偏差（CFD − CSTR 的平均差）；转化率不达标的加罚分"""
        ft = r['features']
        if 'cstr_S_gas' not in ft: return 1e9
        # CSTR 绝对转化率比 CFD 低约 1.3 %（基准 98.65 vs 99.97）：用相对基准的变化量平移到 CFD 参考值上
        eta = CFG['control_reference']['eta_MeOH_pct'] + ft['cstr_conv'] - self.base_conv
        pen = max(0.0, self.TH['eta_min_pct'] - eta) * 10
        return -(ft['cstr_S_gas'] + arch['surrogate'].get('bias', 0.0)) + pen

    def calibrate(self, trials, arch):
        d = [t['metrics_visible']['S_C2C3_pct'] - t['features']['cstr_S_gas'] for t in trials
             if (t.get('metrics_visible') or {}).get('S_C2C3_pct') is not None and 'cstr_S_gas' in (t.get('features') or {})]
        if len(d) < 3: return None
        b = sum(d) / len(d)
        return dict(bias=b, rmse=math.sqrt(sum((x - b) ** 2 for x in d) / len(d)), n=len(d))

    def propose_builtin(self, arch, n, out_dir):
        os.makedirs(out_dir, exist_ok=True)
        (lo, hi), (tl, th) = CFG['bounds']['feed_scale'], CFG['bounds']['T_K']
        g = self.grid; tried = set(arch['trials']) | {q['hash'] for q in arch.get('queue', [])}
        best = {}
        for i in range(g):
            for j in range(g):
                d = dict(feed_scale=round(lo + (hi - lo) * i / (g - 1), 4), T_K=round(tl + (th - tl) * j / (g - 1), 2))
                h = hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()[:10]
                if h in tried: continue
                r = dict(features=dict(feed_scale=d['feed_scale'], T_K=d['T_K'], **{
                    'cstr_' + k: v for k, v in K.solve(d['T_K'], d['feed_scale']).items() if k in ('S_gas', 'conv', 'wc')}))
                s = self.surrogate(r, arch); c = self.cell_of(d['feed_scale'], d['T_K'])
                if c in arch['cells'] or c in {q.get('cell') for q in arch.get('queue', [])}: s += 0.5   # 已有格子降权
                if c not in best or s < best[c][0]: best[c] = (s, d, h)
        out = []
        for s, d, h in sorted(best.values(), key=lambda x: x[0])[:n]:
            p = os.path.join(out_dir, f'cond_{h}.json')
            with open(p, 'w', encoding='utf-8') as fh: json.dump(d, fh)
            out.append(p)
        return out

    # ---- 试验 ----
    def trial_params(self, chk, fid, control):
        R = self.RUN
        return dict(holes=self.holes, candidate_hash=chk['hash'], feed_scale=chk['params']['feed_scale'], T_K=chk['params']['T_K'],
                    t0=R['t0'], duration_s=fid.params['duration_s'], window_s=fid.params['window_s'],
                    write_interval_s=R['write_interval_s'], np=self.fidelity_np(fid), control=bool(control))

    def pipeline(self, fid):
        to, TH = self.RUN['timeouts_ms'], self.TH
        dur, win = fid.params['duration_s'], fid.params['window_s']
        te = round(float(self.RUN['t0']) + dur - 1e-4, 6)
        smin = TH['sample_min_full'] if fid.full else TH['sample_min_short']
        return dict(stages=dict(
            generate=dict(command=['python3', os.path.join(HERE, 'stage_generate.py')], timeoutMs=to['generate']),
            mesh=dict(command=['bash', os.path.join(self.dist_dir, 'stage_mesh.sh')], timeoutMs=to['mesh']),
            solve=dict(command=['bash', os.path.join(HERE, 'stage_solve.sh')], timeoutMs=to['solve']),
            verify=dict(command=['python3', os.path.join(HERE, 'verify.py')], timeoutMs=to['verify'])),
            acceptance=dict(
                endTime=te, objective='neg_S',
                metrics=[dict(name='neg_S', role='fit', min=-100, max=0),
                         dict(name='eta_MeOH_pct', role='fit', min=TH['eta_min_pct'], max=100),
                         dict(name='fit_consistent', role='fit', min=0, max=TH['fit_consistent_max']),
                         dict(name='sampleCount', role='fit', min=smin),
                         dict(name='windowCoverage', role='holdout', min=TH['coverage_min'], max=1.0)],
                measurement=dict(windowStart=round(te - win, 6), windowEnd=te, windowMetric='windowCoverage', timingMetric='sampleCount',
                                 description=(f'续算 {dur} s，统计后 {win} s；z=1.0 m 截面 speciesZ1（每 50 步）窗口均值；'
                                              'M_IN 按 feed_scale 缩放；前后半窗选择性差作噪声。'))))

    # ---- 判据 ----
    def objective(self, m): return m['neg_S']

    def noise(self, m): return 0.5 * m['fit_consistent']

    def control_check(self, m, valid):
        if not m: return False, 9.0
        d = m.get('kpi_dev_ref_max_pct', 9.0)
        return bool(valid and d <= self.TH['control_kpi_tol_pct']), d

    def context_text(self, arch):
        lines = [f"- {h} {t.get('cell')} {t.get('state')} f={t['features'].get('feed_scale')} T={t['features'].get('T_K')} "
                 f"S={(t.get('metrics_visible') or {}).get('S_C2C3_pct')}" for h, t in arch['trials'].items()]
        return '\n'.join(lines + [f"冠军 {arch['champion']}"])


def make(**kw): return MtoCondition(**kw)
