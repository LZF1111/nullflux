#!/usr/bin/env python3
"""Swarm-control feasibility on recorded CFD mode fields (surrogate plant, no new CFD).

  swarm_feas.py <runs_dir>  ->  printed tables + <runs_dir>/swarm_feas.json

Plant surrogate: each mode (L/C/R = all gas to one zone) is its recorded 15 s window of U.water
(0.1 s snapshots, looped, random start phase). After a switch the field relaxes from the field at
the switch to the new mode's field with tau = 2 s (order of the measured step response).
Particles: v_p = u_l + (0, -w_s) + random walk (D = 2e-4 m2/s, eddy-diffusivity order),
reflected at walls, bottom and free surface.

A  mixing of a neutral blob (w_s = 0): fixed modes vs periodic L/R switching (blinking vortex)
B  herding: fraction of the swarm inside a target box, from a uniform start, for neutral and heavy
   particles; fixed modes, best periodic schedule, and swarm feedback (every 0.5 s pick the mode
   whose 1.5 s prediction on a *different* model, mean fields + first-order lag, puts the most
   particles in the box)
"""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import traj as T

MODES = dict(L='L6_600', C='L6_060', R='L6_006')
DT, TAU, DIFF, SNAP = 0.05, 2.0, 2e-4, 0.1
LO, HI = T.X0 + 1e-4, T.X1 - 1e-4
YTOP = T.G['H_liq_m'] - T.DX
BOXES = dict(corner=(-0.15, -0.05, 0.0, 0.10), centre=(-0.05, 0.05, 0.15, 0.30), right_top=(0.05, 0.15, 0.30, 0.45))


def interp(G, x, y):
    fi = np.clip((x - T.X0) / T.DX - 0.5, 0, T.NX - 1.000001)
    fj = np.clip(y / T.DX - 0.5, 0, T.NY - 1.000001)
    i = fi.astype(int); j = fj.astype(int); a = fi - i; b = fj - j
    return G[i, j] * (1 - a) * (1 - b) + G[i + 1, j] * a * (1 - b) + G[i, j + 1] * (1 - a) * b + G[i + 1, j + 1] * a * b


def load_mode(runs, rid):
    case = os.path.join(runs, rid)
    gi = T.grid_index(case)
    ts, U, _ = T.load_series(case, *gi)
    return np.array([u[0] for u in U]), np.array([u[1] for u in U])


class Plant:
    """Recorded fields per mode + exponential blend after a switch."""

    def __init__(self, lib, mode, rng):
        self.lib, self.rng, self.mode = lib, rng, mode
        self.phase = float(rng.uniform(0, len(lib[mode][0]) * SNAP))
        self.prev, self.ts = None, 1e9

    def raw(self):
        U, V = self.lib[self.mode]
        k = int(self.phase / SNAP) % len(U)
        return U[k], V[k]

    def field(self):
        u, v = self.raw()
        if self.prev is not None and self.ts < 6 * TAU:
            w = np.exp(-self.ts / TAU)
            return w * self.prev[0] + (1 - w) * u, w * self.prev[1] + (1 - w) * v
        return u, v

    def switch(self, m):
        if m != self.mode:
            self.prev = self.field()
            self.mode, self.ts = m, 0.0
            self.phase = float(self.rng.uniform(0, len(self.lib[m][0]) * SNAP))

    def tick(self, dt):
        self.phase += dt; self.ts += dt


class LagModel:
    """Controller's model: time-mean field per mode + first-order lag (no fluctuations)."""

    def __init__(self, means, mode):
        self.means = means
        self.F = means[mode]

    def step(self, mode, dt):
        a = 1 - np.exp(-dt / TAU); M = self.means[mode]
        self.F = (self.F[0] + a * (M[0] - self.F[0]), self.F[1] + a * (M[1] - self.F[1]))


def move(x, y, u, v, ws, dt, rng=None):
    def vel(x, y):
        xs = np.clip(x, LO + T.DX, HI - T.DX); ys = np.maximum(y, T.DX)
        return interp(u, xs, ys), interp(v, xs, ys) - ws
    u1, v1 = vel(x, y)
    u2, v2 = vel(x + 0.5 * dt * u1, y + 0.5 * dt * v1)
    x = x + dt * u2; y = y + dt * v2
    if rng is not None:
        s = np.sqrt(2 * DIFF * dt)
        x = x + s * rng.standard_normal(x.shape); y = y + s * rng.standard_normal(y.shape)
    x = np.where(x < LO, 2 * LO - x, x); x = np.where(x > HI, 2 * HI - x, x)
    y = np.abs(y); y = np.where(y > YTOP, 2 * YTOP - y, y)
    return np.clip(x, LO, HI), np.clip(y, 0, YTOP)


def cov(x, y):
    h, _, _ = np.histogram2d(x, y, bins=(6, 9), range=((T.X0, T.X1), (0, 0.45)))
    return float(h.std() / h.mean())


def frac(box, x, y):
    return float(np.mean((x >= box[0]) & (x <= box[1]) & (y >= box[2]) & (y <= box[3])))


def run(lib, means, sched, x, y, ws, T_end, seed, box=None, feedback=False):
    """sched(t) -> mode, or feedback controller. Returns time series."""
    rng = np.random.default_rng(seed)
    m0 = sched(0.0) if not feedback else 'C'
    P = Plant(lib, m0, rng); Mdl = LagModel(means, m0)
    out = dict(t=[], cov=[], frac=[], mode=[])
    t, mode = 0.0, m0
    nsteps = int(round(T_end / DT))
    for k in range(nsteps):
        if k % 10 == 0:   # decision every 0.5 s
            if feedback:
                best = None
                sub = slice(0, None, max(1, len(x) // 400))
                for m in 'LCR':
                    M2 = LagModel(means, mode); M2.F = Mdl.F
                    xs, ys = x[sub], y[sub]
                    for _ in range(30):
                        M2.step(m, DT)
                        xs, ys = move(xs, ys, M2.F[0], M2.F[1], ws, DT)
                    f = frac(box, xs, ys) + 0.002 * (m == mode)
                    if best is None or f > best[0]:
                        best = (f, m)
                mode = best[1]
            else:
                mode = sched(t)
            P.switch(mode)
            out['t'].append(round(t, 2)); out['cov'].append(round(cov(x, y), 3))
            out['frac'].append(round(frac(box, x, y), 4) if box else None); out['mode'].append(mode)
        u, v = P.field()
        x, y = move(x, y, u, v, ws, DT, rng)
        P.tick(DT); Mdl.step(mode, DT); t += DT
    return out


def periodic(seq, half):
    return lambda t: seq[int(t / half) % len(seq)]


def main():
    runs = sys.argv[1]
    lib = {m: load_mode(runs, r) for m, r in MODES.items()}
    means = dict()
    for m in 'LCR':
        mf = json.load(open(os.path.join(runs, MODES[m], 'traj.json')))['mean_field']
        means[m] = (np.array(mf['u']), np.array(mf['v']))
    print('snapshots per mode:', {m: len(lib[m][0]) for m in lib})
    res = dict()
    N, seeds = 4000, (1, 2, 3)
    rng = np.random.default_rng(0)

    # ---------- A: mixing of a neutral blob
    print('\n== A  mixing: blob r=2 cm at (-10, 5) cm, w_s = 0; CoV of counts on 6x9 boxes (0.12 = fully mixed noise)')
    r = 0.02 * np.sqrt(rng.uniform(0, 1, N)); th = rng.uniform(0, 2 * np.pi, N)
    bx, by = -0.10 + r * np.cos(th), 0.05 + r * np.sin(th)
    protos = dict(fixed_L=lambda t: 'L', fixed_C=lambda t: 'C', fixed_R=lambda t: 'R')
    for h in (0.5, 1, 2, 4, 8):
        protos[f'LR_{h:g}s'] = periodic('LR', h)
    protos['LCR_2s'] = periodic('LCR', 2)
    A = dict()
    for name, sch in protos.items():
        rs = [run(lib, means, sch, bx.copy(), by.copy(), 0.0, 40, s) for s in seeds]
        cv = np.mean([o['cov'] for o in rs], axis=0); tt = rs[0]['t']
        tmix = next((tt[i] for i in range(len(cv)) if cv[i] < 0.35), None)
        A[name] = dict(cov_t=cv.round(3).tolist(), t=tt, t_mix=tmix,
            cov10=round(float(cv[tt.index(10.0)]), 3), cov20=round(float(cv[tt.index(20.0)]), 3), cov40=round(float(cv[-1]), 3))
        print(f'  {name:9s} CoV@10s {A[name]["cov10"]:.2f}  @20s {A[name]["cov20"]:.2f}  @40s {A[name]["cov40"]:.2f}  t(CoV<0.35) {tmix}')
    res['mixing'] = A

    # ---------- B: herding from a uniform start
    ux, uy = rng.uniform(LO, HI, N), rng.uniform(0, YTOP, N)
    B = dict()
    for ws in (0.0, 0.01, 0.02):
        for bname, box in BOXES.items():
            area = (box[1] - box[0]) * (box[3] - box[2]) / ((HI - LO) * YTOP)
            row = dict(area_frac=round(area, 3))
            cands = dict(fixed_L=lambda t: 'L', fixed_C=lambda t: 'C', fixed_R=lambda t: 'R',
    LR_2s=periodic('LR', 2), LR_4s=periodic('LR', 4), LC_2s=periodic('LC', 2), RC_2s=periodic('RC', 2))
            for name, sch in cands.items():
                rs = [run(lib, means, sch, ux.copy(), uy.copy(), ws, 30, s, box) for s in seeds]
                f = np.mean([o['frac'] for o in rs], axis=0)
                row[name] = round(float(f[-10:].mean()), 3)   # mean over the last 5 s
            rs = [run(lib, means, None, ux.copy(), uy.copy(), ws, 30, s, box, feedback=True) for s in seeds]
            f = np.mean([o['frac'] for o in rs], axis=0)
            row['feedback'] = round(float(f[-10:].mean()), 3)
            row['feedback_modes'] = ''.join(rs[0]['mode'])
            row['feedback_frac_t'] = f.round(3).tolist()
            best_open = max((k for k in cands), key=lambda k: row[k])
            row['best_open'] = best_open
            B[f'ws{ws:g}_{bname}'] = row
            print(f'  w_s={ws * 100:.0f} cm/s  box={bname:9s} area {area:.3f} | ' +
    ' '.join(f'{k} {row[k]:.3f}' for k in cands) + f' | FEEDBACK {row["feedback"]:.3f}', flush=True)
    res['herding'] = B
    json.dump(res, open(os.path.join(runs, 'swarm_feas.json'), 'w'))


if __name__ == '__main__':
    main()
