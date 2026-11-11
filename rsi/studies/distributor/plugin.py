"""分布板布孔研究插件：把 rsi/distributor 的 check/代理/流水线/判据接到通用核心上。
不复制评估代码：layout_eval、stage_*、verify 仍用 rsi/distributor 里的那一份（DIST_DIR 可改指部署目录）。
staged=False 时与旧 rsi.py 完全同口径（回归测试要求）；staged=True 时先跑短续算筛掉明显更差的候选。"""
import importlib.util, math, os, sys

CORE_PARENT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, CORE_PARENT)
from core.study import Study, Fidelity  # noqa: E402

DEFAULT_DIST = os.path.join(CORE_PARENT, 'distributor')


def _load_layout_eval(dist_dir):
    spec = importlib.util.spec_from_file_location('layout_eval', os.path.join(dist_dir, 'layout_eval.py'))
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


class Distributor(Study):
    code_suffix = '.py'

    def __init__(self, dist_dir=DEFAULT_DIST, work_root=None, staged=False, screen=None):
        self.dir = dist_dir
        self.L = _load_layout_eval(dist_dir)
        C = self.C = self.L.CONTRACT; RUN = self.RUN = C['run']; self.TH = C['thresholds']
        self.name = f"dist-v{C['version']}"
        self.work_root = work_root or RUN['work_root']
        self.base_case = os.path.join(self.work_root, 'template')
        self.cfd_trial = RUN['cfd_trial']
        self.np, self.reserve_cores = RUN['np'], RUN['reserve_cores']
        self.sealed = tuple(C['roles']['sealed'])
        self.accept_min_gain, self.accept_kappa = self.TH['accept_min_gain'], self.TH['accept_kappa']
        self.staged = staged
        # 短续算：1.5 s，统计后 1 s（10 个写出时刻）。只用于淘汰明显更差的，阈值放宽到 2 倍噪声 + 0.02
        self.screen = dict(duration_s=1.5, window_s=1.0, sample_min=9, fit_consistent_max=0.15, **(screen or {}))
        self.screen_margin, self.screen_kappa = 0.02, 2.0
        self.control_path = os.path.join(dist_dir, 'seeds', 's0_uniform211.py')
        self.task = self._task()

    def _task(self):
        src = open(os.path.join(self.dir, 'campaign.py'), encoding='utf-8').read()
        i = src.index('TASK = """') + len('TASK = """'); return src[i:src.index('"""', i)]

    # ---- 保真度 ----
    def fidelities(self):
        full = Fidelity('full', dict(duration_s=self.RUN['duration_s'], window_s=self.RUN['window_s']), full=True)
        if not self.staged: return [full]
        return [Fidelity('short', dict(duration_s=self.screen['duration_s'], window_s=self.screen['window_s'])), full]

    # ---- 候选 ----
    def check(self, path): return self.L.check(path)

    def default_surrogate(self): return dict(lam=0.03, amp=0.6)

    def surrogate(self, r, arch):
        L = self.L; s = arch['surrogate']; xs = [i / 20 - 1 for i in range(41)]
        hs = [tuple(h) for h in r['holes']]
        return 0.5 * (L.paper_rmse(xs, L.surrogate_line(hs, 0.06, xs, s['lam'], s['amp']), '0.06') +
                      L.paper_rmse(xs, L.surrogate_line(hs, 0.1, xs, s['lam'], s['amp']), '0.1'))

    def calibrate(self, trials, arch):
        done = [t for t in trials if (t.get('metrics_visible') or {}).get('loss_fig12b') is not None]
        if len(done) < 3: return None
        best = None; orig = arch['surrogate']
        for lam in (0.01, 0.02, 0.03, 0.05, 0.08):
            for amp in (0.2, 0.4, 0.6, 0.9, 1.2):
                arch['surrogate'] = dict(lam=lam, amp=amp)
                err = sum((self.surrogate(self.L.check(t['path']), arch) - t['metrics_visible']['loss_fig12b']) ** 2 for t in done)
                if best is None or err < best[0]: best = (err, lam, amp)
        arch['surrogate'] = orig
        return dict(lam=best[1], amp=best[2], rmse=math.sqrt(best[0] / len(done)), n=len(done))

    # ---- 试验 ----
    def trial_params(self, chk, fid, control):
        R = self.RUN
        return dict(holes=chk['holes'], candidate_hash=chk['hash'], t0=R['t0'], duration_s=fid.params['duration_s'],
                    window_s=fid.params['window_s'], write_interval_s=R['write_interval_s'], np=self.fidelity_np(fid),
                    control=bool(control))

    def acceptance(self, fid):
        R, TH = self.RUN, dict(self.TH)
        dur, win = fid.params['duration_s'], fid.params['window_s']
        # 短算 1 s 窗只有 10 个写出时刻，跨度 0.9 s：覆盖率正好卡在 0.9，放宽到 0.85
        if not fid.full: TH.update(sample_min=self.screen['sample_min'], fit_consistent_max=self.screen['fit_consistent_max'],
                                   coverage_min=self.screen.get('coverage_min', 0.85))
        te = round(float(R['t0']) + dur - 1e-4, 6)
        return dict(
            endTime=te, objective='loss_fig12b',
            metrics=[
                dict(name='loss_fig12b', role='fit', min=0, max=10),
                dict(name='kpi_dev_max_pct', role='fit', min=0, max=TH['kpi_dev_max_pct']),
                dict(name='fit_consistent', role='fit', min=0, max=TH['fit_consistent_max']),
                dict(name='sampleCount', role='fit', min=TH['sample_min']),
                dict(name='z04_min_over_wall', role='holdout', min=TH['z04_min_over_wall_min']),
                dict(name='leak_frac', role='holdout', min=0, max=TH['leak_frac_max']),
                dict(name='windowCoverage', role='holdout', min=TH['coverage_min'], max=1.0)],
            measurement=dict(
                windowStart=round(te - win, 6), windowEnd=round(te, 6), windowMetric='windowCoverage', timingMetric='sampleCount',
                description=(f"续算 {dur} s，前 {dur - win:.1f} s 丢弃，统计后 {win} s；"
                             f"写出间隔 {R['write_interval_s']} s。Fig.12b 取各写出时刻 C2H4 算术平均后的 y=0 线（|y|<h/2，x 20 箱，÷壁），"
                             "与原文估读点比 RMSE；前后半窗各算一次作一致性。KPI 取 z=1.0 m 截面 speciesZ1 窗口均值。")))

    def pipeline(self, fid):
        to, d = self.RUN['timeouts_ms'], self.dir
        return dict(stages=dict(
            generate=dict(command=['python3', os.path.join(d, 'stage_generate.py')], timeoutMs=to['generate']),
            mesh=dict(command=['bash', os.path.join(d, 'stage_mesh.sh')], timeoutMs=to['mesh']),
            solve=dict(command=['bash', os.path.join(d, 'stage_solve.sh')], timeoutMs=to['solve']),
            verify=dict(command=['python3', os.path.join(d, 'verify.py')], timeoutMs=to['verify'])), acceptance=self.acceptance(fid))

    # ---- 判据 ----
    def objective(self, m): return m['loss_fig12b']

    def noise(self, m): return 0.5 * m['fit_consistent']

    def control_check(self, m, valid):
        ref = self.C['control_reference']['line_min_over_wall_006']
        d = abs(m.get('min_over_wall_006', 9) - ref) if m else 9
        return bool(valid and d <= self.TH['control_tol']), d

    # ---- 上下文 ----
    def context_text(self, arch):
        import json
        lines = ['## 约束（不可改）', json.dumps(self.L.context(), ensure_ascii=False),
                 '## 目标：Fig.12b 原文点（÷壁）', json.dumps(self.C['targets']['fig12b'], ensure_ascii=False)]

        def num(v, p):
            try: return f'{float(v):.{p}f}'
            except (TypeError, ValueError): return 'nan'
        for h, t in sorted(arch['trials'].items(), key=lambda kv: kv[1].get('started', 0)):
            mv = t.get('metrics_visible') or {}; ft = t.get('features') or {}; tag = ''
            if not mv and (t.get('fidelity') or {}).get('short', {}).get('metrics_visible'):
                mv = t['fidelity']['short']['metrics_visible']; tag = '[短算 1.5 s] '   # 被分级淘汰的也给提议者看
            lines.append(f"- {h} {tag}cell={t.get('cell')} state={t.get('state')} n={ft.get('n_holes')} d={num(ft.get('d_eq_mm'), 2)}mm "
                         f"r/R={num(ft.get('r_mean_over_R'), 2)} loss={num(mv.get('loss_fig12b'), 4)} "
                         f"min006={num(mv.get('min_over_wall_006'), 3)} min010={num(mv.get('min_over_wall_010'), 3)} "
                         f"kpi_dev={num(mv.get('kpi_dev_max_pct'), 2)}% sur={num(t.get('surrogate'), 3)}")
        lines.append(f"## 冠军 {arch['champion']}；格子 {json.dumps(arch['cells'])}")
        return '\n'.join(lines)


def make(**kw): return Distributor(**kw)
