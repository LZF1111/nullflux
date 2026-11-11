"""GPU DEM for vibrated thin granular layers (Taichi / CUDA).

Many independent cases run batched in one launch. Case kinds:
  kind 0: periodic patch Lx x Ly on a flat floor, real particle size
  kind 1: round tray of radius R with floor, side wall, optional wall fillet,
   central cone and straight floor vanes (ribs)
Contact: linear spring-dashpot normal force, history spring with Coulomb cap
(tangential), rolling resistance, optional cohesion given as a Bond number.
Rigid tray motion: vertical (1st + 2nd harmonic), horizontal x / y, torsion about z,
sinusoidal frequency modulation, linear amplitude ramp. Optional floor bending:
the floor's vertical amplitude scales by 1 + kb * (2 (r/R)^2 - 1).
Diagnostics: top-surface exposure per particle (sputter line of sight), dose under a
radial target-flux profile J(r) = 1 + j2 (r/R)^2 + j4 (r/R)^4, dose on 12 body-fixed
directions per particle (coating isotropy), impact-velocity histograms.
Positions are float32 hi/lo pairs so slow drift is not lost to rounding.
"""
import math
import numpy as np
import taichi as ti

MAXN = 24
MAXC = 16
NBIN = 32
NDIR = 12
GRAV = 9.81
vec3 = ti.math.vec3

(P_KIND, P_LX, P_LY, P_R, P_H, P_OX, P_OY, P_F, P_AZ, P_AZ2, P_PHI2, P_AX, P_PHX,
 P_AY, P_PHY, P_TH, P_PHTH, P_KH, P_EPS, P_TM, P_RAMP, P_TON, P_RF, P_RC, P_HC,
 P_BO, P_HS, P_SOX, P_SOY, P_KB, P_J2, P_J4) = range(32)
NP = 32
(Q_NX, Q_NY, Q_COFF, Q_SNX, Q_SNY, Q_SOFF, Q_V0, Q_NV) = range(8)
NQ = 8
(S_N, S_Z, S_Z2, S_VZ, S_KE, S_W, S_EXPO, S_ZMAX, S_VX, S_VY, S_VT, S_OVL,
 S_VR) = range(13)
NS = 13


def ico_dirs():
	g = (1 + 5 ** 0.5) / 2
	v = []
	for a in (-1, 1):
		for b in (-g, g):
			v += [(0, a, b), (a, b, 0), (b, 0, a)]
	v = np.array(v, float)
	return (v / np.linalg.norm(v, axis=1)[:, None]).astype(np.float32)


def case_defaults():
	return dict(kind=0, Lx=5e-3, Ly=5e-3, R=0.15, f=50.0, Az=0.0, Az2=0.0, phi2=0.0,
				Ax=0.0, phx=0.0, Ay=0.0, phy=0.0, Th=0.0, phth=0.0, kh=1.0,
				eps=0.0, Tm=1.0, ramp=0.05, ton=0.0, rf=0.0, rc=0.0, hc=0.0,
				Bo=0.0, kb=0.0, j2=0.0, j4=0.0, vanes=[])


@ti.data_oriented
class DEM:
	def __init__(self, cases, pos, rad, cid, mat, dt, skin=None, nbuild=10):
		self.C = C = len(cases)
		self.N = N = len(rad)
		self.dt = float(dt)
		self.mat = dict(mat)
		self.rho = float(mat['rho'])
		rmax = float(np.max(rad))
		self.rmax = rmax
		self.skin = float(skin if skin is not None else 0.4 * rmax)
		self.nbuild = int(nbuild)
		self.cases = []
		Pn = np.zeros((C, NP), np.float32)
		Qn = np.zeros((C, NQ), np.int32)
		vanes = []
		coff = 0
		soff = 0
		hgrid = 2.0 * rmax + self.skin
		hs0 = rmax / 2.0
		for c, cs0 in enumerate(cases):
			cs = case_defaults()
			cs.update(cs0)
			self.cases.append(cs)
			if cs['kind'] == 0:
				nx = max(3, int(cs['Lx'] / hgrid))
				ny = max(3, int(cs['Ly'] / hgrid))
				h = max(cs['Lx'] / nx, cs['Ly'] / ny)
				ox = oy = 0.0
				snx = int(round(cs['Lx'] / hs0))
				sny = int(round(cs['Ly'] / hs0))
				hs = cs['Lx'] / snx
				sox = soy = 0.0
			else:
				margin = 2e-3 + abs(cs['Ax']) + abs(cs['Ay'])
				h = hgrid
				ox = oy = -cs['R'] - margin
				nx = ny = int(math.ceil((2 * cs['R'] + 2 * margin) / h))
				hs = hs0
				sox = soy = -cs['R'] - margin
				snx = sny = int(math.ceil((2 * cs['R'] + 2 * margin) / hs))
			v0 = len(vanes)
			vanes += list(cs['vanes'])
			vals = {P_KIND: cs['kind'], P_LX: cs['Lx'], P_LY: cs['Ly'], P_R: cs['R'],
					P_H: h, P_OX: ox, P_OY: oy, P_F: cs['f'], P_AZ: cs['Az'],
					P_AZ2: cs['Az2'], P_PHI2: cs['phi2'], P_AX: cs['Ax'],
					P_PHX: cs['phx'], P_AY: cs['Ay'], P_PHY: cs['phy'],
					P_TH: cs['Th'], P_PHTH: cs['phth'], P_KH: cs['kh'],
					P_EPS: cs['eps'], P_TM: cs['Tm'], P_RAMP: cs['ramp'],
					P_TON: cs['ton'], P_RF: cs['rf'], P_RC: cs['rc'], P_HC: cs['hc'],
					P_BO: cs['Bo'], P_HS: hs, P_SOX: sox, P_SOY: soy, P_KB: cs['kb'],
					P_J2: cs['j2'], P_J4: cs['j4']}
			for k, val in vals.items():
				Pn[c, k] = val
			Qn[c] = [nx, ny, coff, snx, sny, soff, v0, len(cs['vanes'])]
			coff += nx * ny
			soff += snx * sny
		self.Pn, self.Qn = Pn, Qn
		self.P = ti.field(ti.f32, (C, NP))
		self.Q = ti.field(ti.i32, (C, NQ))
		self.P.from_numpy(Pn)
		self.Q.from_numpy(Qn)
		self.NCELL = coff
		self.NCOL = soff
		NV = max(1, len(vanes))
		self.V = ti.field(ti.f32, (NV, 6))  # x1, y1, x2, y2, height, half-thickness
		Vn = np.zeros((NV, 6), np.float32)
		if vanes:
			Vn[:len(vanes)] = np.array(vanes, np.float32)
		self.V.from_numpy(Vn)
		self.ico = ti.Vector.field(3, ti.f32, NDIR)
		self.ico.from_numpy(ico_dirs())

		f32 = ti.f32
		self.xh = ti.Vector.field(3, f32, N)
		self.xl = ti.Vector.field(3, f32, N)
		self.xb = ti.Vector.field(3, f32, N)
		self.disp = ti.Vector.field(3, f32, N)
		self.v = ti.Vector.field(3, f32, N)
		self.w = ti.Vector.field(3, f32, N)
		self.q = ti.Vector.field(4, f32, N)
		self.F = ti.Vector.field(3, f32, N)
		self.T = ti.Vector.field(3, f32, N)
		self.r = ti.field(f32, N)
		self.cid = ti.field(ti.i32, N)
		self.pcell = ti.field(ti.i32, N)
		self.poff = ti.field(ti.i32, N)
		self.sorted = ti.field(ti.i32, N)
		self.ccount = ti.field(ti.i32, self.NCELL)
		self.cstart = ti.field(ti.i32, self.NCELL)
		self.nl = ti.field(ti.i32, (N, MAXN))
		self.nn = ti.field(ti.i32, N)
		self.ckey = ti.field(ti.i32, (2, N, MAXC))
		self.cxi = ti.Vector.field(3, f32, (2, N, MAXC))
		self.ccnt = ti.field(ti.i32, (2, N))
		self.flags = ti.field(ti.i32, 4)  # 0 list overflow, 1 history overflow
		self.dmax = ti.field(f32, ())
		self.dose = ti.field(f32, N)
		self.dosej = ti.field(f32, N)
		self.nexp = ti.field(ti.i32, N)
		self.eflag = ti.field(ti.i32, N)
		self.expo = ti.field(f32, N)
		self.bdose = ti.field(f32, (N, NDIR))
		self.topz = ti.field(f32, self.NCOL)
		self.S = ti.field(f32, (C, NS))
		self.hist = ti.field(ti.i32, (C, 2, NBIN))
		self.par = 0
		self.t = 0.0
		self.nstep = 0
		self.gpu_scan = ti.lang.impl.current_cfg().arch == ti.cuda
		self.scan = ti.algorithms.PrefixSumExecutor(self.NCELL) if self.gpu_scan else None

		pos = np.asarray(pos, np.float64)
		ph = pos.astype(np.float32)
		pl = (pos - ph.astype(np.float64)).astype(np.float32)
		self.xh.from_numpy(ph)
		self.xl.from_numpy(pl)
		self.xb.from_numpy(ph)
		self.r.from_numpy(np.asarray(rad, np.float32))
		self.cid.from_numpy(np.asarray(cid, np.int32))
		rng = np.random.default_rng(7)
		qq = rng.normal(size=(N, 4)).astype(np.float32)
		qq /= np.linalg.norm(qq, axis=1)[:, None]
		self.q.from_numpy(qq)
		for fld in (self.disp, self.v, self.w, self.ccnt, self.dose, self.dosej, self.nexp,
					self.eflag, self.hist, self.flags, self.bdose, self.nn, self.S):
			fld.fill(0)
		self.b_pp = self._beta(mat['e_pp'])
		self.b_pw = self._beta(mat['e_pw'])

	@staticmethod
	def _beta(e):
		le = math.log(e)
		return -le / math.sqrt(math.pi ** 2 + le ** 2)

	# ------------------------------------------------------------- tray motion
	@ti.func
	def motion(self, c, t):
		om = 2.0 * math.pi * self.P[c, P_F]
		eps = self.P[c, P_EPS]
		te = t - self.P[c, P_TON]
		ph = om * te
		phd = om
		if eps != 0.0:
			wm = 2.0 * math.pi / self.P[c, P_TM]
			ph = om * te + om * eps / wm * (1.0 - ti.cos(wm * te))
			phd = om * (1.0 + eps * ti.sin(wm * te))
		amp = ti.min(ti.max(te / self.P[c, P_RAMP], 0.0), 1.0)
		kh = self.P[c, P_KH]
		az = self.P[c, P_AZ]
		az2 = self.P[c, P_AZ2]
		p2 = 2.0 * ph + self.P[c, P_PHI2]
		hx = kh * ph + self.P[c, P_PHX]
		hy = kh * ph + self.P[c, P_PHY]
		s = vec3(self.P[c, P_AX] * ti.sin(hx), self.P[c, P_AY] * ti.sin(hy),
				 az * ti.sin(ph) + az2 * ti.sin(p2)) * amp
		sv = vec3(self.P[c, P_AX] * kh * phd * ti.cos(hx),
				  self.P[c, P_AY] * kh * phd * ti.cos(hy),
				  phd * (az * ti.cos(ph) + 2.0 * az2 * ti.cos(p2))) * amp
		pth = ph + self.P[c, P_PHTH]
		th = self.P[c, P_TH] * ti.sin(pth) * amp
		thd = self.P[c, P_TH] * phd * ti.cos(pth) * amp
		return s, sv, th, thd

	def motion_np(self, c, t):
		P = self.Pn[c]
		om = 2 * math.pi * P[P_F]
		te = t - P[P_TON]
		ph = om * te
		if P[P_EPS] != 0:
			wm = 2 * math.pi / P[P_TM]
			ph = om * te + om * P[P_EPS] / wm * (1 - math.cos(wm * te))
		amp = min(max(te / P[P_RAMP], 0.0), 1.0)
		z = (P[P_AZ] * math.sin(ph) + P[P_AZ2] * math.sin(2 * ph + P[P_PHI2])) * amp
		x = P[P_AX] * math.sin(P[P_KH] * ph + P[P_PHX]) * amp
		y = P[P_AY] * math.sin(P[P_KH] * ph + P[P_PHY]) * amp
		th = P[P_TH] * math.sin(ph + P[P_PHTH]) * amp
		return np.array([x, y, z]), th

	# ------------------------------------------------------------- neighbour list
	@ti.func
	def cell_xy(self, c, p):
		h = self.P[c, P_H]
		nx = self.Q[c, Q_NX]
		ny = self.Q[c, Q_NY]
		ix = int(ti.floor((p.x - self.P[c, P_OX]) / h))
		iy = int(ti.floor((p.y - self.P[c, P_OY]) / h))
		if self.P[c, P_KIND] < 0.5:
			ix = ix % nx
			iy = iy % ny
		else:
			ix = ti.min(ti.max(ix, 0), nx - 1)
			iy = ti.min(ti.max(iy, 0), ny - 1)
		return ix, iy

	@ti.kernel
	def k_count(self):
		for k in self.ccount:
			self.ccount[k] = 0
		for i in range(self.N):
			c = self.cid[i]
			p = self.xh[i] + self.xl[i]
			ix, iy = self.cell_xy(c, p)
			cc = self.Q[c, Q_COFF] + iy * self.Q[c, Q_NX] + ix
			self.pcell[i] = cc
			self.poff[i] = ti.atomic_add(self.ccount[cc], 1)

	@ti.kernel
	def k_copy(self):
		for k in self.ccount:
			self.cstart[k] = self.ccount[k]

	@ti.kernel
	def k_scan_serial(self):
		ti.loop_config(serialize=True)
		for k in range(1, self.NCELL):
			self.cstart[k] += self.cstart[k - 1]

	@ti.kernel
	def k_scatter(self):
		for i in range(self.N):
			cc = self.pcell[i]
			self.sorted[self.cstart[cc] - self.ccount[cc] + self.poff[i]] = i

	@ti.func
	def pdiff(self, c, i, j):
		d = (self.xh[j] - self.xh[i]) + (self.xl[j] - self.xl[i])
		if self.P[c, P_KIND] < 0.5:
			Lx = self.P[c, P_LX]
			Ly = self.P[c, P_LY]
			d.x -= Lx * ti.round(d.x / Lx)
			d.y -= Ly * ti.round(d.y / Ly)
		return d

	@ti.kernel
	def k_nlist(self, skin: ti.f32):
		for i in range(self.N):
			c = self.cid[i]
			ri = self.r[i]
			p = self.xh[i] + self.xl[i]
			ti.atomic_max(self.dmax[None], (p - self.xb[i]).norm())
			self.xb[i] = p
			periodic = self.P[c, P_KIND] < 0.5
			nx = self.Q[c, Q_NX]
			ny = self.Q[c, Q_NY]
			co = self.Q[c, Q_COFF]
			ix, iy = self.cell_xy(c, p)
			n = 0
			for dy in range(-1, 2):
				for dx in range(-1, 2):
					jx = ix + dx
					jy = iy + dy
					ok = True
					if periodic:
						jx = jx % nx
						jy = jy % ny
					elif jx < 0 or jx >= nx or jy < 0 or jy >= ny:
						ok = False
					if ok:
						cc = co + jy * nx + jx
						for kk in range(self.cstart[cc] - self.ccount[cc], self.cstart[cc]):
							j = self.sorted[kk]
							if j != i:
								d = self.pdiff(c, i, j)
								rc = ri + self.r[j] + skin
								if d.dot(d) < rc * rc:
									if n < MAXN:
										self.nl[i, n] = j
										n += 1
									else:
										ti.atomic_add(self.flags[0], 1)
			self.nn[i] = n

	def build(self):
		self.dmax[None] = 0.0
		self.k_count()
		self.k_copy()
		if self.gpu_scan:
			self.scan.run(self.cstart)
		else:
			self.k_scan_serial()
		self.k_scatter()
		self.k_nlist(self.skin)

	# ------------------------------------------------------------- contacts
	@ti.func
	def lsd(self, n, delta, vrel, wrel, Reff, meff, kn, beta, mu, mur, xi_old, dt):
		# n points from particle i toward the other body; forces returned act on i
		vn = vrel.dot(n)
		gn = 2.0 * beta * ti.sqrt(meff * kn)
		fn = ti.max(kn * delta + gn * vn, 0.0)
		vt = vrel - vn * n
		xi = xi_old - xi_old.dot(n) * n
		mo = xi_old.norm()
		mn = xi.norm()
		if mn > 1e-30:
			xi = xi * (mo / mn)
		xi = xi + vt * dt
		kt = kn * (2.0 / 7.0)
		gt = gn * 0.5
		ft = -kt * xi - gt * vt
		ftm = ft.norm()
		cap = mu * fn
		if ftm > cap:
			if ftm > 1e-30:
				ft = ft * (cap / ftm)
			xi = -(ft + gt * vt) / kt
		wr = wrel - wrel.dot(n) * n
		Mr = -mur * Reff * fn * wr / ti.max(wr.norm(), 20.0)
		return -fn * n, ft, Mr, xi

	@ti.func
	def find_old(self, po, i, key):
		xi = vec3(0.0)
		found = 0
		for k in range(self.ccnt[po, i]):
			if found == 0 and self.ckey[po, i, k] == key:
				xi = self.cxi[po, i, k]
				found = 1
		return xi, found

	@ti.func
	def mass(self, r):
		return self.rho * (4.0 / 3.0 * math.pi) * r * r * r

	@ti.func
	def vbin(self, vn):
		b = int((ti.log(ti.max(vn, 1e-6)) / ti.log(10.0) + 4.0) * 8.0)
		return ti.min(ti.max(b, 0), NBIN - 1)

	@ti.func
	def push_hist(self, pn, i, cnt, key, xi):
		n = cnt
		if n < MAXC:
			self.ckey[pn, i, n] = key
			self.cxi[pn, i, n] = xi
			n += 1
		else:
			ti.atomic_add(self.flags[1], 1)
		return n

	@ti.func
	def wall_contact(self, i, c, po, pn, key, nt, delta, vwall, wwall, ri, mi, vi, wi,
					 Fcw, cnt, F, T, kn0, r0, bpw, mupw, murpw, dt):
		Fo = F
		To = T
		n = cnt
		if delta > -0.02 * ri and Fcw > 0.0:
			fc = Fcw
			if delta < 0.0:
				fc = Fcw * (1.0 + delta / (0.02 * ri))
			Fo += fc * nt
		if delta > 0.0:
			kn = kn0 * (ri / (0.5 * r0))
			vrel = vi + wi.cross(ri * nt) - vwall
			xi_old, found = self.find_old(po, i, key)
			Fn, Ft, Mr, xi = self.lsd(nt, delta, vrel, wi - wwall, ri, mi, kn, bpw, mupw,
									  murpw, xi_old, dt)
			Fo += Fn + Ft
			To += (ri * nt).cross(Ft) + Mr
			if found == 0:
				vn = vrel.dot(nt)
				if vn > 0.0:
					ti.atomic_add(self.hist[c, 1, self.vbin(vn)], 1)
			ti.atomic_max(self.S[c, S_OVL], delta / ri)
			n = self.push_hist(pn, i, n, key, xi)
		return n, Fo, To

	@ti.func
	def tray_wall(self, i, c, po, pn, key, ntt, delta, xt, yt, ct, st, sv, thd, ri, mi,
				  vi, wi, Fcw, cnt, F, T, kn0, r0, bpw, mupw, murpw, dt):
		# ntt is in the tray frame: rotate to lab, wall velocity at the contact point
		nl = vec3(ct * ntt.x - st * ntt.y, st * ntt.x + ct * ntt.y, ntt.z)
		cx = xt + ri * ntt.x
		cy = yt + ri * ntt.y
		lx = ct * cx - st * cy
		ly = st * cx + ct * cy
		vw = sv + vec3(-thd * ly, thd * lx, 0.0)
		return self.wall_contact(i, c, po, pn, key, nl, delta, vw, vec3(0.0, 0.0, thd),
								 ri, mi, vi, wi, Fcw, cnt, F, T, kn0, r0, bpw, mupw,
								 murpw, dt)

	@ti.kernel
	def k_force(self, t: ti.f32, po: ti.i32, kn0: ti.f32, r0: ti.f32, bpp: ti.f32,
				bpw: ti.f32, mupp: ti.f32, mupw: ti.f32, murpp: ti.f32, murpw: ti.f32,
				dt: ti.f32):
		pn = 1 - po
		for i in range(self.N):
			c = self.cid[i]
			ri = self.r[i]
			mi = self.mass(ri)
			p = self.xh[i] + self.xl[i]
			vi = self.v[i]
			wi = self.w[i]
			F = vec3(0.0)
			T = vec3(0.0)
			cnt = 0
			Bo = self.P[c, P_BO]
			for k in range(self.nn[i]):
				j = self.nl[i, k]
				d = self.pdiff(c, i, j)
				rj = self.r[j]
				rs = ri + rj
				d2 = d.dot(d)
				if d2 < (rs * 1.02) * (rs * 1.02):
					dist = ti.sqrt(d2)
					n = d / dist
					delta = rs - dist
					mj = self.mass(rj)
					meff = mi * mj / (mi + mj)
					Reff = ri * rj / rs
					if Bo > 0.0:
						fc = Bo * GRAV * 2.0 * meff
						if delta < 0.0:
							fc *= ti.max(1.0 + delta / (0.02 * Reff), 0.0)
						F += fc * n
					if delta > 0.0:
						kn = kn0 * (Reff / (0.5 * r0))
						vrel = (vi + wi.cross(ri * n)) - (self.v[j] + self.w[j].cross(-rj * n))
						xi_old, found = self.find_old(po, i, j)
						Fn, Ft, Mr, xi = self.lsd(n, delta, vrel, wi - self.w[j], Reff, meff,
												  kn, bpp, mupp, murpp, xi_old, dt)
						F += Fn + Ft
						T += (ri * n).cross(Ft) + Mr
						if found == 0 and j > i:
							vn = vrel.dot(n)
							if vn > 0.0:
								ti.atomic_add(self.hist[c, 0, self.vbin(vn)], 1)
						cnt = self.push_hist(pn, i, cnt, j, xi)
			# walls, evaluated in the tray frame
			s, sv, th, thd = self.motion(c, t)
			Fcw = Bo * GRAV * mi
			ct = ti.cos(th)
			st = ti.sin(th)
			qv = p - s
			xt = ct * qv.x + st * qv.y
			yt = -st * qv.x + ct * qv.y
			zt = qv.z
			if self.P[c, P_KIND] < 0.5:
				cnt, F, T = self.tray_wall(i, c, po, pn, -1, vec3(0.0, 0.0, -1.0), ri - zt,
										   xt, yt, ct, st, sv, thd, ri, mi, vi, wi, Fcw,
										   cnt, F, T, kn0, r0, bpw, mupw, murpw, dt)
			else:
				rt = ti.sqrt(xt * xt + yt * yt)
				er = vec3(1.0, 0.0, 0.0)
				if rt > 1e-9:
					er = vec3(xt / rt, yt / rt, 0.0)
				R = self.P[c, P_R]
				rf = self.P[c, P_RF]
				# floor bending: extra vertical floor displacement relative to the rigid tray
				kb = self.P[c, P_KB]
				mb = kb * (2.0 * (rt / R) * (rt / R) - 1.0)
				zf = mb * s.z
				svf = sv + vec3(0.0, 0.0, mb * sv.z)
				if rf > 0.0 and rt > R - rf and zt < rf:
					dr = rt - (R - rf)
					dz = zt - rf
					dd = ti.sqrt(dr * dr + dz * dz) + 1e-12
					ntt = (dr / dd) * er + vec3(0.0, 0.0, dz / dd)
					cnt, F, T = self.tray_wall(i, c, po, pn, -2, ntt, ri + dd - rf, xt, yt,
											   ct, st, sv, thd, ri, mi, vi, wi, Fcw, cnt, F,
											   T, kn0, r0, bpw, mupw, murpw, dt)
				else:
					cnt, F, T = self.tray_wall(i, c, po, pn, -1, vec3(0.0, 0.0, -1.0),
											   ri - (zt - zf), xt, yt, ct, st, svf, thd, ri,
											   mi, vi, wi, Fcw, cnt, F, T, kn0, r0, bpw,
											   mupw, murpw, dt)
					cnt, F, T = self.tray_wall(i, c, po, pn, -2, er, ri - (R - rt), xt, yt,
											   ct, st, sv, thd, ri, mi, vi, wi, Fcw, cnt, F,
											   T, kn0, r0, bpw, mupw, murpw, dt)
				rc = self.P[c, P_RC]
				if rc > 0.0 and rt < rc + 2.0 * ri:
					# cone surface: segment (r=0, z=hc) -> (r=rc, z=0) in the (r, z) plane
					hc = self.P[c, P_HC]
					tt = (rt * rc - (zt - hc) * hc) / (rc * rc + hc * hc)
					tt = ti.min(ti.max(tt, 0.0), 1.0)
					qr = tt * rc
					qz = hc - tt * hc
					gr = qr - rt
					gz = qz - zt
					gd = ti.sqrt(gr * gr + gz * gz) + 1e-12
					nlen = ti.sqrt(hc * hc + rc * rc)
					nr = hc / nlen
					nz = rc / nlen
					side = (rt - qr) * nr + (zt - qz) * nz
					delta = ri - gd
					ntt = (gr / gd) * er + vec3(0.0, 0.0, gz / gd)
					if side < 0.0:
						delta = ri + gd
						ntt = -(nr * er + vec3(0.0, 0.0, nz))
					cnt, F, T = self.tray_wall(i, c, po, pn, -3, ntt, delta, xt, yt, ct, st,
											   sv, thd, ri, mi, vi, wi, Fcw, cnt, F, T, kn0,
											   r0, bpw, mupw, murpw, dt)
			v0 = self.Q[c, Q_V0]
			for kv in range(self.Q[c, Q_NV]):
				vk = v0 + kv
				x1 = self.V[vk, 0]
				y1 = self.V[vk, 1]
				ux = self.V[vk, 2] - x1
				uy = self.V[vk, 3] - y1
				hv = self.V[vk, 4]
				tv = self.V[vk, 5]
				tt = ((xt - x1) * ux + (yt - y1) * uy) / (ux * ux + uy * uy)
				tt = ti.min(ti.max(tt, 0.0), 1.0)
				g = vec3(x1 + tt * ux - xt, y1 + tt * uy - yt,
						 ti.min(ti.max(zt, 0.0), hv) - zt)
				gd = g.norm() + 1e-12
				if gd < ri + tv + 0.02 * ri:
					cnt, F, T = self.tray_wall(i, c, po, pn, -4 - kv, g / gd, ri + tv - gd,
											   xt, yt, ct, st, sv, thd, ri, mi, vi, wi, Fcw,
											   cnt, F, T, kn0, r0, bpw, mupw, murpw, dt)
			self.F[i] = F
			self.T[i] = T
			self.ccnt[pn, i] = cnt

	@ti.kernel
	def k_integrate(self, dt: ti.f32):
		for i in range(self.N):
			c = self.cid[i]
			ri = self.r[i]
			mi = self.mass(ri)
			v = self.v[i] + (self.F[i] / mi + vec3(0.0, 0.0, -GRAV)) * dt
			w = self.w[i] + self.T[i] / (0.4 * mi * ri * ri) * dt
			dx = v * dt
			a = self.xh[i]
			sm = a + dx
			bb = sm - a
			err = (a - (sm - bb)) + (dx - bb)
			lo = self.xl[i] + err
			hi = sm + lo
			lo = lo - (hi - sm)
			if self.P[c, P_KIND] < 0.5:
				Lx = self.P[c, P_LX]
				Ly = self.P[c, P_LY]
				sh = vec3(0.0)
				if hi.x >= Lx:
					sh.x = -Lx
				if hi.x < 0.0:
					sh.x = Lx
				if hi.y >= Ly:
					sh.y = -Ly
				if hi.y < 0.0:
					sh.y = Ly
				hi += sh
				self.xb[i] += sh
			self.disp[i] += dx
			self.xh[i] = hi
			self.xl[i] = lo
			self.v[i] = v
			self.w[i] = w
			q = self.q[i]
			dq = 0.5 * dt * ti.Vector([-w.x * q[1] - w.y * q[2] - w.z * q[3],
									   w.x * q[0] + w.y * q[3] - w.z * q[2],
									   -w.x * q[3] + w.y * q[0] + w.z * q[1],
									   w.x * q[2] - w.y * q[1] + w.z * q[0]])
			q = q + dq
			self.q[i] = q / q.norm()

	def step(self, n=1):
		m = self.mat
		for _ in range(n):
			if self.nstep % self.nbuild == 0:
				self.build()
			self.k_force(self.t, self.par, m['kn0'], m['r0'], self.b_pp, self.b_pw,
						 m['mu_pp'], m['mu_pw'], m['mur_pp'], m['mur_pw'], self.dt)
			self.par = 1 - self.par
			self.k_integrate(self.dt)
			self.t += self.dt
			self.nstep += 1

	# ------------------------------------------------------------- exposure / coating
	@ti.kernel
	def k_expo_clear(self):
		for k in self.topz:
			self.topz[k] = -1e9

	@ti.func
	def col_index(self, c, ix, iy):
		snx = self.Q[c, Q_SNX]
		sny = self.Q[c, Q_SNY]
		jx = ix
		jy = iy
		ok = True
		if self.P[c, P_KIND] < 0.5:
			jx = ix % snx
			jy = iy % sny
		elif ix < 0 or ix >= snx or iy < 0 or iy >= sny:
			ok = False
		return self.Q[c, Q_SOFF] + jy * snx + jx, ok

	@ti.kernel
	def k_expo_max(self):
		for i in range(self.N):
			c = self.cid[i]
			p = self.xh[i] + self.xl[i]
			r = self.r[i]
			hs = self.P[c, P_HS]
			ox = self.P[c, P_SOX]
			oy = self.P[c, P_SOY]
			for ix in range(int(ti.floor((p.x - r - ox) / hs)), int(ti.floor((p.x + r - ox) / hs)) + 1):
				for iy in range(int(ti.floor((p.y - r - oy) / hs)), int(ti.floor((p.y + r - oy) / hs)) + 1):
					cx = ox + (ix + 0.5) * hs - p.x
					cy = oy + (iy + 0.5) * hs - p.y
					d2 = cx * cx + cy * cy
					if d2 < r * r:
						col, ok = self.col_index(c, ix, iy)
						if ok:
							ti.atomic_max(self.topz[col], p.z + ti.sqrt(r * r - d2))

	@ti.kernel
	def k_expo_acc(self, dts: ti.f32):
		for i in range(self.N):
			c = self.cid[i]
			p = self.xh[i] + self.xl[i]
			r = self.r[i]
			hs = self.P[c, P_HS]
			ox = self.P[c, P_SOX]
			oy = self.P[c, P_SOY]
			ntot = 0
			ntop = 0
			for ix in range(int(ti.floor((p.x - r - ox) / hs)), int(ti.floor((p.x + r - ox) / hs)) + 1):
				for iy in range(int(ti.floor((p.y - r - oy) / hs)), int(ti.floor((p.y + r - oy) / hs)) + 1):
					cx = ox + (ix + 0.5) * hs - p.x
					cy = oy + (iy + 0.5) * hs - p.y
					d2 = cx * cx + cy * cy
					if d2 < r * r:
						col, ok = self.col_index(c, ix, iy)
						if ok:
							ntot += 1
							if p.z + ti.sqrt(r * r - d2) >= self.topz[col] - 1e-9:
								ntop += 1
			e = 0.0
			if ntot > 0:
				e = ntop / ntot
			J = 1.0
			if self.P[c, P_KIND] > 0.5:
				R = self.P[c, P_R]
				rr = (p.x * p.x + p.y * p.y) / (R * R)
				J = 1.0 + self.P[c, P_J2] * rr + self.P[c, P_J4] * rr * rr
			self.expo[i] = e
			self.dose[i] += e * dts
			self.dosej[i] += J * e * dts
			if e > 0.5 and self.eflag[i] == 0:
				self.nexp[i] += 1
				self.eflag[i] = 1
			elif e < 0.05:
				self.eflag[i] = 0
			ti.atomic_add(self.S[c, S_EXPO], e)
			if e > 0.0:
				q = self.q[i]
				# lab +z (toward the target) expressed in the particle body frame
				ub = vec3(2.0 * (q[1] * q[3] - q[0] * q[2]), 2.0 * (q[2] * q[3] + q[0] * q[1]),
						  1.0 - 2.0 * (q[1] * q[1] + q[2] * q[2]))
				for k in range(NDIR):
					self.bdose[i, k] += e * dts * ti.max(self.ico[k].dot(ub), 0.0)

	def expose(self, dts):
		self.k_expo_clear()
		self.k_expo_max()
		self.k_expo_acc(dts)

	def reset_dose(self):
		for fld in (self.dose, self.dosej, self.nexp, self.eflag, self.bdose, self.hist):
			fld.fill(0)

	# ------------------------------------------------------------- stats
	@ti.kernel
	def k_stats(self):
		for i in range(self.N):
			c = self.cid[i]
			p = self.xh[i] + self.xl[i]
			v = self.v[i]
			ti.atomic_add(self.S[c, S_N], 1.0)
			ti.atomic_add(self.S[c, S_Z], p.z)
			ti.atomic_add(self.S[c, S_Z2], p.z * p.z)
			ti.atomic_add(self.S[c, S_VZ], v.z)
			ti.atomic_add(self.S[c, S_VX], v.x)
			ti.atomic_add(self.S[c, S_VY], v.y)
			ti.atomic_add(self.S[c, S_KE], v.dot(v))
			ti.atomic_add(self.S[c, S_W], self.w[i].norm())
			ti.atomic_max(self.S[c, S_ZMAX], p.z)
			if self.P[c, P_KIND] > 0.5:
				rr = ti.sqrt(p.x * p.x + p.y * p.y) + 1e-12
				ti.atomic_add(self.S[c, S_VT], (-p.y * v.x + p.x * v.y) / rr)
				ti.atomic_add(self.S[c, S_VR], (p.x * v.x + p.y * v.y) / rr)

	def stats(self):
		ovl = self.S.to_numpy()[:, S_OVL].copy()
		self.S.fill(0)
		self.k_stats()
		S = self.S.to_numpy()
		n = np.maximum(S[:, S_N], 1)
		out = dict(z=S[:, S_Z] / n,
				   zsd=np.sqrt(np.maximum(S[:, S_Z2] / n - (S[:, S_Z] / n) ** 2, 0)),
				   vz=S[:, S_VZ] / n, vx=S[:, S_VX] / n, vy=S[:, S_VY] / n,
				   ke=S[:, S_KE] / n, w=S[:, S_W] / n, zmax=S[:, S_ZMAX],
				   vt=S[:, S_VT] / n, vr=S[:, S_VR] / n, ovl=ovl)
		self.S.fill(0)
		return out

	def positions(self):
		return self.xh.to_numpy().astype(np.float64) + self.xl.to_numpy().astype(np.float64)


# ------------------------------------------------------------------ set-up helpers
MAT = dict(rho=10000.0, r0=50e-6, kn0=100.0, e_pp=0.7, e_pw=0.6, mu_pp=0.4, mu_pw=0.35,
		   mur_pp=0.05, mur_pw=0.05)
TRAY_R = 0.15
MASS = 0.2
AREAL = MASS / (math.pi * TRAY_R ** 2)  # kg per m^2 of tray floor


def pmass(r, rho=10000.0):
	return rho * 4.0 / 3.0 * math.pi * r ** 3


def contact_time(mat, r=None):
	r = r or mat['r0']
	m = pmass(r, mat['rho'])
	kn = mat['kn0'] * (r / 2) / (0.5 * mat['r0'])
	b = DEM._beta(mat['e_pp'])
	return math.pi / (math.sqrt(kn / (m / 2)) * math.sqrt(1 - b * b))


def sample_radii(n, rng, r0=50e-6, spread=0.1):
	return r0 * rng.uniform(1 - spread, 1 + spread, n)


def mean_mass(rho, r0, spread):
	u = np.linspace(1 - spread, 1 + spread, 2001)
	return pmass(r0, rho) * float(np.mean(u ** 3))


def fill_patch(Lx, Ly, rng, rho=10000.0, r0=50e-6, spread=0.1, areal=AREAL):
	"""Particles for a periodic patch carrying the tray's mass per unit area."""
	n = int(round(areal * Lx * Ly / mean_mass(rho, r0, spread)))
	rad = sample_radii(n, rng, r0, spread)
	a = 2 * r0 * (1 + spread) * 1.08
	nx = int(Lx / a)
	ny = int(Ly / a)
	ax, ay = Lx / nx, Ly / ny
	k = np.arange(n)
	lay = k // (nx * ny)
	rem = k % (nx * ny)
	x = (rem % nx + 0.5) * ax + rng.uniform(-0.03, 0.03, n) * a
	y = (rem // nx + 0.5) * ay + rng.uniform(-0.03, 0.03, n) * a
	z = r0 * (1 + spread) * 1.05 + lay * a
	return np.stack([x, y, z], 1), rad


def fill_tray(R, rng, mass, rho=10000.0, r0=50e-6, spread=0.1, rin=0.0, z0=0.0,
			  vanes=()):
	n = int(round(mass / mean_mass(rho, r0, spread)))
	rad = sample_radii(n, rng, r0, spread)
	a = 2 * r0 * (1 + spread) * 1.08
	g = np.arange(-R, R, a) + a / 2
	X, Y = np.meshgrid(g, g)
	X, Y = X.ravel(), Y.ravel()
	rr = np.hypot(X, Y)
	m = (rr < R - a) & (rr > rin + a)
	for (x1, y1, x2, y2, hv, tv) in vanes:
		ux, uy = x2 - x1, y2 - y1
		tt = np.clip(((X - x1) * ux + (Y - y1) * uy) / (ux * ux + uy * uy), 0, 1)
		dd = np.hypot(X - x1 - tt * ux, Y - y1 - tt * uy)
		m &= dd > tv + a
	X, Y = X[m], Y[m]
	per = len(X)
	k = np.arange(n)
	lay = k // per
	rem = k % per
	x = X[rem] + rng.uniform(-0.03, 0.03, n) * a
	y = Y[rem] + rng.uniform(-0.03, 0.03, n) * a
	z = r0 * (1 + spread) * 1.05 + lay * a + z0
	return np.stack([x, y, z], 1), rad
