#!/usr/bin/env python3
"""Autopilot v2: model-predictive mode selection for arbitrary gate sequences.

  autopilot2.py <out_case> <base_run> --task fig8 [--modes 3|6] [--ctrl mpc|open] [--T 40]

Plant: the live twoPhaseEulerFoam case, restarted from <base_run>/20 and advanced in 0.5 s chunks.
Measurement: tracer position only (what a camera gives).
Internal model (sim2real friendly, no field measurement):
  field estimate  F_hat <- F_hat + dt/tau * (F_mode - F_hat)   (first-order lag, tau from the
    step-response run), F_mode = time-mean liquid field of the static run for that mode
  every 0.5 s:    for each 2-segment mode plan (first 1 s, then 2 s) integrate the tracer from the
    measured position through the predicted field; cost = distance of the predicted
    path to the current target gate (0 inside) + 0.05 m/s * time to enter + small
    switching penalty; apply the first mode of the best plan.
Task: gates are rectangles [x0, x1, y0, y1], passed in order and cycled.
--ctrl open replays a fixed periodic schedule (task['open']) with no feedback.
Output: <out_case>/autopilot.json, same layout as closed_loop.py plus 'gates' and 'task'.
"""
import argparse, json, os, shutil, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import traj as T
import case_runner as CR
import closed_loop as CL

RUNS = os.path.expanduser('~/bubble_col/runs')
TAU, H1, H2, PDT = 1.5, 1.0, 2.0, 0.05
UG = CR.UG

TASKS = {
    # figure eight: up the left wall, through the centre column, up the right wall, centre again
    'fig8': dict(gates=[[-0.15, -0.07, 0.33, 0.45], [-0.03, 0.03, 0.15, 0.30],
          [0.07, 0.15, 0.33, 0.45], [-0.03, 0.03, 0.15, 0.30]],
          names=['左上', '中柱', '右上', '中柱'],
   open=['L'] * 6 + ['C'] * 6 + ['R'] * 6 + ['C'] * 6, map=['L', 'C', 'R', 'C']),
    # mid-height zigzag: cross the column sideways at 15-30 cm, alternately at the left and right walls
    'zz': dict(gates=[[-0.15, -0.08, 0.15, 0.30], [0.08, 0.15, 0.15, 0.30]], names=['左中', '右中'],
        open=['L'] * 6 + ['R'] * 6),
    # triangle: left-top -> right-bottom -> centre column -> ...
    'tri': dict(gates=[[-0.15, -0.07, 0.33, 0.45], [0.07, 0.15, 0.0, 0.12], [-0.03, 0.03, 0.15, 0.30]],
        names=['左上', '右下', '中柱'], open=['L'] * 6 + ['R'] * 6 + ['C'] * 6, map=['L', 'L', 'C']),
    'lr': dict(gates=[[-0.17, -0.07, 0.35, 0.45], [0.07, 0.17, 0.35, 0.45]], names=['左门', '右门'],
        open=['L'] * 6 + ['R'] * 6),
}


def modes_def(n):
    if n == 3:
        return {'L': dict(zones=[3, 0, 0], run='L6_600'), 'C': dict(zones=[0, 3, 0], run='L6_060'),
         'R': dict(zones=[0, 0, 3], run='L6_006')}
    m = dict()
    for k in range(6):
        z = [0] * 6; z[k] = 1
        m[f'S{k + 1}'] = dict(zones=z, run=f'Z6_s{k + 1}')
    for k in range(5):
        z = [0] * 6; z[k] = z[k + 1] = 1
        m[f'P{k + 1}{k + 2}'] = dict(zones=z, run=f'Z6_p{k + 1}{k + 2}')
    # task['open'] names L/C/R map onto 6-zone equivalents
    m['L'], m['C'], m['R'] = m['P12'], m['P34'], m['P56']
    return m


def mean_field(run):
    mf = json.load(open(os.path.join(RUNS, run, 'traj.json')))['mean_field']
    return np.array(mf['u']), np.array(mf['v'])


def in_gate(g, x, y):
    return g[0] <= x <= g[1] and g[2] <= y <= g[3]


def gate_dist(g, x, y):
    dx = max(g[0] - x, 0.0, x - g[1]); dy = max(g[2] - y, 0.0, y - g[3])
    return float(np.hypot(dx, dy))


class Predictor:
    def __init__(self, fields, F0):
        self.fields, self.F = fields, F0

    def step_estimate(self, mode, dt):
        a = 1 - np.exp(-dt / TAU)
        Fm = self.fields[mode]
        self.F = (self.F[0] + a * (Fm[0] - self.F[0]), self.F[1] + a * (Fm[1] - self.F[1]))

    def rollout(self, x, y, plan, gate):
        """plan: [(mode, duration)]; returns (cost, t_enter)."""
        F = self.F; t = 0.0; best = gate_dist(gate, x, y)
        lo, hi = T.X0 + T.DX, T.X1 - T.DX
        for mode, dur in plan:
            Fm = self.fields[mode]
            n = int(round(dur / PDT))
            for _ in range(n):
                a = 1 - np.exp(-PDT / TAU)
                F = (F[0] + a * (Fm[0] - F[0]), F[1] + a * (Fm[1] - F[1]))
                xs, ys = min(max(x, lo), hi), max(y, T.DX)
                u, v = T.bilinear(F[0], xs, ys), T.bilinear(F[1], xs, ys)
                x, y = T.reflect(x + PDT * u, y + PDT * v, CL.YTOP)
                t += PDT
                d = gate_dist(gate, x, y)
                if d == 0.0:
                    return 0.05 * t, t
                best = min(best, d)
        return best + 0.05 * (H1 + H2), None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('case'); ap.add_argument('base')
    ap.add_argument('--task', default='fig8'); ap.add_argument('--modes', type=int, default=3)
    ap.add_argument('--ctrl', default='mpc'); ap.add_argument('--T', type=float, default=40.0)
    ap.add_argument('--x0', type=float, default=0.0)
    a = ap.parse_args()
    task, M = TASKS[a.task], modes_def(a.modes)
    names = sorted({k for k in M if k not in ('L', 'C', 'R')} if a.modes == 6 else M)
    fields = {k: mean_field(M[k]['run']) for k in set(names) | {'L', 'C', 'R'}}
    case = a.case
    if os.path.exists(case):
        shutil.rmtree(case)
    os.makedirs(case)
    for d in ('constant', 'system', '0'):
        shutil.copytree(os.path.join(a.base, d), os.path.join(case, d))
    shutil.copytree(os.path.join(a.base, '20'), os.path.join(case, '20'))
    base_params = json.load(open(os.path.join(a.base, 'params.json')))
    base_id = os.path.basename(a.base.rstrip('/'))
    F0 = mean_field(base_id) if os.path.exists(os.path.join(RUNS, base_id, 'traj.json')) else fields[names[0]]
    pred = Predictor(fields, F0)
    gi = T.grid_index(case)

    nz = len(M[names[0]]['zones'])
    cur = [UG] * nz
    bp = [(0.0, cur)]
    t = CL.T_START
    x, y = a.x0, T.PP['injection_xy_m'][1]
    path = [[t, x, y]]
    gi_t, hits, modes, chunks = 0, [], [], []
    prev = None
    out = dict(kind=a.ctrl, task=a.task, gates=task['gates'], gate_names=task['names'],
        base=base_id, model=base_params.get('model'), n_zones=nz, x0=a.x0, chunk_s=CL.CHUNK,
        mode_zones={k: CR.norm_zones(M[k]['zones']) for k in set(names) | {'L', 'C', 'R'}})
    k, esc, last_ev = 0, 0, CL.T_START
    while t < CL.T_START + a.T - 1e-9:
        gate = task['gates'][gi_t]
        w0 = time.time()
        if a.ctrl == 'rule':
            # event-triggered: each gate has its mode; 4 s without progress -> 1 s escape mode
            want = task['map'][gi_t]
            if esc == 0 and t - last_ev >= 4.0 - 1e-9:
                esc, last_ev = 2, t
            if esc > 0:
                mode = 'C' if want != 'C' else ('L' if x > 0 else 'R')
                esc -= 1
            else:
                mode = want
            cost = None
        elif a.ctrl == 'open':
            seq = task['open']; mode = seq[k % len(seq)]
            cost = None
        else:
            best = None
            for m1 in names:
                for m2 in names:
                    c, te = pred.rollout(x, y, [(m1, H1), (m2, H2)], gate)
                    c += 0.002 * (m1 != prev)
                    if best is None or c < best[0]:
                        best = (c, m1, te)
            cost, mode = best[0], best[1]
        plan_s = time.time() - w0
        new = CR.norm_zones(M[mode]['zones'])
        if new != cur:
            bp += [(t, cur), (t + 0.05, new)]
            cur = new
        CR.write_tables(case, bp + [(1000.0, cur)])
        t1 = round(t + CL.CHUNK, 4)
        CR.set_ctrl(case, endTime=f'{t1:g}', writeInterval=f'{CL.WRITE:g}')
        CR.foam(case, 'twoPhaseEulerFoam', 'log.chunk')
        ds = [d for d in CL.time_dirs(case) if t - 1e-6 <= float(d) <= t1 + 1e-6]
        ts = np.array([float(d) for d in ds])
        vel = CL.sampled(T.make_vel(ts, [CL.snapshot(case, d, gi) for d in ds]))
        n0 = len(path)
        _, x, y = CL.advance(vel, t, x, y, t1, path)
        for _ in range(int(round(CL.CHUNK / PDT))):
            pred.step_estimate(mode, PDT)
        t = t1
        hit = None
        for pt, px, py in path[n0:]:
            if in_gate(task['gates'][gi_t], px, py):
                hit = task['names'][gi_t]
                last_ev = t1
                hits.append(dict(t=round(pt - CL.T_START, 2), gate=gi_t, name=hit, x=round(px, 4), y=round(py, 4)))
                gi_t = (gi_t + 1) % len(task['gates'])
                break
        prev = mode
        modes.append(mode)
        chunks.append(dict(t=round(t - CL.T_START, 2), mode=mode, x=round(x, 4), y=round(y, 4), target=gi_t,
            hit=hit, cost=None if cost is None else round(cost, 4), plan_s=round(plan_s, 2),
            wall_s=round(time.time() - w0, 1)))
        print(json.dumps(chunks[-1]), flush=True)
        out.update(modes=modes, chunks=chunks, hits=hits, n_gates=len(hits),
            path=[[round(p[0] - CL.T_START, 3), p[1], p[2]] for p in path])
        json.dump(out, open(os.path.join(case, 'autopilot.json'), 'w'))
        k += 1
    print(f'gates passed: {len(hits)} in {a.T:g} s', flush=True)


if __name__ == '__main__':
    main()
