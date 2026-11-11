#!/usr/bin/env python3
"""Closed-loop "reactor autopilot" demo: the live CFD solver is the plant.

  closed_loop.py <out_case> <base_run> [--replay modes.json] [--T 30]

Starts from the settled state (t = 20 s) of a finished static run (<base_run>, uniform gas),
releases one tracer at the injection point and advances the solver in 0.5 s chunks. After each
chunk the tracer is moved through the new U.water snapshots (RK4), and the controller picks the
gas mode for the next chunk: L = all gas left, R = all gas right, C = all gas centre.

Task: pass the top gates alternately, left, right, left, ... (gate = y >= 0.35 m and
|x - x_gate| < 5 cm, x_gate = -/+12 cm). Closed loop: the mode follows the current target gate and
the target flips when the tracer passes it (event-triggered feedback on the measured position).
--replay: open loop, the mode sequence of an earlier run is replayed chunk by chunk with no
feedback; gates are scored the same way.
Output: <out_case>/autopilot.json (rewritten after every chunk).
"""
import argparse, json, os, re, shutil, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import traj as T
import case_runner as CR

UG3 = 3 * CR.UG
MODES = {'L': [UG3, 0.0, 0.0], 'C': [0.0, UG3, 0.0], 'R': [0.0, 0.0, UG3]}
GATE_Y, GATE_W = 0.35, 0.05
GATE_X = {'L': -0.12, 'R': 0.12}
CHUNK, WRITE, DT = 0.5, 0.1, 0.02
STALL, ESC_CHUNKS = 4.0, 2   # no gate for 4 s -> centre mode for 1 s
T_START = 20.0
YTOP = T.G['H_liq_m'] - T.DX


def time_dirs(case):
    return sorted((d for d in os.listdir(case) if re.fullmatch(r'[0-9.]+', d)), key=float)


def snapshot(case, d, gi):
    ix, iy, cnt = gi
    u = T.read_internal(os.path.join(case, d, 'U.water'), True)
    gu = np.zeros((T.NX, T.NY)); gv = np.zeros((T.NX, T.NY))
    np.add.at(gu, (ix, iy), u[:, 0]); np.add.at(gv, (ix, iy), u[:, 1])
    return gu / cnt, gv / cnt


def sampled(vel):
    lo, hi = T.X0 + T.DX, T.X1 - T.DX
    return lambda t, x, y: vel(t, min(max(x, lo), hi), max(y, T.DX))


def advance(vel, t, x, y, t1, path):
    while t < t1 - 1e-9:
        h = min(DT, t1 - t)
        k1 = vel(t, x, y)
        k2 = vel(t + h / 2, x + h / 2 * k1[0], y + h / 2 * k1[1])
        k3 = vel(t + h / 2, x + h / 2 * k2[0], y + h / 2 * k2[1])
        k4 = vel(t + h, x + h * k3[0], y + h * k3[1])
        x += h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])
        y += h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
        t += h
        x, y = T.reflect(x, y, YTOP)
        path.append([round(t, 3), round(x, 5), round(y, 5)])
    return t, x, y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('case'); ap.add_argument('base')
    ap.add_argument('--replay'); ap.add_argument('--T', type=float, default=30.0)
    ap.add_argument('--x0', type=float, default=0.0)
    a = ap.parse_args()
    case = a.case
    if os.path.exists(case):
        shutil.rmtree(case)
    os.makedirs(case)
    for d in ('constant', 'system', '0'):
        shutil.copytree(os.path.join(a.base, d), os.path.join(case, d))
    shutil.copytree(os.path.join(a.base, f'{T_START:g}'), os.path.join(case, f'{T_START:g}'))
    base_params = json.load(open(os.path.join(a.base, 'params.json')))
    gi = T.grid_index(case)
    replay = json.load(open(a.replay))['modes'] if a.replay else None

    t = T_START
    x, y = a.x0, T.PP['injection_xy_m'][1]
    path = [[t, x, y]]
    target, hits, modes, chunks = 'L', [], [], []
    cur = [CR.UG] * 3
    bp = [(0.0, cur)]
    out = dict(kind='replay' if replay else 'closed', base=os.path.basename(a.base.rstrip('/')),
        model=base_params.get('model'), x0=a.x0, chunk_s=CHUNK, gate=dict(y=GATE_Y, w=GATE_W, x=GATE_X))
    k, last_ev, esc = 0, T_START, 0
    while t < T_START + a.T - 1e-9:
        if replay:
            mode = replay[k] if k < len(replay) else replay[-1]
        else:
            if esc == 0 and t - last_ev >= STALL - 1e-9:
                esc, last_ev = ESC_CHUNKS, t
            mode = 'C' if esc > 0 else target
            esc = max(esc - 1, 0)
        new = MODES[mode]
        if new != cur:
            bp += [(t, cur), (t + 0.05, new)]
            cur = new
        CR.write_tables(case, bp + [(1000.0, cur)])
        t1 = round(t + CHUNK, 4)
        CR.set_ctrl(case, endTime=f'{t1:g}', writeInterval=f'{WRITE:g}')
        w0 = time.time()
        CR.foam(case, 'twoPhaseEulerFoam', 'log.chunk')
        ds = [d for d in time_dirs(case) if t - 1e-6 <= float(d) <= t1 + 1e-6]
        ts = np.array([float(d) for d in ds])
        vel = sampled(T.make_vel(ts, [snapshot(case, d, gi) for d in ds]))
        n0 = len(path)
        t, x, y = advance(vel, t, x, y, t1, path)
        t = t1
        hit = None
        for pt, px, py in path[n0:]:
            if py >= GATE_Y and abs(px - GATE_X[target]) < GATE_W:
                hit = target
                last_ev = t
                hits.append(dict(t=round(pt - T_START, 2), gate=target, x=round(px, 4), y=round(py, 4)))
                target = 'R' if target == 'L' else 'L'
                break
        modes.append(mode)
        chunks.append(dict(t=round(t - T_START, 2), mode=mode, x=round(x, 4), y=round(y, 4),
                    hit=hit, wall_s=round(time.time() - w0, 1)))
        print(json.dumps(chunks[-1]), flush=True)
        out.update(modes=modes, chunks=chunks, hits=hits, n_gates=len(hits),
            path=[[round(p[0] - T_START, 3), p[1], p[2]] for p in path])
        json.dump(out, open(os.path.join(case, 'autopilot.json'), 'w'))
        k += 1
    print(f'gates passed: {len(hits)} in {a.T:g} s', flush=True)


if __name__ == '__main__':
    main()
