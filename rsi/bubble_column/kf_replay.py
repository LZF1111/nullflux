#!/usr/bin/env python3
"""Offline replay of the particle-driven Kalman filter on held-out runs (no CFD).

  kf_replay.py <rom.npz> <run_dir>... [--sigma 0.04] [--n 300] [--ws 0.02]

Re-advects a fresh swarm through the recorded fields (useries.npz) of a run under its recorded mode
sequence, feeds the KF the displacement of n particles every 0.5 s, and reports the field RMS error
of the estimate vs the true field: KF, open-loop ROM from the mean (no measurements), the static
lag model, and the POD projection floor.
"""
import argparse, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import traj as T
import swarm_feas as SF
import rom as RM
import swarm_rom as SR

NXY = T.NX * T.NY


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument('rom'); ap.add_argument('dirs', nargs='+')
	ap.add_argument('--sigma', type=float, default=0.04); ap.add_argument('--n', type=int, default=300)
	ap.add_argument('--ws', type=float, default=0.02)
	a = ap.parse_args()
	rom = RM.ROM(a.rom); z = np.load(a.rom); r = rom.Phi.shape[1]
	M = RM.static_means()
	E = dict(kf=[], rom_open=[], lag=[], proj=[], zero=[])
	for d in a.dirs:
		S = RM.load([d])[0]
		X, md = S['X'], S['mode']
		rng = np.random.default_rng(7)
		x = rng.uniform(SF.LO, SF.HI, a.n); y = rng.uniform(0, SF.YTOP, a.n)
		kf = SR.KF(rom, np.zeros(r), np.eye(r) * 25.0, np.eye(r) * float(z['q_var']), a.sigma)
		ao = np.zeros(r); lag = M['C'].astype(np.float64)
		for k in range(len(X) - 1):
			u0 = X[k][:NXY].reshape(T.NX, T.NY); v0 = X[k][NXY:].reshape(T.NX, T.NY)
			u1 = X[k + 1][:NXY].reshape(T.NX, T.NY); v1 = X[k + 1][NXY:].reshape(T.NX, T.NY)
			if k % 5 == 0:
				xa, ya = x.copy(), y.copy()
			for sub in (0.25, 0.75):
				x, y = SF.move(x, y, (1 - sub) * u0 + sub * u1, (1 - sub) * v0 + sub * v1, a.ws, 0.05, rng)
			kf.predict(md[k]); ao = rom.step(ao, md[k])
			lag = lag + (1 - np.exp(-0.1 / RM.TAU)) * (M[md[k]] - lag)
			if k % 5 == 4:
				kf.update(xa, ya, x, y, 0.5, a.ws)
				xt = X[k + 1].astype(np.float64)
				def rms(v):
					return float(np.sqrt(np.mean((v - xt) ** 2)))
				if k > 20:
					E['kf'].append(rms(rom.xbar + rom.Phi @ kf.a.astype(np.float32)))
					E['rom_open'].append(rms(rom.xbar + rom.Phi @ ao.astype(np.float32)))
					E['lag'].append(rms(lag))
					E['proj'].append(rms(rom.xbar + rom.Phi @ ((xt - rom.xbar) @ rom.Phi)))
					E['zero'].append(rms(rom.xbar))
	print(f'field RMS of the estimate [m/s], n={a.n} particles, sigma={a.sigma}:')
	for key, v in E.items():
		print(f'  {key:9s} {np.mean(v):.4f}  (n={len(v)})')


if __name__ == '__main__':
	main()
