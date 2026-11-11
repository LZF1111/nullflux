#!/usr/bin/env python3
"""Offline check of the ROM controller on held-out recorded runs? No: the ROM controller needs a plant
that reacts to its choices, so this replays it on the surrogate plant of phase_map.py with a twist:
the surrogate uses recorded *switching* runs instead of looping static windows.

  rom_offline.py <rom.npz> <modes.npz> [--box C] [--ws 0.02] [--seeds 3]

Plant: phase_map surrogate (static windows + tau blend). Controllers:
  lag   = phase_map 'fb2' (mean fields + lag, 2-segment plans)
  rom   = ROM rollouts from the true projected state (oracle), 2-segment plans
Reports the box fraction over the last 5 s of 40 s.
"""
import argparse, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase_map as PM


def rom_load(p):
	z = np.load(p)
	return z['xbar'].astype(np.float64), z['Phi'].astype(np.float64), {m: z[f'A_{m}'] for m in 'LCR'}, {m: z[f'c_{m}'] for m in 'LCR'}


def run(args):
	rom_p, ctrl, ws, bname, seed, T_end, N = args
	xbar, Phi, A, c = rom_load(rom_p)
	nxy = PM.NX * PM.NY
	b = PM.BOXES[bname]
	rng = np.random.default_rng(seed)
	x = rng.uniform(PM.LO, PM.HI, N); y = rng.uniform(0, PM.YTOP, N)
	mode = 'C'; phase = rng.uniform(0, 15.0); prev, ts = None, 1e9
	Fh = (PM.F['C']['mu'], PM.F['C']['mv'])
	fr = []
	for k in range(int(round(T_end / PM.DT))):
		if k % 10 == 0:
			sub = slice(0, None, max(1, N // 300))
			best = None
			if ctrl == 'rom':
				u, v = PM.cur_field(mode, phase, prev, ts)
				a0 = (np.concatenate([u.ravel(), v.ravel()]) - xbar) @ Phi
			for m1 in 'LCR':
				for m2 in 'LCR':
					xs, ys = x[sub], y[sub]; acc = 0.0
					if ctrl == 'rom':
						a = a0.copy()
						for q in range(30):
							a = A[m1 if q < 10 else m2] @ a + c[m1 if q < 10 else m2]
							X = xbar + Phi @ a
							xs, ys = PM.move(xs, ys, X[:nxy].reshape(PM.NX, PM.NY), X[nxy:].reshape(PM.NX, PM.NY), ws, 0.1)
							if q >= 15:
								acc += PM.frac(b, xs, ys) / 15
					else:
						G = Fh
						for q in range(60):
							G = PM.lag(G, m1 if q < 20 else m2, PM.DT)
							xs, ys = PM.move(xs, ys, G[0], G[1], ws, PM.DT)
							if q >= 40:
								acc += PM.frac(b, xs, ys) / 20
					f = acc + 0.002 * (m1 == mode)
					if best is None or f > best[0]:
						best = (f, m1)
			new = best[1]
			if new != mode:
				prev = PM.cur_field(mode, phase, prev, ts)
				mode, ts, phase = new, 0.0, rng.uniform(0, 15.0)
			fr.append(PM.frac(b, x, y))
		u, v = PM.cur_field(mode, phase, prev, ts)
		x, y = PM.move(x, y, u, v, ws, PM.DT, rng)
		Fh = PM.lag(Fh, mode, PM.DT)
		phase += PM.DT; ts += PM.DT
	return float(np.mean(fr[-10:]))


def main():
	from concurrent.futures import ProcessPoolExecutor
	ap = argparse.ArgumentParser()
	ap.add_argument('rom'); ap.add_argument('npz')
	ap.add_argument('--seeds', type=int, default=3); ap.add_argument('--jobs', type=int, default=28)
	a = ap.parse_args()
	cells = [(ws, bn) for bn in ('C', 'BL', 'BC', 'WL') for ws in (0.0, 0.01, 0.02, 0.04)]
	tasks = [(a.rom, ct, ws, bn, s, 40.0, 2000) for ws, bn in cells for ct in ('rom', 'lag') for s in range(a.seeds)]
	with ProcessPoolExecutor(a.jobs, initializer=PM.init, initargs=(a.npz,)) as ex:
		res = list(ex.map(run, tasks))
	R = dict()
	for t, f in zip(tasks, res):
		R.setdefault((t[2], t[3], t[1]), []).append(f)
	print('box  ws    area   lag-fb        rom-fb')
	for ws, bn in cells:
		bx = PM.BOXES[bn]; area = (bx[1] - bx[0]) * (bx[3] - bx[2]) / ((PM.HI - PM.LO) * PM.YTOP)
		l, r = R[(ws, bn, 'lag')], R[(ws, bn, 'rom')]
		print(f'{bn:3s} {ws * 100:4.1f}  {area:.3f}  {np.mean(l):.3f}+-{np.std(l):.3f}  {np.mean(r):.3f}+-{np.std(r):.3f}')


if __name__ == '__main__':
	main()
