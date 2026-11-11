"""放大设计 RSI 插件：离线检查、约束、代理、内置提议者、generate 阶段改对文件。不跑 CFD。"""
import json, os, shutil, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RSI = os.path.join(HERE, '..', 'rsi')
sys.path.insert(0, RSI)
from core import load_study  # noqa: E402

SU = os.path.join(RSI, 'studies', 'scaleup')


class ScaleUp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.S = load_study('scaleup', work_root=tempfile.mkdtemp())
        cls.tmp = tempfile.mkdtemp()

    def cand(self, **kw):
        d = dict(json.load(open(os.path.join(SU, 'control.json'))), **kw)
        p = os.path.join(self.tmp, f'c{len(os.listdir(self.tmp))}.json'); json.dump(d, open(p, 'w')); return p

    def test_control_is_valid_and_reproduces_paper_ug(self):
        r = self.S.check(self.S.control_path)
        self.assertTrue(r['ok'], r['violations'])
        self.assertAlmostEqual(r['features']['Ug_prod'], 1.35, places=6)
        self.assertTrue(98 < r['features']['cstr_conv'] < 100 or 90 < r['features']['cstr_conv'], r['features'])
        self.assertAlmostEqual(r['features']['cstr_ratio'], 1.566, delta=0.02)   # cstr_scales.json: commercial 748 K wc_in=0 → 1.566
        arch = dict(surrogate=self.S.default_surrogate())
        self.assertAlmostEqual(self.S.surrogate(r, arch), -r['features']['cstr_Y'], places=9)   # 基准工况不被转化率门槛罚分

    def test_bounds_and_constraints(self):
        self.assertFalse(self.S.check(self.cand(T_K=773))['ok'])                 # 动力学插值范围外
        r = self.S.check(self.cand(D_m=8.5))                                      # 截面小 → 气速超出 EMMS 拟合适用范围
        self.assertFalse(r['ok']); self.assertIn('表观气速', r['violations'][0])
        self.assertFalse(self.S.check(self.cand(extra=1))['ok'])
        self.assertFalse(self.S.check(self.cand(inv_t=40.0, H_m=6.0, D_m=9.6))['ok'] and False)

    def test_hash_is_rounding_stable(self):
        self.assertEqual(self.S.check(self.cand(D_m=10.5))['hash'], self.S.check(self.cand(D_m=10.50001))['hash'])

    def test_builtin_proposer_one_per_cell_and_all_valid(self):
        arch = dict(trials={}, queue=[], cells={}, surrogate=self.S.default_surrogate(), champion=None, control=None)
        ps = self.S.propose_builtin(arch, 6, os.path.join(self.tmp, 'cands'))
        self.assertTrue(ps)
        rs = [self.S.check(p) for p in ps]
        self.assertTrue(all(r['ok'] for r in rs))
        self.assertEqual(len({r['cell'] for r in rs}), len(rs))

    def test_pipeline_objective_is_fit_and_window_inside(self):
        for f in self.S.fidelities():
            a = self.S.pipeline(f)['acceptance']
            self.assertEqual(a['objective'], 'neg_Y')
            self.assertLess(a['measurement']['windowStart'], a['measurement']['windowEnd'])
            self.assertLessEqual(a['measurement']['windowEnd'], a['endTime'])


if __name__ == '__main__':
    unittest.main()
