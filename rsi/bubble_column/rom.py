#!/usr/bin/env python3
"""P3: mode-conditioned linear reduced-order model of the liquid velocity (POD + DMD with control).

  rom.py export <run_dir>...          -> <run_dir>/useries.npz
  rom.py fit <rom.npz> <run_dir>... [--r 30] [--ridge 1e-3] [--multi 10]
  rom.py test <rom.npz> <run_dir>...          prediction skill on held-out runs

useries.npz: t (relative to the restart), u, v (n, 60, 120) at every 0.1 s write, and mode[k], the
gas mode applied on [t_k, t_k+1).
ROM: x = [u, v] flattened, a = Phi^T (x - xbar) (POD by the method of snapshots), and per gas mode m
an affine map a_{k+1} = A_m a_k + c_m (ridge least squares; with --multi K the fit also matches the
K-step rollout, which matters because the controller looks 1-3 s ahead). Eigenvalues are clipped
to |lambda| <= 0.995 so rollouts stay bounded.
"""
import argparse, json, os, re, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import traj as T

DTS = 0.1
MODES = 'LCR'
NXY = T.NX * T.NY
RUNS = os.path.expanduser('~/bubble_col/runs')
STATIC = dict(L='L6_600', C='L6_060', R='L6_006')
TAU = 2.0


def run_meta(d):
	for f in ('swarm.json', 'autopilot.json'):
		p = os.path.join(d, f)
		if os.path.exists(p):
			j = json.load(open(p))
			return float(j.get('t0', 20.0)), [c['mode'] for c in j['chunks']], float(j.get('chunk_s', 0.5)), j
	raise SystemExit('no swarm.json / autopilot.json in ' + d)


def snapshot(d, x, gi):
	ix, iy, cnt = gi
	u = T.read_internal(os.path.join(d, x, 'U.water'), True)
	gu = np.zeros((T.NX, T.NY)); gv = np.zeros((T.NX, T.NY))
	np.add.at(gu, (ix, iy), u[:, 0]); np.add.at(gv, (ix, iy), u[:, 1])
	return gu / cnt, gv / cnt


def export(d):
	t0, modes, ch, _ = run_meta(d)
	gi = T.grid_index(d)
	ds = sorted((x for x in os.listdir(d) if re.fullmatch(r'[0-9.]+', x) and float(x) >= t0 - 1e-6), key=float)
	t = np.array([float(x) - t0 for x in ds])
	n = int(np.searchsorted(t, len(modes) * ch + 1e-6))
	ds, t = ds[:n], t[:n]
	U = np.zeros((n, T.NX, T.NY), np.float32); V = np.zeros_like(U)
	for k, x in enumerate(ds):
		U[k], V[k] = snapshot(d, x, gi)
	md = np.array([modes[min(int((tk + 1e-6) / ch), len(modes) - 1)] for tk in t])
	np.savez_compressed(os.path.join(d, 'useries.npz'), t=t, u=U, v=V, mode=md)
	return f'{d}: {n} snapshots, t {t[0]:.1f}-{t[-1]:.1f}'


def load(dirs):
	S = []
	for d in dirs:
		z = np.load(os.path.join(d, 'useries.npz'))
		X = np.concatenate([z['u'].reshape(len(z['u']), -1), z['v'].reshape(len(z['v']), -1)], 1)
		S.append(dict(name=os.path.basename(d.rstrip('/')), dir=d, X=X, mode=[str(m) for m in z['mode']], t=z['t']))
	return S


def static_means():
	M = dict()
	for m, rid in STATIC.items():
		mf = json.load(open(os.path.join(RUNS, rid, 'traj.json')))['mean_field']
		M[m] = np.concatenate([np.array(mf['u']).ravel(), np.array(mf['v']).ravel()]).astype(np.float32)
	return M


def pod(S, r, nsub=6000):
	Xall = np.concatenate([s['X'] for s in S])
	xbar = Xall.mean(0)
	step = max(1, len(Xall) // nsub)
	Xs = (Xall[::step] - xbar).astype(np.float64)
	C = Xs @ Xs.T
	lam, W = np.linalg.eigh(C)
	order = np.argsort(lam)[::-1]
	lam, W = lam[order], W[:, order]
	Phi = (Xs.T @ W[:, :r]) / np.sqrt(lam[:r])
	return xbar.astype(np.float32), Phi.astype(np.float32), lam / lam.sum()


def clip_eig(A, rho=0.995):
	w, Q = np.linalg.eig(A)
	big = np.abs(w) > rho
	if not big.any():
		return A
	w = np.where(big, w / np.abs(w) * rho, w)
	return np.real(Q @ np.diag(w) @ np.linalg.inv(Q))


def fit_dyn(S, xbar, Phi, ridge, multi):
	r = Phi.shape[1]
	for s in S:
		s['a'] = (s['X'] - xbar) @ Phi
	A, c = dict(), dict()
	for m in MODES:
		P, Q = [], []
		for s in S:
			a, md = s['a'], s['mode']
			for k in range(len(a) - 1):
				if md[k] == m:
					P.append(a[k]); Q.append(a[k + 1])
		P, Q = np.array(P, np.float64), np.array(Q, np.float64)
		Z = np.c_[P, np.ones(len(P))]
		G = Z.T @ Z
		reg = ridge * np.trace(G[:r, :r]) / r
		G[:r, :r] += reg * np.eye(r)
		Wt = np.linalg.solve(G, Z.T @ Q)
		A[m], c[m] = clip_eig(Wt[:r].T), Wt[r]
		print(f'  mode {m}: {len(P)} transitions, spectral radius {np.abs(np.linalg.eigvals(A[m])).max():.4f}', flush=True)
	if multi > 1:
		A, c = refine_multi(S, A, c, multi, ridge)
	res = []
	for s in S:
		a, md = s['a'], s['mode']
		for k in range(len(a) - 1):
			res.append(a[k + 1] - (A[md[k]] @ a[k] + c[md[k]]))
	q_var = float(np.mean(np.square(res)))
	print(f'  one-step residual variance per coefficient {q_var:.4f}; coefficient variance {np.mean([np.var(s["a"], 0).mean() for s in S]):.3f}', flush=True)
	return A, c, q_var


def refine_multi(S, A, c, K, ridge, iters=3):
	"""Gauss-Newton style refinement: refit (A_m, c_m) on pairs (rollout state, true next state)
	collected along K-step open rollouts, so that errors made along a rollout are corrected."""
	r = len(next(iter(c.values())))
	for it in range(iters):
		P = {m: [] for m in MODES}; Q = {m: [] for m in MODES}
		err = []
		for s in S:
			a, md = s['a'], s['mode']
			for k0 in range(0, len(a) - K, 3):
				z = a[k0].astype(np.float64)
				for j in range(K):
					m = md[k0 + j]
					P[m].append(z); Q[m].append(a[k0 + j + 1])
					z = A[m] @ z + c[m]
				err.append(np.linalg.norm(z - a[k0 + K]))
		print(f'  multi-step iter {it}: mean |a_K error| {np.mean(err):.3f}', flush=True)
		for m in MODES:
			Pm, Qm = np.array(P[m]), np.array(Q[m])
			Z = np.c_[Pm, np.ones(len(Pm))]
			G = Z.T @ Z
			G[:r, :r] += ridge * np.trace(G[:r, :r]) / r * np.eye(r)
			Wt = np.linalg.solve(G, Z.T @ Qm)
			A[m], c[m] = clip_eig(Wt[:r].T), Wt[r]
	return A, c


class ROM:
	def __init__(self, path):
		z = np.load(path)
		self.xbar, self.Phi = z['xbar'], z['Phi']
		self.A = {m: z[f'A_{m}'] for m in MODES}
		self.c = {m: z[f'c_{m}'] for m in MODES}

	def project(self, u, v):
		return (np.concatenate([u.ravel(), v.ravel()]) - self.xbar) @ self.Phi

	def field(self, a):
		x = self.xbar + self.Phi @ a.astype(np.float32)
		return x[:NXY].reshape(T.NX, T.NY), x[NXY:].reshape(T.NX, T.NY)

	def step(self, a, m):
		return self.A[m] @ a + self.c[m]


def cmd_export(a):
	from concurrent.futures import ProcessPoolExecutor
	with ProcessPoolExecutor(min(24, len(a.dirs))) as ex:
		for msg in ex.map(export, a.dirs):
			print(msg, flush=True)


def cmd_fit(a):
	S = load(a.dirs)
	print(f'{len(S)} runs, {sum(len(s["X"]) for s in S)} snapshots', flush=True)
	xbar, Phi, en = pod(S, a.r)
	print('POD energy: first 5', np.round(en[:5], 3).tolist(), f' sum r={a.r}: {en[:a.r].sum():.3f}',
		{k: round(float(en[:k].sum()), 3) for k in (10, 20, 40, 80)}, flush=True)
	A, c, q_var = fit_dyn(S, xbar, Phi, a.ridge, a.multi)
	np.savez(a.rom, xbar=xbar, Phi=Phi, energy=en[:200], q_var=q_var, **{f'A_{m}': A[m] for m in MODES}, **{f'c_{m}': c[m] for m in MODES},
		train=np.array([s['name'] for s in S]))
	print('->', a.rom)


def lag_roll(F, M, modes):
	out = []
	for m in modes:
		F = F + (1 - np.exp(-DTS / TAU)) * (M[m] - F)
		out.append(F)
	return out


def cmd_test(a):
	rom = ROM(a.rom)
	M = static_means()
	S = load(a.dirs)
	H = [5, 10, 15, 20, 30]
	E = {k: {h: [] for h in H} for k in ('rom', 'proj', 'lag_true', 'lag_est', 'persist')}
	P = {k: dict(C=[], BL=[], pos=[]) for k in ('rom', 'lag_true', 'lag_est', 'persist')}
	sys.path.insert(0, HERE)
	import swarm_feas as SF
	for s in S:
		X, md = s['X'], s['mode']
		est = [M['C']]
		for k in range(len(X) - 1):
			est.append(est[-1] + (1 - np.exp(-DTS / TAU)) * (M[md[k]] - est[-1]))
		_, _, _, j = run_meta(s['dir'])
		snaps = {round(q['t'], 2): q for q in j.get('snaps', [])}
		for k0 in range(0, len(X) - 31, 20):
			z = rom.project(X[k0][:NXY], X[k0][NXY:])
			pr = dict(rom=[], lag_true=lag_roll(X[k0].astype(np.float64), M, md[k0:k0 + 30]),
				lag_est=lag_roll(est[k0].astype(np.float64), M, md[k0:k0 + 30]), persist=[X[k0]] * 30)
			for jj in range(30):
				z = rom.step(z, md[k0 + jj])
				pr['rom'].append(rom.xbar + rom.Phi @ z.astype(np.float32))
			for h in H:
				xt = X[k0 + h]
				for key in ('rom', 'lag_true', 'lag_est', 'persist'):
					E[key][h].append(float(np.sqrt(np.mean((pr[key][h - 1] - xt) ** 2))))
				ap = (xt - rom.xbar) @ rom.Phi
				E['proj'][h].append(float(np.sqrt(np.mean((rom.xbar + rom.Phi @ ap - xt) ** 2))))
			q = snaps.get(round(float(s['t'][k0]), 2))
			if q is None:
				continue
			x0, y0 = np.array(q['x']), np.array(q['y'])
			def advect(seq):
				x, y = x0.copy(), y0.copy()
				for jj in range(15):
					F0 = X[k0] if jj == 0 else seq[jj - 1]
					F1 = seq[jj]
					for sub in (0.25, 0.75):
						F = (1 - sub) * F0 + sub * F1
						x, y = SF.move(x, y, F[:NXY].reshape(T.NX, T.NY), F[NXY:].reshape(T.NX, T.NY), a.ws, 0.05)
				return x, y
			xt_, yt_ = advect([X[k0 + jj + 1] for jj in range(15)])
			for key in P:
				xp, yp = advect(pr[key])
				P[key]['C'].append(abs(SF.frac(SF.BOXES['centre'], xp, yp) - SF.frac(SF.BOXES['centre'], xt_, yt_)))
				P[key]['BL'].append(abs(SF.frac(SF.BOXES['corner'], xp, yp) - SF.frac(SF.BOXES['corner'], xt_, yt_)))
				P[key]['pos'].append(float(np.mean(np.hypot(xp - xt_, yp - yt_))))
	print('field RMS error [m/s] at horizon:', ' '.join(f'{h * DTS:g}s' for h in H))
	for key in E:
		print(f'  {key:9s}', ' '.join(f'{np.mean(E[key][h]):.4f}' for h in H), f'(n={len(E[key][H[0]])})')
	print('particle prediction after 1.5 s (ws = %g): mean position error [cm], |frac error| centre / corner [%%]' % a.ws)
	for key in P:
		if P[key]['pos']:
			print(f'  {key:9s} pos {np.mean(P[key]["pos"]) * 100:5.2f}  centre {np.mean(P[key]["C"]) * 100:5.2f}  corner {np.mean(P[key]["BL"]) * 100:5.2f}  (n={len(P[key]["pos"])})')


def main():
	ap = argparse.ArgumentParser()
	sp = ap.add_subparsers(dest='cmd', required=True)
	p = sp.add_parser('export'); p.add_argument('dirs', nargs='+')
	p = sp.add_parser('fit'); p.add_argument('rom'); p.add_argument('dirs', nargs='+')
	p.add_argument('--r', type=int, default=30); p.add_argument('--ridge', type=float, default=1e-3)
	p.add_argument('--multi', type=int, default=1)
	p = sp.add_parser('test'); p.add_argument('rom'); p.add_argument('dirs', nargs='+')
	p.add_argument('--ws', type=float, default=0.02)
	a = ap.parse_args()
	globals()['cmd_' + a.cmd](a)


if __name__ == '__main__':
	main()
