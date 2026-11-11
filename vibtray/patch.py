"""Batched periodic-patch runs at true particle size, with per-case metrics."""
import json
import math
import sys
import time
import numpy as np
import taichi as ti

sys.path.insert(0, __file__.rsplit('\\', 1)[0])
import dem as D


def build_patch_batch(cases, mat, L=5e-3, seed=1, spread=0.1, areal=D.AREAL):
	rng = np.random.default_rng(seed)
	P, R, C = [], [], []
	cs2 = []
	for c, cs in enumerate(cases):
		Lc = cs.get('Lx', L)
		p, r = D.fill_patch(Lc, Lc, rng, mat['rho'], mat['r0'], spread, cs.get('areal', areal))
		P.append(p)
		R.append(r)
		C.append(np.full(len(r), c))
		d = dict(cs)
		d['kind'] = 0
		d['Lx'] = d['Ly'] = Lc
		cs2.append(d)
	return cs2, np.concatenate(P), np.concatenate(R), np.concatenate(C)


def gamma_to_amp(G, f):
	return G * D.GRAV / (2 * math.pi * f) ** 2


def run(cases, mat=None, dt=1e-6, t_settle=0.05, t_warm=0.3, t_meas=1.0, dt_expo=5e-4,
		L=5e-3, seed=1, log=None, snap_times=(), nbuild=10, spread=0.1):
	mat = dict(mat or D.MAT)
	for cs in cases:
		cs.setdefault('ton', t_settle)
	cs2, pos, rad, cid = build_patch_batch(cases, mat, L, seed, spread)
	sim = D.DEM(cs2, pos, rad, cid, mat, dt, nbuild=nbuild)
	C = len(cs2)
	nexpo = max(1, int(round(dt_expo / dt)))
	t0 = time.time()
	# settle, then warm-up under vibration
	nst = int(round((t_settle + t_warm) / dt))
	sim.step(int(round(t_settle / dt)))
	st = sim.stats()
	z_rest = st['z'].copy()
	zsd_rest = st['zsd'].copy()
	sim.step(nst - int(round(t_settle / dt)))
	sim.reset_dose()
	sim.flags.fill(0)
	nm = int(round(t_meas / dt))
	acc = {k: np.zeros(C) for k in ('z', 'zsd', 'ke', 'w', 'vx', 'vy', 'gt')}
	zmax = np.zeros(C)
	ovl = np.zeros(C)
	nsamp = 0
	# dose snapshots for CV(T) scaling
	nsnap = 8
	snap_at = set(int(round(nm * (k + 1) / nsnap)) for k in range(nsnap))
	dsnaps = []
	cidn = cid
	k = 0
	traj = []
	while k < nm:
		sim.step(nexpo)
		k += nexpo
		sim.expose(nexpo * dt)
		s = sim.stats()
		for key in ('z', 'zsd', 'ke', 'w', 'vx', 'vy'):
			acc[key] += s[key]
		acc['gt'] += s['ke'] - s['vx'] ** 2 - s['vy'] ** 2 - s['vz'] ** 2
		zmax = np.maximum(zmax, s['zmax'])
		ovl = np.maximum(ovl, s['ovl'])
		nsamp += 1
		traj.append([s['z'].copy(), s['vx'].copy()])
		if any(k >= a and k - nexpo < a for a in snap_at):
			dsnaps.append((k * dt, sim.dose.to_numpy().copy()))
	wall = time.time() - t0
	dose = sim.dose.to_numpy()
	nexp = sim.nexp.to_numpy()
	bd = sim.bdose.to_numpy()
	hist = sim.hist.to_numpy()
	flags = sim.flags.to_numpy()
	out = []
	edges = 10 ** (np.arange(D.NBIN + 1) / 8.0 - 4.0)
	for c in range(C):
		m = cidn == c
		dc = dose[m]
		mean_e = dc.mean() / t_meas
		cvT = []
		for (tt, ds) in dsnaps:
			x = ds[m]
			cvT.append((tt, float(x.std() / max(x.mean(), 1e-30))))
		# fit CV ~ a T^b on the second half of the window
		tt = np.array([a for a, _ in cvT])
		cv = np.array([b for _, b in cvT])
		sel = tt >= tt.max() / 2
		if sel.sum() >= 2 and np.all(cv[sel] > 0):
			b, a = np.polyfit(np.log(tt[sel]), np.log(cv[sel]), 1)
		else:
			a, b = float('nan'), float('nan')
		# body-direction isotropy of the coating on each sphere
		bdc = bd[m]
		iso = np.mean(bdc.std(1) / np.maximum(bdc.mean(1), 1e-30))
		# impact-velocity percentiles
		def pct(h, q):
			cs_ = np.cumsum(h)
			if cs_[-1] == 0:
				return 0.0
			i = np.searchsorted(cs_, q * cs_[-1])
			return float(edges[min(i + 1, D.NBIN)])
		# CV extrapolated to 1 h of sputtering assuming the fitted exponent (or -1/2)
		cv_last = cv[-1]
		cv1h_fit = float(math.exp(a) * 3600 ** b) if np.isfinite(a) else float('nan')
		cv1h_diff = float(cv_last * math.sqrt(t_meas / 3600.0))
		tz = np.array([t_[0][c] for t_ in traj])
		tvx = np.array([t_[1][c] for t_ in traj])
		out.append(dict(
			case=cases[c], n=int(m.sum()),
			z_rest=float(z_rest[c]), zsd_rest=float(zsd_rest[c]),
			z=float(acc['z'][c] / nsamp), zsd=float(acc['zsd'][c] / nsamp),
			dz_cm=float(acc['z'][c] / nsamp - z_rest[c]),
			zmax=float(zmax[c]), Tgran=float(acc['gt'][c] / nsamp / 3),
			vx=float(acc['vx'][c] / nsamp), vy=float(acc['vy'][c] / nsamp),
			vx_sd=float(tvx.std()), z_sd_t=float(tz.std()),
			w=float(acc['w'][c] / nsamp),
			expo_mean=float(mean_e), expo_sd=float((dc / t_meas).std()),
			never=float(np.mean(dc <= 0)),
			events_per_s=float(nexp[m].mean() / t_meas),
			cvT=cvT, cv_fit=[float(a), float(b)], cv_end=float(cv_last),
			cv1h_fit=cv1h_fit, cv1h_diff=cv1h_diff, iso=float(iso),
			vimp_pp50=pct(hist[c, 0], 0.5), vimp_pp99=pct(hist[c, 0], 0.99),
			vimp_pw50=pct(hist[c, 1], 0.5), vimp_pw99=pct(hist[c, 1], 0.99),
			ovl_max=float(ovl[c])))
	meta = dict(wall=wall, steps=nst + nm, N=int(len(rad)), flags=flags.tolist(), dt=dt,
				mat=mat, t_meas=t_meas, t_warm=t_warm)
	return out, meta
