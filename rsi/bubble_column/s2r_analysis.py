#!/usr/bin/env python3
"""Sim2real checks on finished runs (run on the server).

  s2r_analysis.py <runs_dir>  ->  <runs_dir>/s2r.json + printed summary

1. Model sensitivity: for each base config, x at checkpoints under the baseline model vs
   M<variant>_<id> runs (lift / turbulent dispersion / bubble size). The control map is
   "model-robust" where the sign and wall-attachment of x survive every variant.
2. 3D walls: W3D_<id> vs <id> (2D, empty front/back).
3. Step response (S_step): lateral liquid velocity in the lower half vs time after each switch;
   time to reach 63 % / 90 % of the new level, and x at y = 0.3 m of tracers released at each time.
"""
import json, os, re, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import traj as T


def stats(runs, rid):
    f = os.path.join(runs, rid, 'traj.json')
    if not os.path.exists(f):
        return None
    return json.load(open(f))['stats']


def xs(st):
    return [None if s['x_mean'] is None else round(s['x_mean'] * 100, 1) for s in st]


def sensitivity(runs):
    out = {}
    bases = sorted({m.group(1) for d in os.listdir(runs) for m in [re.match(r'M\w+?_(L6_\d+)$', d)] if m})
    for b in bases:
        row = {'base': xs(stats(runs, b)) if stats(runs, b) else None}
        for d in sorted(os.listdir(runs)):
            m = re.match(rf'(M\w+?)_{b}$', d)
            if m and stats(runs, d):
                row[m.group(1)] = xs(stats(runs, d))
        out[b] = row
    return out


def walls3d(runs):
    out = {}
    for d in sorted(os.listdir(runs)):
        m = re.match(r'W3D_(L6_\d+)$', d)
        if m and stats(runs, d):
            out[m.group(1)] = {'2D': xs(stats(runs, m.group(1))), '3D_walls': xs(stats(runs, d))}
    return out


def step(runs):
    case = os.path.join(runs, 'S_step')
    if not os.path.exists(os.path.join(case, 'result.json')):
        return None
    p = json.load(open(os.path.join(case, 'params.json')))
    gi = T.grid_index(case)
    ts, U, surf = T.load_series(case, *gi)
    # lateral liquid velocity averaged over the lower half (x-momentum of the bottom recirculation)
    j1 = int(0.05 / T.DX); j2 = int(0.25 / T.DX)
    ul = np.array([u[0][:, j1:j2].mean() for u in U])
    # plume position: x of max upward velocity at y = 0.2 m
    j = int(0.2 / T.DX)
    xc = T.X0 + (np.arange(T.NX) + 0.5) * T.DX
    xp = np.array([xc[int(np.argmax(u[1][:, j]))] for u in U])
    sw = [float(e['t']) for e in p['schedule']]
    resp = []
    for k, t0 in enumerate(sw):
        t1 = sw[k + 1] if k + 1 < len(sw) else ts[-1]
        m = (ts >= t0) & (ts <= t1)
        tt, xx = ts[m] - t0, xp[m]
        x0, xe = xx[0], np.median(xx[-max(3, len(xx) // 4):])
        dx = xe - x0
        def t_at(frac):
            if abs(dx) < 0.01:
                return None
            hit = np.where((xx - x0) / dx >= frac)[0]
            return round(float(tt[hit[0]]), 2) if len(hit) else None
        resp.append(dict(t_switch=t0, plume_x_before=round(float(x0), 3), plume_x_after=round(float(xe), 3),
            t63_s=t_at(0.63), t90_s=t_at(0.9)))
    # tracers released every 0.25 s through the whole window
    vel = T.make_vel(ts, U)
    rel = np.arange(ts[0], ts[-1] - 2.0, 0.25)
    x03 = []
    for t0 in rel:
        c = T.crossings(T.track(vel, ts, surf, t0, T.PP['dt_s']))
        x03.append(None if c[2] is None else round(c[2][0], 4))
    return dict(switches=resp, t=ts.round(2).tolist(), plume_x=xp.round(3).tolist(),
        u_lower=ul.round(4).tolist(), release_t=rel.round(2).tolist(), x_at_0p3=x03)


def main():
    runs = sys.argv[1]
    res = dict(sensitivity=sensitivity(runs), walls3d=walls3d(runs), step=step(runs))
    json.dump(res, open(os.path.join(runs, 's2r.json'), 'w'))
    print('== model sensitivity: x [cm] at y = 0.1/0.2/0.3/0.4 m')
    for b, row in res['sensitivity'].items():
        for k, v in row.items():
            print(f'  {b:7s} {k:6s} {v}')
    print('== 3D front/back walls')
    for b, row in res['walls3d'].items():
        print(f'  {b:7s} 2D {row["2D"]}   3D {row["3D_walls"]}')
    if res['step']:
        print('== step response (plume x at y = 0.2 m)')
        for r in res['step']['switches']:
            print('  ', r)


if __name__ == '__main__':
    main()
