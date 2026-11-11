#!/usr/bin/env python3
"""Swarm herding with the live CFD solver as the plant.

  swarm_live.py <out_case> <base_run> --ctrl feedback|LR2|L [--ws 0.02] [--box corner] [--T 30]

Restarts the solver from <base_run>/20 (settled, uniform gas) and advances it in 0.5 s chunks.
N particles start uniformly in the liquid; v_p = u_l(x, t) + (0, -ws) + random walk (D), with
u_l interpolated in space and time from the 0.1 s snapshots of the chunk just solved.
Controllers (decision every 0.5 s, modes L/C/R = all gas to one zone):
  feedback  measure all particle positions, predict 1.5 s ahead for each mode on the controller
            model (time-mean field per mode from the static runs + first-order lag, no
     fluctuations), apply the mode that puts the most particles in the target box
  LR2       open loop, L/R alternating every 2 s (best periodic schedule in swarm_feas.py)
  L         open loop, fixed all-left
Output: <out_case>/swarm.json (rewritten after every chunk): per-chunk mode and fraction in the
box, particle snapshots every 0.5 s (subsampled) for figures and video.
"""
import argparse, json, os, shutil, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import traj as T
import case_runner as CR
import closed_loop as CL
import swarm_feas as SF

RUNS = os.path.expanduser('~/bubble_col/runs')
UG3 = 3 * CR.UG
MODE_Z = dict(L=[UG3, 0.0, 0.0], C=[0.0, UG3, 0.0], R=[0.0, 0.0, UG3])
DT = SF.DT


def ctrl_model(mode):
    means = dict()
    for m, rid in SF.MODES.items():
        mf = json.load(open(os.path.join(RUNS, rid, 'traj.json')))['mean_field']
        means[m] = (np.array(mf['u']), np.array(mf['v']))
    return means, SF.LagModel(means, mode)


def choose(means, mdl, mode, x, y, ws, box):
    sub = slice(0, None, max(1, len(x) // 400))
    best = None
    for m in 'LCR':
        M2 = SF.LagModel(means, mode)
        M2.F = mdl.F
        xs, ys = x[sub], y[sub]
        for _ in range(30):
            M2.step(m, DT)
            xs, ys = SF.move(xs, ys, M2.F[0], M2.F[1], ws, DT)
        f = SF.frac(box, xs, ys) + 0.002 * (m == mode)
        if best is None or f > best[0]:
            best = (f, m)
    return best[1], round(best[0], 4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('case'); ap.add_argument('base')
    ap.add_argument('--ctrl', default='feedback'); ap.add_argument('--ws', type=float, default=0.02)
    ap.add_argument('--box', default='corner'); ap.add_argument('--T', type=float, default=30.0)
    ap.add_argument('--N', type=int, default=2000); ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--t0', type=float, default=20.0)   # restart time in the base run: flow phase
    a = ap.parse_args()
    box = SF.BOXES[a.box]
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
    x = rng.uniform(SF.LO, SF.HI, a.N)
    y = rng.uniform(0.0, SF.YTOP, a.N)
    means, mdl = ctrl_model('C')

    t, mode = a.t0, None
    cur = [CR.UG] * 3
    bp = [(0.0, cur)]
    chunks, snaps = [], []
    out = dict(ctrl=a.ctrl, t0=a.t0, ws=a.ws, box=box, box_name=a.box, N=a.N, seed=a.seed,
        base=os.path.basename(a.base.rstrip('/')), model=base_params.get('model'),
        area_frac=round((box[1] - box[0]) * (box[3] - box[2]) / ((SF.HI - SF.LO) * SF.YTOP), 4))
    k = 0
    while t < a.t0 + a.T - 1e-9:
        tr = t - a.t0
        pred = None
        if a.ctrl == 'feedback':
            mode, pred = choose(means, mdl, mode or 'C', x, y, a.ws, box)
        elif a.ctrl == 'LR2':
            mode = 'LR'[int(tr / 2.0 + 1e-9) % 2]
        elif a.ctrl.startswith('P_'):   # periodic, e.g. P_LCR_1 = L, C, R for 1 s each
            seq, half = a.ctrl.split('_')[1], float(a.ctrl.split('_')[2])
            mode = seq[int(tr / half + 1e-9) % len(seq)]
        else:
            mode = a.ctrl
        snaps.append(dict(t=round(tr, 2), mode=mode, x=np.round(x[::4], 4).tolist(), y=np.round(y[::4], 4).tolist()))
        new = MODE_Z[mode]
        if new != cur:
            bp += [(t, cur), (t + 0.05, new)]
            cur = new
        CR.write_tables(case, bp + [(1000.0, cur)])
        t1 = round(t + CL.CHUNK, 4)
        CR.set_ctrl(case, endTime=f'{t1:g}', writeInterval=f'{CL.WRITE:g}')
        w0 = time.time()
        CR.foam(case, 'twoPhaseEulerFoam', 'log.chunk')
        ds = [d for d in CL.time_dirs(case) if t - 1e-6 <= float(d) <= t1 + 1e-6]
        ts = np.array([float(d) for d in ds])
        G = [CL.snapshot(case, d, gi) for d in ds]
        tt = t
        while tt < t1 - 1e-9:
            j = int(np.clip(np.searchsorted(ts, tt + 0.5 * DT) - 1, 0, len(ts) - 2))
            w = float(np.clip((tt + 0.5 * DT - ts[j]) / (ts[j + 1] - ts[j]), 0, 1))
            u = (1 - w) * G[j][0] + w * G[j + 1][0]
            v = (1 - w) * G[j][1] + w * G[j + 1][1]
            x, y = SF.move(x, y, u, v, a.ws, DT, rng)
            mdl.step(mode, DT)
            tt += DT
        t = t1
        f = SF.frac(box, x, y)
        chunks.append(dict(t=round(t - a.t0, 2), mode=mode, frac=round(f, 4), pred=pred,
                    wall_s=round(time.time() - w0, 1)))
        print(json.dumps(chunks[-1]), flush=True)
        out.update(chunks=chunks, snaps=snaps, final_frac=round(float(np.mean([c['frac'] for c in chunks[-10:]])), 4))
        json.dump(out, open(os.path.join(case, 'swarm.json'), 'w'))
        k += 1
    snaps.append(dict(t=round(t - a.t0, 2), mode=mode, x=np.round(x[::4], 4).tolist(), y=np.round(y[::4], 4).tolist()))
    out.update(snaps=snaps)
    json.dump(out, open(os.path.join(case, 'swarm.json'), 'w'))
    print('final fraction in box (last 5 s):', out['final_frac'], 'area', out['area_frac'], flush=True)


if __name__ == '__main__':
    main()
