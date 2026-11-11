#!/usr/bin/env python3
"""P2 controllability map on recorded mode fields (offline surrogate plant, same as swarm_feas.py).

  phase_map.py <modes.npz> <out.json> [--jobs 30] [--T 40] [--seeds 3]

Grid: settling speed ws x target box. For every cell: fraction in the box (mean of the last 5 s)
under each fixed mode, a set of periodic schedules, and swarm feedback. Reports
  gain_open = best open / area share, gain_fb = feedback / area share, adv = feedback / best open.
Runs locally (no OpenFOAM needed): fields come from dump_modes.py.
"""
import argparse, json, os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np

X0, X1, DXC, NX, NY = -0.15, 0.15, 0.005, 60, 120
LO, HI = X0 + 1e-4, X1 - 1e-4
YTOP = 0.45 - DXC
DT, TAU, DIFF, SNAP = 0.05, 2.0, 2e-4, 0.1
BOXES = {
    'BL': (-0.15, -0.05, 0.0, 0.10), 'BR': (0.05, 0.15, 0.0, 0.10), 'BC': (-0.05, 0.05, 0.0, 0.10),
    'TL': (-0.15, -0.05, 0.35, 0.445), 'TR': (0.05, 0.15, 0.35, 0.445),
    'C': (-0.05, 0.05, 0.15, 0.30), 'WL': (-0.15, -0.10, 0.10, 0.35), 'WR': (0.10, 0.15, 0.10, 0.35),
}
WS = [0.0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04]
F = None


def init(path):
    global F
    z = np.load(path)
    F = {m: dict(u=z[f'{m}_u'], v=z[f'{m}_v'], mu=z[f'{m}_mu'], mv=z[f'{m}_mv']) for m in 'LCR'}


def interp(G, x, y):
    fi = np.clip((x - X0) / DXC - 0.5, 0, NX - 1.000001)
    fj = np.clip(y / DXC - 0.5, 0, NY - 1.000001)
    i = fi.astype(int); j = fj.astype(int); a = fi - i; b = fj - j
    return G[i, j] * (1 - a) * (1 - b) + G[i + 1, j] * a * (1 - b) + G[i, j + 1] * (1 - a) * b + G[i + 1, j + 1] * a * b


def move(x, y, u, v, ws, dt, rng=None):
    def vel(x, y):
        xs = np.clip(x, LO + DXC, HI - DXC); ys = np.maximum(y, DXC)
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


def frac(b, x, y):
    return float(np.mean((x >= b[0]) & (x <= b[1]) & (y >= b[2]) & (y <= b[3])))


def lag(Fh, m, dt):
    a = 1 - np.exp(-dt / TAU)
    return (Fh[0] + a * (F[m]['mu'] - Fh[0]), Fh[1] + a * (F[m]['mv'] - Fh[1]))


def simulate(args):
    ctrl, ws, bname, seed, T_end, N = args
    b = BOXES[bname]
    rng = np.random.default_rng(seed)
    x = rng.uniform(LO, HI, N); y = rng.uniform(0, YTOP, N)
    mode = 'C' if ctrl in ('fb', 'fb2') else (ctrl.split('_')[1][0] if ctrl.startswith('P') else ctrl)
    phase = rng.uniform(0, 15.0); prev, ts = None, 1e9
    Fh = (F['C']['mu'], F['C']['mv'])
    fr = []
    n = int(round(T_end / DT))
    for k in range(n):
        t = k * DT
        if k % 10 == 0:
            if ctrl == 'fb':
                sub = slice(0, None, max(1, N // 400))
                best = None
                for m in 'LCR':
                    G = Fh; xs, ys = x[sub], y[sub]
                    for _ in range(30):
                        G = lag(G, m, DT)
                        xs, ys = move(xs, ys, G[0], G[1], ws, DT)
                    f = frac(b, xs, ys) + 0.002 * (m == mode)
                    if best is None or f > best[0]:
                        best = (f, m)
                new = best[1]
            elif ctrl == 'fb2':
                sub = slice(0, None, max(1, N // 300))
                best = None
                for m1 in 'LCR':
                    G1 = Fh; x1, y1 = x[sub], y[sub]
                    for _ in range(20):
                        G1 = lag(G1, m1, DT)
                        x1, y1 = move(x1, y1, G1[0], G1[1], ws, DT)
                    for m2 in 'LCR':
                        G = G1; xs, ys = x1, y1; acc = 0.0
                        for q in range(40):
                            G = lag(G, m2, DT)
                            xs, ys = move(xs, ys, G[0], G[1], ws, DT)
                            if q >= 20:
                                acc += frac(b, xs, ys) / 20
                        f = acc + 0.002 * (m1 == mode)
                        if best is None or f > best[0]:
                            best = (f, m1)
                new = best[1]
            elif ctrl.startswith('P'):
                seq, half = ctrl.split('_')[1], float(ctrl.split('_')[2])
                new = seq[int(t / half + 1e-9) % len(seq)]
            else:
                new = ctrl
            if new != mode:
                prev = cur_field(mode, phase, prev, ts)
                mode, ts, phase = new, 0.0, rng.uniform(0, 15.0)
            fr.append(frac(b, x, y))
        u, v = cur_field(mode, phase, prev, ts)
        x, y = move(x, y, u, v, ws, DT, rng)
        Fh = lag(Fh, mode, DT)
        phase += DT; ts += DT
    return float(np.mean(fr[-10:]))


def cur_field(mode, phase, prev, ts):
    k = int(phase / SNAP) % F[mode]['u'].shape[0]
    u, v = F[mode]['u'][k], F[mode]['v'][k]
    if prev is not None and ts < 6 * TAU:
        w = np.exp(-ts / TAU)
        return w * prev[0] + (1 - w) * u, w * prev[1] + (1 - w) * v
    return u, v


CTRLS = ['fb', 'fb2']
OPEN = ['L', 'C', 'R'] + [f'P_{s}_{h:g}' for s in ('LR', 'LC', 'RC', 'LCR') for h in (1, 2, 4)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('npz'); ap.add_argument('out')
    ap.add_argument('--jobs', type=int, default=30); ap.add_argument('--T', type=float, default=40)
    ap.add_argument('--seeds', type=int, default=3); ap.add_argument('--N', type=int, default=3000)
    a = ap.parse_args()
    tasks = [(c, ws, bn, s, a.T, a.N) for ws in WS for bn in BOXES for c in OPEN + CTRLS for s in range(a.seeds)]
    print(len(tasks), 'simulations', flush=True)
    with ProcessPoolExecutor(a.jobs, initializer=init, initargs=(a.npz,)) as ex:
        res = list(ex.map(simulate, tasks, chunksize=4))
    raw = dict()
    for (c, ws, bn, s, _, _), f in zip(tasks, res):
        raw.setdefault(f'{ws:g}|{bn}', dict()).setdefault(c, []).append(f)
    table = []
    for key, d in raw.items():
        ws, bn = key.split('|')
        b = BOXES[bn]
        area = (b[1] - b[0]) * (b[3] - b[2]) / ((HI - LO) * YTOP)
        m = {c: float(np.mean(v)) for c, v in d.items()}
        sd = {c: float(np.std(v)) for c, v in d.items()}
        best_open = max(OPEN, key=lambda c: m[c])
        table.append(dict(ws=float(ws), box=bn, area=round(area, 4), fb=round(m['fb'], 4), fb_sd=round(sd['fb'], 4),
            fb2=round(m['fb2'], 4), fb2_sd=round(sd['fb2'], 4), gain_fb2=round(m['fb2'] / area, 3),
            best_open=best_open, open=round(m[best_open], 4), open_sd=round(sd[best_open], 4),
            gain_fb=round(m['fb'] / area, 3), gain_open=round(m[best_open] / area, 3),
            adv=round(m['fb'] / max(m[best_open], 1e-6), 3), all={c: round(v, 4) for c, v in m.items()}))
    json.dump(dict(ws=WS, boxes=BOXES, T=a.T, seeds=a.seeds, N=a.N, table=table), open(a.out, 'w'), indent=1)
    print('box  ' + ' '.join(f'{w * 100:5.1f}' for w in WS) + '   (feedback / area | best open / area)')
    for bn in BOXES:
        row = [next(r for r in table if r['box'] == bn and abs(r['ws'] - w) < 1e-9) for w in WS]
        print(f'{bn:3s} fb ' + ' '.join(f'{r["gain_fb"]:5.2f}' for r in row))
        print(f'    f2 ' + ' '.join(f'{r["gain_fb2"]:5.2f}' for r in row))
        print(f'    op ' + ' '.join(f'{r["gain_open"]:5.2f}' for r in row))


if __name__ == '__main__':
    main()
