"""MTO 工况研究插件（通用路径验证）：动力学插值与现有 fvOptions 一致、generate 改对文件、verify 口径、
内置提议者、调度器端到端（假 CFD）。不跑 CFD。"""
import json, os, re, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RSI = os.path.join(HERE, '..', 'rsi')
COND = os.path.join(RSI, 'studies', 'mto_condition')
sys.path.insert(0, RSI); sys.path.insert(0, COND)
import kinetics as K  # noqa: E402
from core import load_study  # noqa: E402
from core.scheduler import Scheduler  # noqa: E402

K738 = [0.0027125361, 0.1144618532, 0.1605604942, 0.0355612759, 0.0775441285, 0.0499680451, 0.0568945234]
A738 = [0.06198, 0.09704, 0.18948, 0.38208, 0.27844, 0.36006, 0.38404]

FVOPT = '''        // 738 K：Table 3 两点 Arrhenius(k) / 线性(α) 插值
        static const scalar k[7] = {0.0027125361, 0.1144618532, 0.1605604942, 0.0355612759, 0.0775441285, 0.0499680451, 0.0568945234};
        static const scalar a[7] = {0.06198, 0.09704, 0.18948, 0.38208, 0.27844, 0.36006, 0.38404};
        const scalar k7 = 0.0568945234, a7 = 0.38404, nu7 = 1.0/6, M7 = 84.16, MMeOH = 32.042;
'''
UGAS = '''boundaryField
{
    inlet1     { type flowRateInletVelocity; massFlowRate constant 3.33333333e-05; rho thermo:rho.gas; value uniform (0 0 0); }
    inlet2     { type flowRateInletVelocity; massFlowRate constant 7.50000000e-03; rho thermo:rho.gas; value uniform (0 0 0); }
}
'''
TGAS = '''internalField uniform 738.0;
boundaryField
{
    inlet2     { type fixedValue; value uniform 738.0; }
    outlet5    { type inletOutlet; phi phi.gas; inletValue uniform 738.0; value uniform 738.0; }
}
'''
CDICT = 'startFrom latestTime;\nstartTime 0;\nstopAt endTime;\nendTime 200;\nwriteInterval 1;\nfunctions\n{\n    a { writeInterval 50; }\n}\n'


class Kinetics(unittest.TestCase):
    def test_interp_matches_current_fvoptions(self):
        k, a = K.interp(738.0)
        for x, y in zip(k, K738): self.assertAlmostEqual(x, y, places=9)
        for x, y in zip(a, A738): self.assertAlmostEqual(x, y, places=5)

    def test_interp_hits_table_points(self):
        self.assertAlmostEqual(K.interp(723.0)[0][1], 0.10030, places=9)
        self.assertAlmostEqual(K.interp(748.0)[1][3], 0.406, places=9)

    def test_cstr_base_close_to_reference(self):
        r = K.solve(738.0, 1.0)          # cstr_mto.py arr2 结果：wc≈5.6, 转化率 >97 %
        self.assertTrue(4.5 < r['wc'] < 7.0, r); self.assertGreater(r['conv'], 95); self.assertTrue(70 < r['S_gas'] < 90, r)

    def test_trend_more_feed_less_conversion(self):
        self.assertGreater(K.solve(738, 0.8)['conv'], K.solve(738, 1.2)['conv'])


class Generate(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, self.d, True)
        for sub in ('0', 'constant', 'system'): os.makedirs(os.path.join(self.d, sub))
        w = lambda p, s: open(os.path.join(self.d, p), 'w').write(s)
        w('0/U.gas', UGAS); w('0/T.gas', TGAS); w('0/T.particles', TGAS.replace('phi.gas', 'phi.particles'))
        w('constant/fvOptions', FVOPT); w('system/controlDict', CDICT); w('system/decomposeParDict', 'numberOfSubdomains 64;\n')

    def run_gen(self, f, T):
        p = dict(feed_scale=f, T_K=T, holes=[[0.05, 0, 4.0]], candidate_hash='x', t0='118.817922', duration_s=1.2,
                 window_s=0.6, write_interval_s=0.5, np=24)
        json.dump(p, open(os.path.join(self.d, 'trial-params.json'), 'w'))
        return subprocess.run([sys.executable, os.path.join(COND, 'stage_generate.py')], cwd=self.d, capture_output=True, text=True)

    def read(self, p): return open(os.path.join(self.d, p)).read()

    def test_edits_feed_temperature_kinetics_and_control(self):
        r = self.run_gen(1.1, 730.0); self.assertEqual(r.returncode, 0, r.stderr)
        u = self.read('0/U.gas')
        self.assertIn('massFlowRate constant 8.25000000e-03', u)
        self.assertIn('massFlowRate constant 3.33333333e-05', u)          # inlet1 不动
        for fld in ('0/T.gas', '0/T.particles'):
            t = self.read(fld); self.assertNotIn('738', t); self.assertEqual(t.count('730.0000'), 4)
        fv = self.read('constant/fvOptions'); k, a = K.interp(730.0)
        ks = [float(x) for x in re.search(r'k\[7\] = \{([^}]*)\}', fv).group(1).split(',')]
        for x, y in zip(ks, k): self.assertAlmostEqual(x, y, places=9)
        self.assertIn(f'k7 = {k[6]:.10f}, a7 = {a[6]:.5f},', fv)
        cd = self.read('system/controlDict')
        self.assertRegex(cd, r'(?m)^endTime\s+120\.017922;'); self.assertRegex(cd, r'(?m)^startFrom\s+startTime;')
        self.assertIn('a { writeInterval 50; }', cd)                    # 子字典不动
        self.assertIn('numberOfSubdomains 24;', self.read('system/decomposeParDict'))
        self.assertTrue(os.path.exists(os.path.join(self.d, 'holes.json')))

    def test_base_condition_keeps_fvoptions_numbers(self):
        self.assertEqual(self.run_gen(1.0, 738.0).returncode, 0)
        fv = self.read('constant/fvOptions')
        self.assertIn('{0.0027125361, 0.1144618532, 0.1605604942, 0.0355612759, 0.0775441285, 0.0499680451, 0.0568945234}', fv)
        self.assertIn('{0.06198, 0.09704, 0.18948, 0.38208, 0.27844, 0.36006, 0.38404}', fv)

    def test_out_of_bounds_refused(self):
        self.assertNotEqual(self.run_gen(1.5, 738.0).returncode, 0)
        self.assertNotEqual(self.run_gen(1.0, 760.0).returncode, 0)


def species_file(d, t0, t1, n, y, feed=1.0):
    """合成 speciesZ1.dat：列 t, MeOH, H2O, CH4, C2H4, C3H6, C3H8, C4H8, C5H10"""
    os.makedirs(os.path.join(d, 'postProcessing', 'speciesZ1'), exist_ok=True)
    with open(os.path.join(d, 'postProcessing', 'speciesZ1', 'speciesZ1.dat'), 'w') as f:
        f.write('# t MeOH H2O CH4 C2H4 C3H6 C3H8 C4H8 C5H10\n')
        for i in range(n):
            t = t0 + (t1 - t0) * i / (n - 1)
            f.write(' '.join(f'{v:.9g}' for v in [t] + [x * feed for x in y]) + '\n')


class Verify(unittest.TestCase):
    def test_kpis_and_scaled_meoh(self):
        import verify as V
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True)
        y = [1e-5, 0.003, 4e-5, 0.0012, 0.001, 8e-5, 3e-4, 1.2e-4]
        species_file(d, 119.0, 121.8, 400, y, feed=1.1)
        m = V.measure(d, 119.8, 121.8, 1.1)
        hc = sum(y[2:8])
        self.assertAlmostEqual(m['S_C2C3_pct'], 100 * (y[3] + y[4]) / hc, places=6)
        self.assertAlmostEqual(m['neg_S'], -m['S_C2C3_pct'])
        self.assertAlmostEqual(m['eta_MeOH_pct'], 100 * (1 - y[0] * 1.1 / (0.005 * 1.1)), places=6)
        self.assertAlmostEqual(m['fit_consistent'], 0.0, places=9)
        self.assertGreater(m['sampleCount'], 200); self.assertGreater(m['windowCoverage'], 0.99)


class Plugin(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(); cls.S = load_study('mto_condition', work_root=cls.tmp)

    @classmethod
    def tearDownClass(cls): shutil.rmtree(cls.tmp, True)

    def cand(self, d):
        p = os.path.join(self.tmp, f"c_{d.get('feed_scale')}_{d.get('T_K')}.json"); json.dump(d, open(p, 'w')); return p

    def test_check(self):
        S = self.S
        r = S.check(S.control_path)
        self.assertTrue(r['ok']); self.assertEqual(r['cell'], 'f1-T1'); self.assertIn('cstr_S_gas', r['features'])
        self.assertFalse(S.check(self.cand(dict(feed_scale=2.0, T_K=738)))['ok'])
        self.assertFalse(S.check(self.cand(dict(feed_scale=1.0, T_K=738, extra=1)))['ok'])
        self.assertEqual(S.check(self.cand(dict(feed_scale=1.00001, T_K=738.001)))['hash'], r['hash'])   # 四舍五入后同一工况

    def test_builtin_proposer_one_per_cell_skips_tried(self):
        S = self.S; arch = dict(trials={}, queue=[], cells={}, surrogate=S.default_surrogate())
        ps = S.propose_builtin(arch, 9, os.path.join(self.tmp, 'cands'))
        cells = [S.check(p)['cell'] for p in ps]
        self.assertEqual(len(ps), 9); self.assertEqual(len(set(cells)), 9)
        h = S.check(ps[0])['hash']; arch['trials'][h] = {}
        self.assertNotIn(h, [S.check(p)['hash'] for p in S.propose_builtin(arch, 9, os.path.join(self.tmp, 'cands2'))])

    def test_pipeline_reuses_distributor_mesh_and_valid_acceptance(self):
        for f in self.S.fidelities():
            p = self.S.pipeline(f)
            self.assertTrue(p['stages']['mesh']['command'][1].endswith(os.path.join('distributor', 'stage_mesh.sh')))
            ac = p['acceptance']; ms = ac['measurement']
            self.assertLess(ms['windowStart'], ms['windowEnd']); self.assertLessEqual(ms['windowEnd'], ac['endTime'])
            self.assertEqual({m['role'] for m in ac['metrics']}, {'fit', 'holdout'})


class EndToEnd(unittest.TestCase):
    """调度器 + 工况插件 + 分级：假 CFD 用 CSTR 选择性加偏差当"真值"，检查对照门、并行、淘汰、冠军。"""
    def test_campaign_with_fake_cfd(self):
        from core import loop
        tmp = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, tmp, True)
        S = load_study('mto_condition', work_root=tmp)
        alive, started, peak = set(), [], [0]
        ref = S.check(S.control_path)

        def launch(cpath, out):
            with open(cpath) as fh: cfg = json.load(fh)
            started.append(cfg); alive.add(len(started)); peak[0] = max(peak[0], len(alive)); return len(started)

        def finish_all():
            for i, cfg in enumerate(started, 1):
                if i not in alive: continue
                p = cfg['params']; c = K.solve(p['T_K'], p['feed_scale'])
                S_ = c['S_gas'] - 0.6 if not p['control'] else 80.69
                m = dict(neg_S=-S_, S_C2C3_pct=S_, eta_MeOH_pct=99.9, C2H4_C3H6=1.21, fit_consistent=0.05,
                         sampleCount=300, windowCoverage=1.0, kpi_dev_ref_max_pct=0.2 if p['control'] else 3.0)
                os.makedirs(cfg['trialDir'], exist_ok=True)
                json.dump(m, open(os.path.join(cfg['trialDir'], 'metrics.json'), 'w'))
                json.dump(dict(passed=True, value=m['neg_S']), open(os.path.join(cfg['trialDir'], 'trial-result.json'), 'w'))
                alive.discard(i)

        sch = Scheduler(S, busy_cores=lambda: 0, cpus=96, launcher=launch, verifier=lambda *a: (True, ''),
                        alive=lambda pid: pid in alive, log=lambda *a: None)
        self.assertTrue(sch.enqueue(ref, control=True)[0])
        st = loop.run(S, sch, rounds=2, per_round=4, sleep=lambda s: finish_all(), log=lambda *a: None, max_ticks=60)
        self.assertEqual(st, 'done')
        a = sch.load()
        self.assertEqual(a['control']['state'], 'control_ok')
        # 对照 short+full，加两轮各 ≤ (3 槽 − 在跑) 个候选的 short，晋级的再跑 full
        self.assertGreaterEqual(len(started), 5)
        self.assertTrue(any(c['trialId'].endswith('-short') and not c['params']['control'] for c in started))
        self.assertGreaterEqual(peak[0], 2)                               # 并行：同时在跑的试验 ≥ 2
        full = [t for t in a['trials'].values() if t['state'] in ('accepted', 'rejected')]
        self.assertTrue(full); self.assertNotEqual(a['champion'], ref['hash'])
        champ = a['trials'][a['champion']]
        self.assertGreater(champ['metrics_visible']['S_C2C3_pct'], 80.69)
        self.assertTrue(all(c['params']['np'] == 24 for c in started))


if __name__ == '__main__':
    unittest.main()
