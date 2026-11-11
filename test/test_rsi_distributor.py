"""分布器 RSI 框架回归：沙箱、5 % 锁定、制造约束、接受判据、合成可辨识性。不跑 CFD。"""
import json, math, os, sys, tempfile, unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rsi', 'distributor')
sys.path.insert(0, ROOT)
import layout_eval as L
import rsi as R


def write(src):
    f = tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8'); f.write(src); f.close(); return f.name


RING = '''
import math
def layout(ctx):
    R_R, R_M = ctx['R_R'], ctx['R_M']
    n = {n}; f = {f}
    r = math.sqrt(R_R ** 2 + f * (R_M ** 2 - R_R ** 2))
    d = 2e3 * math.sqrt(ctx['phi'] * (R_M ** 2 - R_R ** 2) / n) * {scale}
    return [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), d) for i in range(n)]
'''


class Sandbox(unittest.TestCase):
    def test_rejects_imports_and_escape(self):
        for bad in ('import os\ndef layout(c): return []', 'def layout(c): return open("x")',
                    'def layout(c): return ().__class__', 'def layout(c):\n    while True: pass'):
            with self.assertRaises(ValueError): L.validate_source(bad)

    def test_requires_layout(self):
        with self.assertRaises(ValueError): L.validate_source('def f(c): return []')


class Locking(unittest.TestCase):
    def test_seeds_pass_and_lock_5pct(self):
        a_ring = math.pi * (L.G['R_M'] ** 2 - L.G['R_R'] ** 2)
        for s in ('s0_uniform211.py', 's1_few_large.py', 's2_edge_bias.py'):
            r = L.check(os.path.join(ROOT, 'seeds', s))
            self.assertTrue(r['ok'], (s, r['violations']))
            a = sum(math.pi * (d * 1e-3) ** 2 / 4 for _, _, d in r['holes'])
            self.assertAlmostEqual(a / a_ring, 0.05, places=3)

    def test_wrong_opening_rejected(self):
        r = L.check(write(RING.format(n=24, f=0.5, scale=1.5)))   # 设计成 11 % 开孔
        self.assertFalse(r['ok']); self.assertTrue(any('缩放' in v for v in r['violations']))

    def test_overlap_and_ring_bounds(self):
        r = L.check(write(RING.format(n=400, f=0.0, scale=1.0)))  # 400 孔挤在内圈
        self.assertFalse(r['ok'])

    def test_control_matches_current_design(self):
        r = L.check(os.path.join(ROOT, 'seeds', 's0_uniform211.py'))
        self.assertEqual(r['features']['n_holes'], 211)
        self.assertAlmostEqual(r['features']['d_eq_mm'], 3.88, delta=0.05)   # pilot3D 平均孔 11.6 mm² → d≈3.8 mm


class Decide(unittest.TestCase):
    def arch(self):
        a = dict(champion='c0', control=None, cells={}, trials={}, surrogate={})
        a['trials']['c0'] = dict(hash='c0', cell='n4-r1', metrics_visible=dict(loss_fig12b=0.20, fit_consistent=0.02))
        a['cells']['n4-r1'] = 'c0'
        return a

    def rec(self, loss, fc, cell='n2-r2'):
        return dict(hash='c1', cell=cell, control=False, evidence_verified=True,
                    metrics_visible=dict(loss_fig12b=loss, fit_consistent=fc))

    def test_accept_only_beyond_noise(self):
        a = self.arch(); r = self.rec(0.17, 0.04); a['trials']['c1'] = r
        R.decide(a, r, dict(passed=True))
        self.assertEqual(r['state'], 'rejected')                        # 增益 0.03 < 2·hypot(0.02,0.01)=0.0447
        a = self.arch(); r = self.rec(0.10, 0.01); a['trials']['c1'] = r
        R.decide(a, r, dict(passed=True))
        self.assertEqual(r['state'], 'accepted'); self.assertEqual(a['champion'], 'c1')

    def test_invalid_evidence_never_accepted(self):
        a = self.arch(); r = self.rec(0.01, 0.0); r['evidence_verified'] = False; a['trials']['c1'] = r
        R.decide(a, r, dict(passed=True))
        self.assertEqual(r['state'], 'invalid'); self.assertEqual(a['champion'], 'c0')

    def test_control_gate(self):
        a = dict(champion=None, control=None, cells={}, trials={}, surrogate={})
        ref = L.CONTRACT['control_reference']['line_min_over_wall_006']
        r = dict(hash='k', cell='n4-r1', control=True, evidence_verified=True, metrics_visible=dict(min_over_wall_006=ref + 0.2))
        R.decide(a, r, dict(passed=True)); self.assertEqual(r['state'], 'control_failed')
        r['metrics_visible']['min_over_wall_006'] = ref + 0.01
        R.decide(a, r, dict(passed=True)); self.assertEqual(r['state'], 'control_ok'); self.assertEqual(a['champion'], 'k')


class SealedAndContract(unittest.TestCase):
    def test_sealed_not_in_acceptance_or_context(self):
        acc = R.acceptance(); names = {m['name'] for m in acc['metrics']}
        self.assertFalse(names & R.SEALED)
        self.assertEqual(acc['objective'], 'loss_fig12b')
        txt = R.context_text(dict(champion=None, control=None, cells={}, trials={}, surrogate={}))
        for s in R.SEALED: self.assertNotIn(s, txt)
        self.assertNotIn('fig12a_plateau_m', txt)

    def test_window_inside_run(self):
        acc = R.acceptance(); m = acc['measurement']; self.assertLess(m['windowStart'], m['windowEnd'])
        self.assertLessEqual(m['windowEnd'], acc['endTime'])          # cfd_trial.js validateConfig 要求
        self.assertLessEqual(m['windowEnd'] - m['windowStart'], R.RUN['duration_s'])

    def test_submit_refuses_unapproved(self):
        if L.CONTRACT.get('thresholds_status') == 'APPROVED': self.skipTest('已批准')
        with self.assertRaises(SystemExit): R.cmd_submit(type('A', (), dict(cand='x', control=False, dry=True))())


class SolveStage(unittest.TestCase):
    def test_solve_scripts_replace_dynamiccode_symlinks(self):
        # 2026-11-05 对照因 dynamicCode/*/lnInclude 符号链接被 cfd_trial 拒绝：求解后必须换成文件，且保留求解器退出码
        for p in (os.path.join(ROOT, 'stage_solve.sh'), os.path.join(ROOT, '..', 'studies', 'mto_condition', 'stage_solve.sh')):
            if not os.path.exists(p): continue      # 服务器上通用核心还没部署
            s = open(p, encoding='utf-8').read()
            self.assertNotIn('exec mpirun', s, p)
            self.assertIn('find dynamicCode -type l', s, p)
            self.assertIn('exit $rc', s, p)


class SyntheticIdentifiability(unittest.TestCase):
    """已知真值的合成反演（合同 P2）：用代理生成"观测"，只按 loss 在候选族里搜，必须找回真值附近的孔数。
    代理不是物理；这里只证明目标函数对孔数可辨识、搜索与评分逻辑没接错。"""
    def test_recovers_hole_count(self):
        xs = [i / 20 - 1 for i in range(41)]
        def holes(n):
            r = L.check(write(RING.format(n=n, f=0.6, scale=1.0)))
            return [tuple(h) for h in r['holes']], r['ok']
        truth, ok = holes(30); self.assertTrue(ok)
        obs = {Z: L.surrogate_line(truth, float(Z), xs) for Z in ('0.06', '0.1')}
        def loss(hs):
            return sum(math.sqrt(sum((a - b) ** 2 for a, b in zip(L.surrogate_line(hs, float(Z), xs), obs[Z])) / len(xs)) for Z in obs)
        grid = [12, 18, 24, 30, 40, 60, 90]
        scores = {n: loss(holes(n)[0]) for n in grid if holes(n)[1]}
        best = min(scores, key=scores.get)
        self.assertEqual(best, 30, scores)
        self.assertGreater(sorted(scores.values())[1], 1e-3)               # 次优明显差于真值 → 可辨识


class Campaign(unittest.TestCase):
    """无人值守循环的健壮性：代码块提取、多样性选择、模型断线、核不够等待、上下文容错。"""
    @classmethod
    def setUpClass(cls):
        import campaign as K; cls.K = K

    def test_extract_code_variants(self):
        K = self.K
        self.assertEqual(K.extract_code('x\n```python\ndef layout(c): return []\n```'), 'def layout(c): return []\n')
        self.assertEqual(K.extract_code('```py\r\nA\r\n```'), 'A\r\n')
        self.assertEqual(K.extract_code('```\nB\n```'), 'B\n')
        self.assertIsNone(K.extract_code('no code')); self.assertIsNone(K.extract_code(None))

    def test_pick_diverse(self):
        c = lambda h, cell, s: dict(hash=h, cell=cell, surrogate=s)
        cs = [c('a', 'x', .3), c('b', 'x', .1), c('c', 'y', .2), c('d', 'z', .05)]
        self.assertEqual([p['hash'] for p in self.K.pick_diverse(cs, {'d'}, 2)], ['b', 'c'])
        self.assertEqual([p['hash'] for p in self.K.pick_diverse(cs[:2], set(), 2)], ['b', 'a'])   # 格子不够时补足

    def test_llm_down_does_not_crash(self):
        def boom(_): raise OSError('fetch failed')
        out, err, down = self.K.propose(R.load_arch(), 3, 'prev', tempfile.mkdtemp(), llm=boom)
        self.assertEqual(out, []); self.assertTrue(down); self.assertEqual(err, 'prev')

    def test_submit_waits_when_cores_busy(self):
        import subprocess as sp
        calls, sleeps = [], []
        res = [sp.CompletedProcess([], 1, '', '核不够：已有 88'), sp.CompletedProcess([], 0, 'ok', '')]
        orig = self.K.subprocess.run
        self.K.subprocess.run = lambda *a, **k: (calls.append(1), res[len(calls) - 1])[1]
        try: p = self.K.submit_with_wait('x.py', 5, 3, sleep=sleeps.append)
        finally: self.K.subprocess.run = orig
        self.assertEqual(p.returncode, 0); self.assertEqual(len(calls), 2); self.assertEqual(sleeps, [5])

    def test_context_tolerates_failed_trial(self):
        arch = dict(trials={'h1': dict(cell='n1', state='invalid', features={}, metrics_visible={'loss_fig12b': None}),
                            'h2': dict(state='running')}, champion=None, cells={})
        txt = R.context_text(arch)
        self.assertIn('loss=nan', txt); self.assertIn('h2', txt)


if __name__ == '__main__':
    unittest.main()
