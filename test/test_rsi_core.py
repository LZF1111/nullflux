"""通用 RSI 核心回归：分布板插件（staged=False）必须与旧 rsi/distributor/rsi.py 逐项一致；
再测并行调度（按空闲核启动、非阻塞、重启后收割）和分级筛选（短算淘汰/晋级）。不跑 CFD。"""
import copy, json, os, random, shutil, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RSI = os.path.join(HERE, '..', 'rsi')
sys.path.insert(0, os.path.join(RSI, 'distributor')); sys.path.insert(0, RSI)
import layout_eval as L  # noqa: E402
import rsi as OLD  # noqa: E402
import campaign as OLDK  # noqa: E402
from core import load_study  # noqa: E402
from core import archive as A, propose as P  # noqa: E402
from core.scheduler import Scheduler  # noqa: E402

SEEDS = [os.path.join(RSI, 'distributor', 'seeds', s) for s in ('s0_uniform211.py', 's1_few_large.py', 's2_edge_bias.py')]


def synth_trials(rng, n):
    """合成档案：随机目标/噪声/格子，含对照、无效证据和缺指标的试验"""
    tr = {}
    for i in range(n):
        h = f'h{i:02d}'
        tr[h] = dict(hash=h, cell=f'n{rng.randint(0, 3)}-r{rng.randint(0, 2)}', control=False, evidence_verified=rng.random() > 0.15,
                     metrics_visible=dict(loss_fig12b=rng.uniform(0.02, 0.3), fit_consistent=rng.uniform(0, 0.06),
                                          min_over_wall_006=rng.uniform(0.4, 1.0)))
    return tr


class DistributorRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.S = load_study('distributor')

    def test_identity_and_paths(self):
        S = self.S
        self.assertEqual(S.name, OLD.STUDY)
        self.assertEqual(S.base_case, OLD.TEMPLATE)
        self.assertEqual(S.work_root, OLD.ROOT)
        self.assertEqual(set(S.sealed), OLD.SEALED)
        self.assertEqual(S.task, OLDK.TASK)
        sch = Scheduler(S, busy_cores=lambda: 0, cpus=96)
        self.assertEqual(sch.trial_dir('abc', 'full'), os.path.join(OLD.ROOT, 'trials', 'abc'))
        self.assertEqual(sch.trial_id('abc', 'full'), 'abc')
        self.assertEqual(sch.spec_path('full'), os.path.join(OLD.ROOT, 'study_spec.json'))

    def test_pipeline_and_acceptance_identical(self):
        f = self.S.fidelities(); self.assertEqual(len(f), 1)
        self.assertEqual(json.dumps(self.S.pipeline(f[0]), sort_keys=True), json.dumps(OLD.pipeline(), sort_keys=True))

    def test_params_identical(self):
        f = self.S.fidelities()[0]; R = OLD.RUN
        for s in SEEDS:
            r = L.check(s)
            for ctl in (False, True):
                old = dict(holes=r['holes'], candidate_hash=r['hash'], t0=R['t0'], duration_s=R['duration_s'], window_s=R['window_s'],
                           write_interval_s=R['write_interval_s'], np=R['np'], control=ctl)
                self.assertEqual(self.S.trial_params(r, f, ctl), old)

    def test_check_hash_cell_surrogate_identical(self):
        arch = OLD.load_arch() if not os.path.exists(OLD.ARCH) else dict(surrogate=dict(lam=0.03, amp=0.6))
        for s in SEEDS:
            a, b = L.check(s), self.S.check(s)
            self.assertEqual((a['hash'], a['cell'], a['ok']), (b['hash'], b['cell'], b['ok']))
            for sur in (dict(lam=0.03, amp=0.6), dict(lam=0.08, amp=0.2)):
                arch['surrogate'] = sur
                self.assertEqual(OLD.surrogate_for(a, arch), self.S.surrogate(b, arch))

    def test_decide_identical_on_synthetic_archives(self):
        rng = random.Random(7)
        for k in range(200):
            tr = synth_trials(rng, rng.randint(1, 8))
            hs = list(tr)
            base = dict(champion=rng.choice(hs + [None]), control=None, cells={}, trials=tr, surrogate={})
            for h in rng.sample(hs, rng.randint(0, len(hs))): base['cells'][tr[h]['cell']] = h
            new = dict(hash='new', cell=f'n{rng.randint(0, 3)}-r{rng.randint(0, 2)}', control=rng.random() < 0.15,
                       evidence_verified=rng.random() > 0.1,
                       metrics_visible=dict(loss_fig12b=rng.uniform(0.02, 0.3), fit_consistent=rng.uniform(0, 0.06),
                                            min_over_wall_006=rng.uniform(0.9, 1.03)))
            res = dict(passed=rng.random() > 0.1)
            a1, a2 = copy.deepcopy(base), copy.deepcopy(base)
            r1, r2 = copy.deepcopy(new), copy.deepcopy(new)
            a1['trials']['new'] = r1; a2['trials']['new'] = r2
            OLD.decide(a1, r1, res); A.decide(self.S, a2, r2, res)
            self.assertEqual(json.dumps(a1, sort_keys=True), json.dumps(a2, sort_keys=True), k)

    def test_calibrate_identical(self):
        rng = random.Random(3)
        trials = {}
        for i, s in enumerate(SEEDS * 2):
            r = L.check(s); trials[f't{i}'] = dict(path=s, metrics_visible=dict(loss_fig12b=rng.uniform(0.05, 0.3)))
        a = dict(surrogate=dict(lam=0.03, amp=0.6), trials=trials)
        got = self.S.calibrate(list(trials.values()), a)
        self.assertEqual(a['surrogate'], dict(lam=0.03, amp=0.6))   # 插件不改原存档
        d = tempfile.mkdtemp(); old_arch = OLD.ARCH
        try:
            OLD.ARCH = os.path.join(d, 'archive.json'); OLD.ROOT_ = d
            json.dump(dict(study='x', champion=None, control=None, cells={}, trials=trials, surrogate=dict(lam=0.03, amp=0.6)),
                      open(OLD.ARCH, 'w'))
            orig_root = OLD.ROOT; OLD.ROOT = d
            try: OLD.cmd_calibrate(None)
            finally: OLD.ROOT = orig_root
            self.assertEqual(json.load(open(OLD.ARCH))['surrogate'], got)
        finally:
            OLD.ARCH = old_arch; shutil.rmtree(d, ignore_errors=True)

    def test_pick_diverse_and_extract_identical(self):
        rng = random.Random(1)
        for _ in range(100):
            cs = [dict(hash=f'c{i}', cell=f'x{rng.randint(0, 3)}', surrogate=rng.random()) for i in range(rng.randint(0, 8))]
            tried = {c['hash'] for c in cs if rng.random() < 0.3}; k = rng.randint(1, 4)
            self.assertEqual(OLDK.pick_diverse(cs, tried, k), P.pick_diverse(cs, tried, k))
        for s in ('x\n```python\ndef layout(c): return []\n```', '```py\r\nA\r\n```', '```\nB\n```', 'no', None):
            self.assertEqual(OLDK.extract_code(s), P.extract_code(s))

    def test_context_identical(self):
        rng = random.Random(5)
        tr = synth_trials(rng, 5); tr['h01']['metrics_visible'] = {'loss_fig12b': None}; tr['run'] = dict(state='running')
        arch = dict(trials=tr, champion='h00', cells={'n1-r1': 'h00'})
        self.assertEqual(OLD.context_text(arch), self.S.context_text(arch))

    def test_n_done_identical(self):
        rng = random.Random(9); tr = synth_trials(rng, 6); tr['h02']['metrics_visible'] = {}
        tr['h03']['metrics_visible'] = {'loss_fig12b': None}
        arch = dict(trials=tr)
        self.assertEqual(OLDK.n_done(arch), A.n_done(self.S, arch))


class FakeCluster:
    """假的 cfd_trial：launcher 只记下配置；finish(h) 写出 trial-result.json / metrics.json，进程随之"结束"。"""
    def __init__(self, metrics_for):
        self.metrics_for, self.alive, self.started, self.pid = metrics_for, set(), [], 100

    def launch(self, cpath, out):
        self.pid += 1; cfg = json.load(open(cpath)); self.started.append(cfg); self.alive.add(self.pid)
        cfg['_pid'] = self.pid; return self.pid

    def finish(self, tid, passed=True):
        cfg = next(c for c in self.started if c['trialId'] == tid)
        os.makedirs(cfg['trialDir'], exist_ok=True)
        m = getattr(self, 'metrics_override', {}).get(tid) or self.metrics_for(cfg)
        json.dump(m, open(os.path.join(cfg['trialDir'], 'metrics.json'), 'w'))
        json.dump(dict(passed=passed, value=m['loss_fig12b']), open(os.path.join(cfg['trialDir'], 'trial-result.json'), 'w'))
        self.alive.discard(cfg['_pid'])


def metrics(loss, fc=0.01, m006=0.962):
    return dict(loss_fig12b=loss, fit_consistent=fc, min_over_wall_006=m006, plateau_m=0.2)


class Scheduling(unittest.TestCase):
    def make(self, staged, losses):
        self.tmp = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, self.tmp, True)
        S = load_study('distributor', work_root=self.tmp, staged=staged)
        hmap = {L.check(s)['hash']: s for s in SEEDS}

        def mf(cfg):
            h = cfg['params']['candidate_hash']; fid = 'short' if cfg['params']['duration_s'] < 3 else 'full'
            return metrics(losses[(os.path.basename(hmap[h]), fid)])
        fc = FakeCluster(mf)
        sch = Scheduler(S, busy_cores=lambda: 0, cpus=96, launcher=fc.launch, verifier=lambda *a: (True, ''),
                        alive=lambda pid: pid in fc.alive, log=lambda *a: None)
        return S, sch, fc

    def chk(self, S, i): return S.check(SEEDS[i])

    def test_control_first_then_parallel_bounded_by_cores(self):
        loss = {('s0_uniform211.py', 'full'): 0.20, ('s1_few_large.py', 'full'): 0.10, ('s2_edge_bias.py', 'full'): 0.19}
        S, sch, fc = self.make(False, loss)
        self.assertFalse(sch.enqueue(self.chk(S, 1))[0])           # 没有对照不收普通候选
        self.assertTrue(sch.enqueue(self.chk(S, 0), control=True)[0])
        self.assertTrue(sch.enqueue(self.chk(S, 1))[0]); self.assertTrue(sch.enqueue(self.chk(S, 2))[0])
        self.assertFalse(sch.enqueue(self.chk(S, 2))[0])           # 重复
        st = sch.tick(); self.assertEqual((st['started'], st['running'], st['queued']), (1, 1, 2))   # 对照没完先不跑别的
        h0 = self.chk(S, 0)['hash']; fc.finish(h0)
        st = sch.tick(); self.assertEqual(st['reaped'], 1); self.assertEqual(st['started'], 2)       # 88 核 / 24 → 并行 2 个还有余
        a = sch.load(); self.assertEqual(a['control']['state'], 'control_ok'); self.assertEqual(a['champion'], h0)
        h1, h2 = self.chk(S, 1)['hash'], self.chk(S, 2)['hash']
        self.assertEqual({a['trials'][h1]['state'], a['trials'][h2]['state']}, {'running'})
        fc.finish(h2); fc.finish(h1); sch.tick()
        a = sch.load()
        self.assertEqual(a['trials'][h1]['state'], 'accepted'); self.assertEqual(a['champion'], h1)
        self.assertEqual(a['trials'][h2]['state'], 'rejected')   # 增益 0.01 不超过噪声门槛
        self.assertTrue(sch.idle())
        self.assertEqual(json.load(open(os.path.join(self.tmp, 'study_spec.json')))['study_id'], S.name)

    def test_respects_busy_cores(self):
        S, sch, fc = self.make(False, {('s0_uniform211.py', 'full'): 0.2})
        sch.busy_cores = lambda: 70                                # 96-8-70 = 18 < 24
        sch.enqueue(self.chk(S, 0), control=True)
        self.assertEqual(sch.tick()['started'], 0)
        sch.busy_cores = lambda: 64
        self.assertEqual(sch.tick()['started'], 1)

    def test_restart_reaps_from_disk(self):
        S, sch, fc = self.make(False, {('s0_uniform211.py', 'full'): 0.2})
        sch.enqueue(self.chk(S, 0), control=True); sch.tick()
        fc.finish(self.chk(S, 0)['hash'])
        sch2 = Scheduler(S, busy_cores=lambda: 0, cpus=96, launcher=fc.launch, verifier=lambda *a: (True, ''),
                         alive=lambda pid: pid in fc.alive, log=lambda *a: None)
        self.assertEqual(sch2.tick()['reaped'], 1); self.assertEqual(sch2.load()['control']['state'], 'control_ok')

    def test_staged_prunes_clearly_worse_and_promotes_rest(self):
        loss = {('s0_uniform211.py', 'short'): 0.20, ('s0_uniform211.py', 'full'): 0.20,
                ('s1_few_large.py', 'short'): 0.12, ('s1_few_large.py', 'full'): 0.10,
                ('s2_edge_bias.py', 'short'): 0.30}
        S, sch, fc = self.make(True, loss)
        h0, h1, h2 = (self.chk(S, i)['hash'] for i in range(3))
        sch.enqueue(self.chk(S, 0), control=True); sch.tick()
        self.assertEqual(fc.started[-1]['trialId'], h0 + '-short')
        self.assertEqual(fc.started[-1]['acceptance']['metrics'][3]['min'], S.screen['sample_min'])
        fc.finish(h0 + '-short'); sch.tick()                       # 对照短算总是晋级 → 对照完整级
        self.assertEqual(fc.started[-1]['trialId'], h0 + '-full')
        sch.enqueue(self.chk(S, 1)); sch.enqueue(self.chk(S, 2))
        fc.finish(h0 + '-full'); sch.tick()
        self.assertEqual(sch.load()['control']['state'], 'control_ok')
        self.assertEqual(sorted(c['trialId'] for c in fc.started[-2:]), sorted([h1 + '-short', h2 + '-short']))
        fc.finish(h1 + '-short'); fc.finish(h2 + '-short'); sch.tick()
        a = sch.load()
        self.assertEqual(a['trials'][h2]['state'], 'pruned')       # 0.30 vs 0.20：差 0.10 > 0.02 + 2·hypot(0.005,0.005)
        self.assertNotIn(h2, a['cells'].values())
        self.assertEqual(fc.started[-1]['trialId'], h1 + '-full')
        fc.finish(h1 + '-full'); sch.tick()
        a = sch.load(); self.assertEqual(a['trials'][h1]['state'], 'accepted'); self.assertEqual(a['champion'], h1)
        self.assertTrue(sch.idle())
        self.assertTrue(os.path.exists(os.path.join(self.tmp, 'study_spec_short.json')))

    def test_staged_uses_full_control_as_cross_fidelity_reference(self):
        # 对照由旧流水线只跑了完整级别：短算筛选退回用它的完整目标作参照
        loss = {('s1_few_large.py', 'short'): 0.30, ('s2_edge_bias.py', 'short'): 0.18, ('s2_edge_bias.py', 'full'): 0.15}
        S, sch, fc = self.make(True, loss)
        a = sch.load(); h0 = self.chk(S, 0)['hash']
        a['trials'][h0] = dict(hash=h0, cell='n4-r1', control=True, state='control_ok', metrics_visible=metrics(0.17, 0.0003))
        a['control'] = a['trials'][h0]; a['champion'] = h0; a['cells']['n4-r1'] = h0; sch.save(a)
        h1, h2 = self.chk(S, 1)['hash'], self.chk(S, 2)['hash']
        sch.enqueue(self.chk(S, 1)); sch.enqueue(self.chk(S, 2)); sch.tick()
        fc.finish(h1 + '-short'); fc.finish(h2 + '-short'); sch.tick()
        a = sch.load()
        self.assertEqual(a['trials'][h1]['state'], 'pruned')
        self.assertTrue(a['trials'][h1]['fidelity']['short']['screen_ref_cross'])
        self.assertEqual(a['trials'][h2]['state'], 'running')
        self.assertIn('[短算 1.5 s]', S.context_text(a))

    def test_speculative_runs_during_control_but_judges_after(self):
        loss = {('s0_uniform211.py', 'full'): 0.20, ('s1_few_large.py', 'full'): 0.10}
        S, sch, fc = self.make(False, loss)
        sch.speculative = True
        h0, h1 = self.chk(S, 0)['hash'], self.chk(S, 1)['hash']
        self.assertTrue(sch.enqueue(self.chk(S, 0), control=True)[0])
        self.assertTrue(sch.enqueue(self.chk(S, 1))[0])
        self.assertEqual(sch.tick()['started'], 2)                 # 对照在跑也启动候选
        fc.finish(h1); st = sch.tick()
        self.assertEqual(st['reaped'], 0)                          # 对照未判定：候选结果暂不登记
        self.assertEqual(sch.load()['trials'][h1]['state'], 'running')
        fc.finish(h0); sch.tick()
        a = sch.load()
        self.assertEqual(a['control']['state'], 'control_ok')
        self.assertEqual(a['trials'][h1]['state'], 'accepted'); self.assertEqual(a['champion'], h1)

    def test_speculative_candidate_discarded_when_control_fails(self):
        loss = {('s0_uniform211.py', 'full'): 0.20, ('s1_few_large.py', 'full'): 0.10}
        S, sch, fc = self.make(False, loss)
        sch.speculative = True
        h0, h1 = self.chk(S, 0)['hash'], self.chk(S, 1)['hash']
        sch.enqueue(self.chk(S, 0), control=True); sch.enqueue(self.chk(S, 1)); sch.tick()
        fc.metrics_override = {h0: dict(metrics(0.2), min_over_wall_006=0.5)}
        fc.finish(h1); fc.finish(h0); sch.tick(); sch.tick()
        a = sch.load()
        self.assertEqual(a['control']['state'], 'control_failed')
        self.assertNotEqual(a['trials'][h1]['state'], 'accepted')

    def test_claims_block_other_schedulers_until_solver_runs(self):
        S, sch, fc = self.make(False, {('s0_uniform211.py', 'full'): 0.2})
        cl = os.path.join(self.tmp, 'claims.json'); sch.claims = cl
        from core import claims as CL
        CL.add(cl, 'fine2', 64, owner='external')
        sch.enqueue(self.chk(S, 0), control=True)
        self.assertEqual(sch.tick()['started'], 1)               # 96-8-64 = 24 ≥ 24
        other = load_study('mto_condition', work_root=os.path.join(self.tmp, 'cond'))
        sch2 = Scheduler(other, busy_cores=lambda: 0, cpus=96, launcher=fc.launch, verifier=lambda *a: (True, ''),
                         alive=lambda pid: pid in fc.alive, log=lambda *a: None, claims=cl)
        self.assertEqual(sch2.free_cores(sch2.load()), 96 - 8 - 64 - 24)
        tid = fc.started[-1]['trialId']; os.makedirs(os.path.join(self.tmp, 'trials', tid, 'logs'), exist_ok=True)
        open(os.path.join(self.tmp, 'trials', tid, 'logs', 'solve.stdout.log'), 'w').write('Time = 118.82\n')
        sch.tick()                                               # 求解器起来了 → 登记撤销（之后由 busy_cores 计入）
        self.assertEqual(set(CL.read(cl)), {'fine2'})
        self.assertEqual(CL.read(cl, now=CL.time.time() + CL.MAX_AGE_S + 1), {})   # 过期失效


if __name__ == '__main__':
    unittest.main()
