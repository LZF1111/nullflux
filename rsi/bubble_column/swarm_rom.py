#!/usr/bin/env python3
"""P3: swarm herding with the POD/DMD ROM as the controller's predictor, live CFD plant.

  swarm_rom.py <out_case> <base_run> --rom rom.npz --est kf|oracle [--box centre] [--ws 0.02]
        [--plan 1|2] [--T 60] [--seed 3] [--t0 30]

Plant and particles as in swarm_live.py.
Flow-state estimate (ROM coordinates a, dim r):
  oracle  a = Phi^T (x_true - xbar) from the CFD field at each decision (upper bound)
  kf      Kalman filter driven only by particle positions: predict a with the mode's affine map
	   every 0.1 s; update with the measured displacement of up to 300 particles over the last
	   0.5 s, linearised as d(x_i)/0.5 s ~ u(x_i) - ws e_y = H_i a + h_i (H from Phi at the
	   particle midpoints). Noise: process Q from the ROM one-step residuals, measurement
	   R = sigma^2 (sigma = 4 cm/s: turbulent dispersion + unresolved field).
Planner: for each mode sequence (plan 1: one mode for 1.5 s; plan 2: m1 for 1 s then m2 for 2 s)
  roll the ROM forward from a_hat, advect a 300-particle subsample, score the box fraction averaged
  over the second half of the horizon.
"""
import argparse, json, os, shutil, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import traj as T
import case_runner as CR
import closed_loop as CL
import swarm_feas as SF
import rom as RM

UG3 = 3 * CR.UG
MODE_Z = dict(L=[UG3, 0.0, 0.0], C=[0.0, UG3, 0.0], R=[0.0, 0.0, UG3])
DT, DTS, NXY = SF.DT, 0.1, T.NX * T.NY


def field_of(rom, a):
	x = rom.xbar + rom.Phi @ a.astype(np.float32)
	return x[:NXY].reshape(T.NX, T.NY), x[NXY:].reshape(T.NX, T.NY)


def plan_score(rom, a0, seq, xs, ys, ws, box):
	"""seq: list of (mode, n_steps of 0.1 s). Score = mean box fraction over the second half."""
	a = a0.copy(); n_tot = sum(n for _, n in seq); k = 0; acc = 0.0; cnt = 0
	u0, v0 = field_of(rom, a)
	for m, n in seq:
		for _ in range(n):
			a = rom.step(a, m)
			u1, v1 = field_of(rom, a)
			xs, ys = SF.move(xs, ys, 0.5 * (u0 + u1), 0.5 * (v0 + v1), ws, DTS)
			u0, v0 = u1, v1
			k += 1
			if k > n_tot // 2:
				acc += SF.frac(box, xs, ys); cnt += 1
	return acc / max(cnt, 1)


class KF:
	def __init__(self, rom, a0, P0, Q, sigma):
		self.rom, self.a, self.P, self.Q, self.R = rom, a0.astype(np.float64), P0, Q, sigma ** 2
		r = rom.Phi.shape[1]
		self.Pu = rom.Phi[:NXY].reshape(T.NX, T.NY, r).astype(np.float64)
		self.Pv = rom.Phi[NXY:].reshape(T.NX, T.NY, r).astype(np.float64)
		self.bu = rom.xbar[:NXY].reshape(T.NX, T.NY).astype(np.float64)
		self.bv = rom.xbar[NXY:].reshape(T.NX, T.NY).astype(np.float64)

	def predict(self, m):
		A = self.rom.A[m]
		self.a = A @ self.a + self.rom.c[m]
		self.P = A @ self.P @ A.T + self.Q

	def rows(self, x, y):
		"""bilinear interpolation weights -> H (2n x r), offset h (2n)."""
		fi = np.clip((x - T.X0) / T.DX - 0.5, 0, T.NX - 1.000001)
		fj = np.clip(y / T.DX - 0.5, 0, T.NY - 1.000001)
		i = fi.astype(int); j = fj.astype(int); p = fi - i; q = fj - j
		W = [((i, j), (1 - p) * (1 - q)), ((i + 1, j), p * (1 - q)), ((i, j + 1), (1 - p) * q), ((i + 1, j + 1), p * q)]
		Hu = sum(w[:, None] * self.Pu[ii, jj] for (ii, jj), w in W)
		Hv = sum(w[:, None] * self.Pv[ii, jj] for (ii, jj), w in W)
		hu = sum(w * self.bu[ii, jj] for (ii, jj), w in W)
		hv = sum(w * self.bv[ii, jj] for (ii, jj), w in W)
		return np.vstack([Hu, Hv]), np.concatenate([hu, hv])

	def update(self, xa, ya, xb, yb, dt, ws):
		ok = (xa > T.X0 + 0.01) & (xa < T.X1 - 0.01) & (ya > 0.01) & (ya < 0.43) & \
			(xb > T.X0 + 0.01) & (xb < T.X1 - 0.01) & (yb > 0.01) & (yb < 0.43)
		xa, ya, xb, yb = xa[ok], ya[ok], xb[ok], yb[ok]
		if len(xa) < 10:
			return 0
		H, h = self.rows(0.5 * (xa + xb), 0.5 * (ya + yb))
		z = np.concatenate([(xb - xa) / dt, (yb - ya) / dt + ws])
		# information form: r is small, n is large
		Pi = np.linalg.inv(self.P)
		Inf = Pi + H.T @ H / self.R
		self.P = np.linalg.inv(Inf)
		self.a = self.P @ (Pi @ self.a + H.T @ (z - h) / self.R)
		return len(xa)


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument('case'); ap.add_argument('base')
	ap.add_argument('--rom', required=True); ap.add_argument('--est', default='kf')
	ap.add_argument('--box', default='centre'); ap.add_argument('--ws', type=float, default=0.02)
	ap.add_argument('--plan', type=int, default=2); ap.add_argument('--T', type=float, default=60.0)
	ap.add_argument('--N', type=int, default=2000); ap.add_argument('--seed', type=int, default=3)
	ap.add_argument('--t0', type=float, default=30.0); ap.add_argument('--sigma', type=float, default=0.04)
	a = ap.parse_args()
	box = SF.BOXES[a.box]
	rom = RM.ROM(a.rom)
	r = rom.Phi.shape[1]
	z = np.load(a.rom)
	case = a.case
	if os.path.exists(case):
		shutil.rmtree(case)
	os.makedirs(case)
	for d in ('constant', 'system', '0'):
		shutil.copytree(os.path.join(a.base, d), os.path.join(case, d))
	shutil.copytree(os.path.join(a.base, f'{a.t0:g}'), os.path.join(case, f'{a.t0:g}'))
	base_params = json.load(open(os.path.join(a.base, 'params.json')))
	gi = T.grid_index(case)
	rng = np.random.default_rng(a.seed)
	x = rng.uniform(SF.LO, SF.HI, a.N); y = rng.uniform(0.0, SF.YTOP, a.N)

	u_init, v_init = CL.snapshot(case, f'{a.t0:g}', gi)
	a_true = rom.project(u_init, v_init)
	# KF starts from the POD mean (a = 0) with a wide prior; process noise from typical one-step residual
	Q = np.eye(r) * float(z['q_var']) if 'q_var' in z.files else np.eye(r) * 0.5
	kf = KF(rom, np.zeros(r), np.eye(r) * 25.0, Q, a.sigma)
	meas = slice(0, None, max(1, a.N // 300))

	plans = [[(m, 15)] for m in 'LCR'] if a.plan == 1 else [[(m1, 10), (m2, 20)] for m1 in 'LCR' for m2 in 'LCR']
	t, mode = a.t0, 'C'
	cur = [CR.UG] * 3
	bp = [(0.0, cur)]
	chunks, snaps = [], []
	out = dict(ctrl=f'rom_{a.est}_p{a.plan}', est=a.est, plan=a.plan, rom=os.path.basename(a.rom), t0=a.t0, ws=a.ws,
		box=box, box_name=a.box, N=a.N, seed=a.seed, base=os.path.basename(a.base.rstrip('/')),
		model=base_params.get('model'), area_frac=round((box[1] - box[0]) * (box[3] - box[2]) / ((SF.HI - SF.LO) * SF.YTOP), 4))
	while t < a.t0 + a.T - 1e-9:
		tr = t - a.t0
		w0 = time.time()
		a_hat = a_true if a.est == 'oracle' else kf.a
		est_err = float(np.sqrt(np.mean((rom.Phi @ (a_hat - a_true).astype(np.float32)) ** 2)))
		sub = slice(0, None, max(1, a.N // 300))
		best = None
		for seq in plans:
			f = plan_score(rom, a_hat, seq, x[sub], y[sub], a.ws, box) + 0.002 * (seq[0][0] == mode)
			if best is None or f > best[0]:
				best = (f, seq)
		mode = best[1][0][0]
		plan_s = time.time() - w0
		snaps.append(dict(t=round(tr, 2), mode=mode, x=np.round(x[::4], 4).tolist(), y=np.round(y[::4], 4).tolist()))
		new = MODE_Z[mode]
		if new != cur:
			bp += [(t, cur), (t + 0.05, new)]
			cur = new
		CR.write_tables(case, bp + [(1000.0, cur)])
		t1 = round(t + CL.CHUNK, 4)
		CR.set_ctrl(case, endTime=f'{t1:g}', writeInterval=f'{CL.WRITE:g}')
		CR.foam(case, 'twoPhaseEulerFoam', 'log.chunk')
		ds = [d for d in CL.time_dirs(case) if t - 1e-6 <= float(d) <= t1 + 1e-6]
		ts = np.array([float(d) for d in ds])
		G = [CL.snapshot(case, d, gi) for d in ds]
		xm0, ym0 = x[meas].copy(), y[meas].copy()
		tt = t
		while tt < t1 - 1e-9:
			j = int(np.clip(np.searchsorted(ts, tt + 0.5 * DT) - 1, 0, len(ts) - 2))
			w = float(np.clip((tt + 0.5 * DT - ts[j]) / (ts[j + 1] - ts[j]), 0, 1))
			u = (1 - w) * G[j][0] + w * G[j + 1][0]
			v = (1 - w) * G[j][1] + w * G[j + 1][1]
			x, y = SF.move(x, y, u, v, a.ws, DT, rng)
			tt += DT
		for _ in range(int(round(CL.CHUNK / DTS))):
			kf.predict(mode)
		n_used = kf.update(xm0, ym0, x[meas], y[meas], CL.CHUNK, a.ws) if a.est == 'kf' else 0
		a_true = rom.project(*G[-1])
		t = t1
		f = SF.frac(box, x, y)
		chunks.append(dict(t=round(t - a.t0, 2), mode=mode, frac=round(f, 4), pred=round(best[0], 4),
			est_rms=round(est_err, 4), n_meas=int(n_used), plan_s=round(plan_s, 2)))
		print(json.dumps(chunks[-1]), flush=True)
		out.update(chunks=chunks, snaps=snaps, final_frac=round(float(np.mean([c['frac'] for c in chunks[-10:]])), 4))
		json.dump(out, open(os.path.join(case, 'swarm.json'), 'w'))
	print('final fraction in box (last 5 s):', out['final_frac'], 'area', out['area_frac'], flush=True)


if __name__ == '__main__':
	main()
