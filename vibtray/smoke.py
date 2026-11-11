import json, math, sys, time
import numpy as np
import taichi as ti
ti.init(arch=ti.cuda, default_fp=ti.f32, offline_cache=True)
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
import dem as D
import patch as PT

mat = dict(D.MAT)
print('particle mass', D.pmass(50e-6), 'N full tray', D.MASS / D.mean_mass(1e4, 50e-6, 0.1))
print('areal kg/m2', D.AREAL, 'bed height (phi=0.6) mm', D.AREAL / (1e4 * 0.6) * 1e3)
print('contact time us', D.contact_time(mat) * 1e6)
f = 50.0
cases = [dict(f=f, Az=PT.gamma_to_amp(G, f)) for G in (0.0, 1.5, 2.5, 3.5)]
t0 = time.time()
out, meta = PT.run(cases, mat, dt=1e-6, t_settle=0.03, t_warm=0.05, t_meas=0.1)
print('wall', time.time() - t0, meta['N'], meta['flags'])
for o in out:
	print({k: (round(v, 6) if isinstance(v, float) else v) for k, v in o.items() if k not in ('cvT', 'case')})
