#!/usr/bin/env python3
"""Wide shallow reactor with a dense zone distributor (fine route control study).

Geometry (defaults): W = 1.2 m wide, liquid 0.30 m, domain 0.40 m, quasi-2D, 24 bottom zones of 5 cm.
Each zone is an on/off actuator: on = superficial gas velocity UG_ON over that zone (inlet
alpha.air 0.5), off = no gas. Any subset of zones can be on. Physics as in the narrow column
(make_template.py: twoPhaseEulerFoam, tutorial RAS/bubbleColumn settings).

  wide.py make [--dx 0.01]     -> case_wide_dx<mm>/
  wide.py batch <list.json> [--jobs 8]       runs in ~/bubble_col/wide/<id>
  wide.py kernel <run_dir>...  mean field, plume position and meandering per run

list.json entries: {"id": ..., "dx": 0.01, "schedule": [[t, [zone indices on]], ...],
  "t_write": 10, "t_end": 25, "model": {...}}   (zone index 0 = leftmost)
"""
import argparse, json, os, re, shutil, subprocess, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import traj as T
import case_runner as CR

W = float(os.environ.get('WIDE_W', 1.2))
HL, HD = 0.30, 0.40
NZ = int(os.environ.get('WIDE_NZ', 24))
UG_ON = float(os.environ.get('WIDE_UG', 0.03))
RUNS = os.path.expanduser('~/bubble_col/wide')
ZW = W / NZ


def zone_x(k):
	return -W / 2 + (k + 0.5) * ZW


def template_dir(dx):
	return os.path.join(HERE, f'case_wide_dx{dx * 1000:g}')


def make(dx):
	import make_template as MT
	MT.W, MT.H_LIQ, MT.H_DOM, MT.DX = W, HL, HD, dx
	MT.NZONES, MT.NZ = NZ, 1
	MT.NXZ = int(round(ZW / dx))
	MT.NY = int(round(HD / dx))
	MT.E = [round(-W / 2 + k * ZW, 6) for k in range(NZ + 1)]
	MT.ZONES = [f'zone{i + 1}_inlet' for i in range(NZ)]
	MT.UG = UG_ON
	MT.OUT = template_dir(dx)
	MT.main()
	json.dump(dict(dx=dx, W=W, HL=HL, HD=HD, NZ=NZ, UG_ON=UG_ON), open(os.path.join(MT.OUT, 'wide.json'), 'w'))


class Grid:
	def __init__(self, case):
		z = json.load(open(os.path.join(case, 'wide.json')))
		self.dx = z['dx']
		self.nx, self.ny = int(round(W / self.dx)), int(round(HD / self.dx))
		c = T.read_internal(os.path.join(case, '0', 'C'), True)
		self.ix = np.clip(np.round((c[:, 0] + W / 2) / self.dx - 0.5).astype(int), 0, self.nx - 1)
		self.iy = np.clip(np.round(c[:, 1] / self.dx - 0.5).astype(int), 0, self.ny - 1)
		self.xc = -W / 2 + (np.arange(self.nx) + 0.5) * self.dx
		self.yc = (np.arange(self.ny) + 0.5) * self.dx

	def vec(self, case, tdir, name='U.water'):
		u = T.read_internal(os.path.join(case, tdir, name), True)
		gu = np.zeros((self.nx, self.ny)); gv = np.zeros((self.nx, self.ny))
		gu[self.ix, self.iy] = u[:, 0]; gv[self.ix, self.iy] = u[:, 1]
		return gu, gv

	def scal(self, case, tdir, name='alpha.air'):
		a = T.read_internal(os.path.join(case, tdir, name), False)
		g = np.zeros((self.nx, self.ny)); g[self.ix, self.iy] = a
		return g


def time_dirs(case, t_lo=-1.0):
	return sorted((d for d in os.listdir(case) if re.fullmatch(r'[0-9.]+', d) and float(d) >= t_lo - 1e-6), key=float)


def levels(on):
	z = [0.0] * NZ
	for k in on:
		z[int(k)] = UG_ON
	return z


def breakpoints(sched):
	sched = sorted(sched, key=lambda e: e[0])
	cur = levels(sched[0][1]); bp = [(0.0, cur)]
	for t, on in sched[1:]:
		new = levels(on)
		if new != cur:
			bp += [(float(t), cur), (float(t) + 0.05, new)]
			cur = new
	return bp + [(1000.0, cur)]


def init_case(case, p):
	if os.path.exists(case):
		shutil.rmtree(case)
	shutil.copytree(template_dir(p.get('dx', 0.01)), case)
	json.dump(p, open(os.path.join(case, 'params.json'), 'w'))
	CR.apply_model(case, p.get('model'))
	CR.foam(case, 'blockMesh', 'log.blockMesh')
	CR.foam(case, 'setFields', 'log.setFields')
	CR.foam(case, 'postProcess', 'log.cellCentres', '-func', 'writeCellCentres', '-time', '0')


def run_case(p):
	case = os.path.join(RUNS, p['id'])
	if os.path.exists(os.path.join(case, 'result.json')):
		return p['id'], 'skip'
	t0 = time.time()
	try:
		init_case(case, p)
		CR.write_tables(case, breakpoints(p['schedule']))
		CR.set_ctrl(case, endTime=f"{p['t_write']:g}", writeInterval=f"{p['t_write']:g}")
		CR.foam(case, 'twoPhaseEulerFoam', 'log.solve1')
		CR.set_ctrl(case, endTime=f"{p['t_end']:g}", writeInterval='0.1')
		CR.foam(case, 'twoPhaseEulerFoam', 'log.solve2')
		st = 'done'
	except Exception as e:
		st = 'FAILED ' + str(e)[-300:]
	json.dump(dict(id=p['id'], status=st, wall_s=round(time.time() - t0, 1)), open(os.path.join(case, 'result.json'), 'w'))
	return p['id'], st + f' {time.time() - t0:.0f}s'


def cmd_batch(a):
	from concurrent.futures import ThreadPoolExecutor
	os.makedirs(RUNS, exist_ok=True)
	plist = json.load(open(a.path))
	with ThreadPoolExecutor(a.jobs) as ex:
		for pid, st in ex.map(run_case, plist):
			print(pid, st, flush=True)


def analyse(case):
	p = json.load(open(os.path.join(case, 'params.json')))
	g = Grid(case)
	ds = time_dirs(case, p['t_write'])
	ts = np.array([float(d) for d in ds])
	U = np.zeros((len(ds), g.nx, g.ny), np.float32); V = np.zeros_like(U)
	for k, d in enumerate(ds):
		U[k], V[k] = g.vec(case, d)
	j = int(0.15 / g.dx)
	# plume position: x of the peak upward velocity at mid height, 0.5 s moving average of the profile
	xp = np.array([g.xc[int(np.argmax(V[k][:, j]))] for k in range(len(ds))])
	np.savez_compressed(os.path.join(case, 'mean.npz'), t=ts, u=U.mean(0), v=V.mean(0), xp=xp, xc=g.xc, yc=g.yc,
		u_rms=U.std(0), v_rms=V.std(0))
	return p, g, ts, U, V, xp


def cmd_kernel(a):
	for case in a.dirs:
		p, g, ts, U, V, xp = analyse(case)
		sched = sorted(p['schedule'], key=lambda e: e[0])
		name = os.path.basename(case.rstrip('/'))
		if len(sched) > 2:
			print(f'== {name}: moving plume (t, active zone x [cm], plume x [cm])')
			for k in range(0, len(ts), 5):
				on = [e[1] for e in sched if e[0] <= ts[k] + 1e-9][-1]
				print(f'   {ts[k]:5.1f}  {zone_x(on[0]) * 100:+6.1f}  {xp[k] * 100:+6.1f}')
			continue
		on = sched[-1][1]
		vm = V.mean(0); j = int(0.15 / g.dx)
		# peaks of the mean upward velocity at mid height
		prof = vm[:, j]
		pk = [i for i in range(1, g.nx - 1) if prof[i] > prof[i - 1] and prof[i] >= prof[i + 1] and prof[i] > 0.3 * prof.max()]
		sp = np.hypot(U, V)[:, :, :int(HL / g.dx)]
		print(f'== {name}: zones on at x = {[round(zone_x(k) * 100, 1) for k in on]} cm | mean-flow plume peaks at '
			f'{[round(float(g.xc[i]) * 100, 1) for i in pk]} cm | instantaneous peak x: mean {xp.mean() * 100:+.1f} sd {xp.std() * 100:.1f} cm'
			f' | max mean v {prof.max():.3f} m/s | mean |u| {sp.mean():.3f} m/s')
		# lateral extent of the cell: where the mean bottom flow (y = 3 cm) toward the plume drops below 10 % of its peak
		ub = U.mean(0)[:, int(0.03 / g.dx)]
		print('   mean u at y=3 cm, every 10 cm:', ' '.join(f'{float(np.interp(x, g.xc, ub)):+.2f}' for x in np.arange(-0.55, 0.56, 0.1)))


def main():
	ap = argparse.ArgumentParser()
	sp = ap.add_subparsers(dest='cmd', required=True)
	p = sp.add_parser('make'); p.add_argument('--dx', type=float, default=0.01)
	p = sp.add_parser('batch'); p.add_argument('path'); p.add_argument('--jobs', type=int, default=8)
	p = sp.add_parser('kernel'); p.add_argument('dirs', nargs='+')
	a = ap.parse_args()
	if a.cmd == 'make':
		make(a.dx)
	else:
		globals()['cmd_' + a.cmd](a)


if __name__ == '__main__':
	main()
