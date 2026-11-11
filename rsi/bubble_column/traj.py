#!/usr/bin/env python3
"""Tracer trajectories from a finished bubble-column case.

  traj.py <case_dir>  ->  <case_dir>/traj.json

Neutrally buoyant tracers (St << 1) follow the liquid: dx/dt = U.water(x, t), RK4 with bilinear
interpolation in space and linear interpolation between written times. Tracers reflect at the
side walls, the bottom and the free surface (top of the liquid, from alpha.water).

Releases: from injection_xy_m at t = settle_s + k*inject_dt_s (or params.json "inject_t").
Each tracer is followed until it crosses the top checkpoint or the data ends.
Per checkpoint y_c: x at the first upward crossing, mean / std over tracers, crossing fraction,
mean crossing time.
"""
import json, math, os, re, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
C = json.load(open(os.path.join(HERE, 'contract.json'), encoding='utf-8'))
G, PP, TH = C['geometry'], C['particle'], C['thresholds']
Y_CPS = C['targets']['center']['y_m']
X0, X1 = G['zone_edges_m'][0], G['zone_edges_m'][-1]
DX = G['cell_m']
NX = int(round((X1 - X0) / DX))
NY = int(round(G['H_dom_m'] / DX))


def read_internal(path, vector):
    s = open(path, errors='replace').read()
    m = re.search(r'internalField\s+uniform\s+(\([^)]*\)|\S+);', s)
    if m:
        v = m.group(1)
        val = [float(t) for t in v.strip('()').split()] if vector else float(v)
        return np.tile(val, (NX * NY, 1)) if vector else np.full(NX * NY, val)
    m = re.search(r'internalField\s+nonuniform\s+List<\w+>\s*(\d+)\s*\(', s)
    n, i0 = int(m.group(1)), m.end()
    body = s[i0:s.index('\n)', i0)]
    a = np.array(body.replace('(', ' ').replace(')', ' ').split(), dtype=float)
    return a.reshape(n, 3) if vector else a


def grid_index(case):
    """cell id -> (ix, iy) from written cell centres (robust to blockMesh ordering)."""
    c = read_internal(os.path.join(case, '0', 'C'), True)
    ix = np.clip(np.round((c[:, 0] - X0) / DX - 0.5).astype(int), 0, NX - 1)
    iy = np.clip(np.round(c[:, 1] / DX - 0.5).astype(int), 0, NY - 1)
    cnt = np.zeros((NX, NY)); np.add.at(cnt, (ix, iy), 1)
    if cnt.min() < 1:
        raise ValueError('cell centres do not cover the structured grid')
    return ix, iy, cnt


def load_series(case, ix, iy, cnt):
    t_lo = float(os.environ.get('BC_SETTLE', TH['settle_s'])) - 1e-6
    times = sorted((d for d in os.listdir(case) if re.fullmatch(r'[0-9.eE+-]+', d) and float(d) >= t_lo), key=float)
    U, S = [], []
    for d in times:
        u = read_internal(os.path.join(case, d, 'U.water'), True)
        a = read_internal(os.path.join(case, d, 'alpha.water'), False)
        gu = np.zeros((NX, NY)); gv = np.zeros((NX, NY)); ga = np.zeros((NX, NY))
        np.add.at(gu, (ix, iy), u[:, 0]); np.add.at(gv, (ix, iy), u[:, 1]); np.add.at(ga, (ix, iy), a)
        gu /= cnt; gv /= cnt; ga /= cnt
        U.append((gu, gv))
        col = ga.mean(axis=0)    # liquid fraction per row
        top = np.where(col > 0.5)[0]
        S.append((top.max() + 1) * DX if len(top) else G['H_liq_m'])
    return np.array([float(t) for t in times]), U, np.array(S)


def bilinear(g, x, y):
    fi = min(max((x - X0) / DX - 0.5, 0.0), NX - 1.000001)
    fj = min(max(y / DX - 0.5, 0.0), NY - 1.000001)
    i, j = int(fi), int(fj); a, b = fi - i, fj - j
    return (g[i, j] * (1 - a) * (1 - b) + g[i + 1, j] * a * (1 - b) +
            g[i, j + 1] * (1 - a) * b + g[i + 1, j + 1] * a * b)


def make_vel(ts, U):
    def vel(t, x, y):
        k = int(np.clip(np.searchsorted(ts, t) - 1, 0, len(ts) - 2))
        w = float(np.clip((t - ts[k]) / (ts[k + 1] - ts[k]), 0, 1))
        u = (1 - w) * bilinear(U[k][0], x, y) + w * bilinear(U[k + 1][0], x, y)
        v = (1 - w) * bilinear(U[k][1], x, y) + w * bilinear(U[k + 1][1], x, y)
        return u, v
    return vel


def reflect(x, y, ytop):
    lo, hi = X0 + 1e-4, X1 - 1e-4
    if x < lo: x = 2 * lo - x
    if x > hi: x = 2 * hi - x
    if y < 1e-4: y = 2e-4 - y
    if y > ytop: y = 2 * ytop - y
    return x, y


def track(vel, ts, surf, t0, dt):
    x, y = PP['injection_xy_m']; t = t0
    path = [(t, x, y)]
    while t + dt <= ts[-1]:
        k1 = vel(t, x, y)
        k2 = vel(t + dt / 2, x + dt / 2 * k1[0], y + dt / 2 * k1[1])
        k3 = vel(t + dt / 2, x + dt / 2 * k2[0], y + dt / 2 * k2[1])
        k4 = vel(t + dt, x + dt * k3[0], y + dt * k3[1])
        x += dt / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])
        y += dt / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
        t += dt
        ytop = float(np.interp(t, ts, surf)) - DX
        x, y = reflect(x, y, ytop)
        path.append((t, x, y))
        if y >= Y_CPS[-1] or t - t0 >= PP['track_duration_s']:
            break
    return path


def crossings(path):
    """x and t at the first upward crossing of each checkpoint (None if never)."""
    out = []
    for yc in Y_CPS:
        hit = None
        for (ta, xa, ya), (tb, xb, yb) in zip(path, path[1:]):
            if ya < yc <= yb:
                f = (yc - ya) / (yb - ya)
                hit = (xa + f * (xb - xa), ta + f * (tb - ta)); break
        out.append(hit)
    return out


def main():
    case = sys.argv[1]
    params = json.load(open(os.path.join(case, 'params.json')))
    gi = grid_index(case)
    ts, U, surf = load_series(case, *gi)
    if len(ts) < 10:
        sys.exit(f'only {len(ts)} written times after settle_s')
    vel = make_vel(ts, U)
    t_inj = params.get('inject_t') or [ts[0] + k * PP['inject_dt_s'] for k in range(PP['n_inject'])]
    t_inj = [t for t in t_inj if t < ts[-1] - 1.0]
    paths = [track(vel, ts, surf, t, PP['dt_s']) for t in t_inj]
    cr = [crossings(p) for p in paths]

    stats = []
    for c, yc in enumerate(Y_CPS):
        hits = [r[c] for r in cr if r[c] is not None]
        xs = np.array([h[0] for h in hits]); tt = np.array([h[1] - t for h, t in zip(hits, t_inj)]) if hits else np.array([])
        stats.append(dict(y_m=yc, n_cross=len(hits), frac_cross=round(len(hits) / len(paths), 3),
            x_mean=round(float(xs.mean()), 5) if len(xs) else None,
            x_std=round(float(xs.std()), 5) if len(xs) else None,
            t_mean=round(float(tt.mean()), 3) if len(tt) else None))

    # mean liquid field over the window (used for the mean-flow figure and as a deterministic reference)
    um = np.mean([u[0] for u in U], axis=0); vm = np.mean([u[1] for u in U], axis=0)
    out = dict(id=params.get('id'), params=params, n_times=len(ts), t_window=[float(ts[0]), float(ts[-1])],
        surface_m=[round(float(surf.min()), 4), round(float(surf.max()), 4)],
        n_tracers=len(paths), stats=stats,
        paths=[[[round(t, 3), round(x, 5), round(y, 5)] for t, x, y in p[::5]] for p in paths],
        mean_field=dict(nx=NX, ny=NY, dx=DX, x0=X0,
          u=np.round(um, 5).tolist(), v=np.round(vm, 5).tolist()))
    json.dump(out, open(os.path.join(case, 'traj.json'), 'w'))
    print(json.dumps(dict(n_tracers=len(paths), stats=stats)))


if __name__ == '__main__':
    main()
