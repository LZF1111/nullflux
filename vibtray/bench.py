import sys, time
import numpy as np
import taichi as ti
ti.init(arch=ti.cuda, default_fp=ti.f32, device_memory_GB=5, offline_cache=True)
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
import dem as D
import patch as PT

mat = dict(D.MAT)
for nc, L in ((8, 5e-3), (32, 5e-3)):
	cases = [dict(f=50.0, Az=PT.gamma_to_amp(2.5, 50.0)) for _ in range(nc)]
	cs2, pos, rad, cid = PT.build_patch_batch(cases, mat, L)
	sim = D.DEM(cs2, pos, rad, cid, mat, 1.5e-6, nbuild=10)
	sim.step(2000)
	ti.sync()
	t0 = time.time()
	sim.step(4000)
	ti.sync()
	dtw = time.time() - t0
	print(nc, len(rad), 'us/step', dtw / 4000 * 1e6, 'Mpart-step/s', len(rad) * 4000 / dtw / 1e6, sim.flags.to_numpy(), sim.stats()['ovl'].max())
