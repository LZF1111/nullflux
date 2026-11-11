#!/usr/bin/env python3
"""verify 阶段：从 twoPhaseEulerFoam 稳态后的 U.water 快照积分中性浮力示踪粒子轨迹。

对 n_inject 个注入时刻各积分一条 RK4 轨迹，在 y-checkpoints 上统计 x 均值±σ。
输出 trajectory_stats.json（cfd_trial.js 读 metrics.json；这里同时写一份给 rsi.py）。
"""
import json, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np
import zone_eval as ZE

C = ZE.CONTRACT
G = C['geometry']
PP = C['particle']
TH = C['thresholds']
RUN = C['run']

# Mesh params (must match blockMeshDict)
NX, NY, NZ = G['nx_per_zone'] * G['n_zones'], G['ny'], G['nz']  # 60 x 100 x 1
NXB = G['nx_per_zone']  # 20 cells per zone in x
W, H, D = G['W_m'], G['H_m'], G['D_m']
DX, DY = W / NX, H / NY


def cell_centre(n):
    """Cell index -> (x, y) for 3-block structured mesh (blockMesh ordering: ix fastest)."""
    blk = n // (NXB * NY * NZ)
    m = n % (NXB * NY * NZ)
    ix = m % NXB
    iy = (m // NXB) % NY
    x = G['zone_edges_m'][blk] + (ix + 0.5) * DX
    y = (iy + 0.5) * DY
    return x, y


def parse_vector_field(path):
    """Parse OpenFOAM internalField for a vector field (ASCII). Returns [(ux,uy,uz), ...]."""
    text = open(path).read()
    m = re.search(r'internalField\s+nonuniform\s+List<vector>\s*\n\s*\d+\s*\n\s*\((.*?)\)', text, re.DOTALL)
    if m:
        raw = re.findall(r'\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)', m.group(1))
        return [(float(a), float(b), float(c)) for a, b, c in raw]
    m = re.search(r'internalField\s+uniform\s+\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)', text)
    if m:
        v = (float(m.group(1)), float(m.group(2)), float(m.group(3)))
        return [v] * (NX * NY * NZ)
    raise ValueError(f'Cannot parse vector field: {path}')


def find_time_dirs(case, t_min, t_max):
    ts = []
    for entry in os.listdir(case):
        try:
            t = float(entry)
            if t_min - 1e-6 <= t <= t_max + 1e-6:
                ts.append(entry)
        except ValueError:
            pass
    return sorted(ts, key=float)


def load_snapshot(case, t_dir):
    """Load U.water from a time directory, return (NX, NY) arrays for ux, uy."""
    upath = os.path.join(case, t_dir, 'U.water')
    vecs = parse_vector_field(upath)
    gux = np.zeros((NX, NY))
    guy = np.zeros((NX, NY))
    for n, v in enumerate(vecs):
        x, y = cell_centre(n)
        ix = int(round((x + W / 2) / DX - 0.5))
        iy = int(round(y / DY - 0.5))
        ix = max(0, min(NX - 1, ix))
        iy = max(0, min(NY - 1, iy))
        gux[ix, iy] = v[0]
        guy[ix, iy] = v[1]
    return gux, guy


def interp(gux, guy, x, y):
    """Bilinear interpolation of (ux, uy) at physical (x, y)."""
    fi = (x + W / 2) / DX - 0.5
    fj = y / DY - 0.5
    fi = max(0.0, min(NX - 1.001, fi))
    fj = max(0.0, min(NY - 1.001, fj))
    i0, j0 = int(fi), int(fj)
    tx, ty = fi - i0, fj - j0
    ux = ((1 - tx) * (1 - ty) * gux[i0, j0] + tx * (1 - ty) * gux[i0 + 1, j0] +
          (1 - tx) * ty * gux[i0, j0 + 1] + tx * ty * gux[i0 + 1, j0 + 1])
    uy = ((1 - tx) * (1 - ty) * guy[i0, j0] + tx * (1 - ty) * guy[i0 + 1, j0] +
          (1 - tx) * ty * guy[i0, j0 + 1] + tx * ty * guy[i0 + 1, j0 + 1])
    return ux, uy


def integrate(snapshots, t_inject, dt=0.05):
    """RK4 integration of neutrally buoyant particle from injection point.
    snapshots: [(t_float, gux, guy), ...] sorted by t.
    Returns [(t, x, y), ...] path.
    """
    x0, y0 = PP['injection_xyz_m'][0], PP['injection_xyz_m'][1]
    track = PP['track_duration_s']
    snap_ts = [s[0] for s in snapshots]

    def grid_at(t):
        if t <= snap_ts[0]:
            return snapshots[0][1], snapshots[0][2]
        if t >= snap_ts[-1]:
            return snapshots[-1][1], snapshots[-1][2]
        for k in range(len(snap_ts) - 1):
            if snap_ts[k] <= t <= snap_ts[k + 1]:
                a = (t - snap_ts[k]) / (snap_ts[k + 1] - snap_ts[k])
                return ((1 - a) * snapshots[k][1] + a * snapshots[k + 1][1],
                        (1 - a) * snapshots[k][2] + a * snapshots[k + 1][2])
        return snapshots[-1][1], snapshots[-1][2]

    path = [(t_inject, x0, y0)]
    x, y, t = x0, y0, t_inject
    while t - t_inject < track:
        gux, guy = grid_at(t)

        def vel(xx, yy):
            if yy < 0 or yy > H or abs(xx) > W / 2:
                return 0.0, 0.0
            return interp(gux, guy, xx, yy)

        k1x, k1y = vel(x, y)
        k2x, k2y = vel(x + 0.5 * dt * k1x, y + 0.5 * dt * k1y)
        k3x, k3y = vel(x + 0.5 * dt * k2x, y + 0.5 * dt * k2y)
        k4x, k4y = vel(x + dt * k3x, y + dt * k3y)
        x += dt * (k1x + 2 * k2x + 2 * k3x + k4x) / 6
        y += dt * (k1y + 2 * k2y + 2 * k3y + k4y) / 6
        t += dt
        x = max(-W / 2, min(W / 2, x))
        path.append((t, x, y))
        if y >= H * 0.95 or y < 0:
            break
    return path


def x_at_y(path, y_target):
    for k in range(len(path) - 1):
        _, _, y0 = path[k]
        _, _, y1 = path[k + 1]
        if y0 <= y_target <= y1:
            _, x0, _ = path[k]
            _, x1, _ = path[k + 1]
            a = (y_target - y0) / (y1 - y0 + 1e-12)
            return x0 + a * (x1 - x0)
    return None


def main():
    case = os.environ.get('CASE_DIR', '.')
    t_settle = TH['settle_s']
    t_end = t_settle + TH['track_s']

    t_dirs = find_time_dirs(case, t_settle, t_end + 1.0)
    if len(t_dirs) < 5:
        sys.exit(f'Only {len(t_dirs)} time dirs in [{t_settle},{t_end}] - need >= 5')

    print(f'Loading {len(t_dirs)} U.water snapshots...')
    snapshots = []
    for td in t_dirs:
        try:
            gux, guy = load_snapshot(case, td)
            snapshots.append((float(td), gux, guy))
        except Exception as e:
            print(f'  skip {td}: {e}', file=sys.stderr)

    if len(snapshots) < 5:
        sys.exit(f'Only {len(snapshots)} valid snapshots')

    snap_ts = [s[0] for s in snapshots]
    t_first, t_last = snap_ts[0], snap_ts[-1]
    dt_inj = PP['inject_dt_s']
    inj_times = [t_first + i * dt_inj for i in range(PP['n_inject'])
                 if t_first + i * dt_inj <= t_last - 1.0]
    if len(inj_times) < TH['n_inject_min']:
        sys.exit(f'Only {len(inj_times)} injection times - need >= {TH["n_inject_min"]}')

    print(f'Integrating {len(inj_times)} particle trajectories...')
    paths = [integrate(snapshots, ti) for ti in inj_times]
    escaped = sum(1 for p in paths if p[-1][2] >= H * 0.95)
    escape_pct = 100.0 * escaped / len(paths)

    checkpoints = C['targets']['uniform']['y_m']
    stats = []
    for ycp in checkpoints:
        xs = [x_at_y(p, ycp) for p in paths]
        xs = [v for v in xs if v is not None]
        if len(xs) < 3:
            stats.append(dict(y_m=ycp, n_valid=len(xs), x_mean=None, x_std=None))
        else:
            mu = sum(xs) / len(xs)
            sd = math.sqrt(sum((v - mu) ** 2 for v in xs) / len(xs))
            stats.append(dict(y_m=ycp, n_valid=len(xs), x_mean=round(mu, 5), x_std=round(sd, 5)))

    zp = json.load(open('zone_params.json')) if os.path.exists('zone_params.json') else {}

    out = dict(
        passed=all(s['x_mean'] is not None for s in stats) and escape_pct <= TH['escape_max_pct'],
        value=stats[1]['x_mean'] if len(stats) > 1 and stats[1]['x_mean'] is not None else 0.0,
        n_inject=len(inj_times),
        escape_pct=round(escape_pct, 1),
        n_snapshots=len(snapshots),
        trajectory_stats=stats,
        zone_params=zp,
    )
    json.dump(out, open('trajectory_stats.json', 'w'), indent=1)
    # cfd_trial.js looks for metrics.json
    metrics = {k: out[k] for k in ('value', 'n_inject', 'escape_pct', 'n_snapshots')}
    metrics['trajectory_stats'] = out['trajectory_stats']
    json.dump(metrics, open(os.environ.get('CFD_METRICS_PATH', 'metrics.json'), 'w'), indent=1)
    print(json.dumps(out))


if __name__ == '__main__':
    main()
