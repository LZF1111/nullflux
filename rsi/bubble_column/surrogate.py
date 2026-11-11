#!/usr/bin/env python3
"""Forward models and inverse solvers for the bubble-column trajectory-control paper.

Data: runs/dataset.json from batch.py collect (one entry per static run: params.zones, stats,
mean_field). Zone configs are points on the simplex f = Ug_i / sum(Ug), sum f = 1.

Forward models
  A. stats GPR      f -> x_mean at the checkpoints (fit to the tracer statistics of each run)
  B. field library  f -> mean liquid field, linear interpolation on the simplex lattice;
      a tracer path for ANY time-varying schedule is integrated through the field
      of the active config (quasi-steady), so dynamic schedules can be predicted.

Inverse problems
  static   target path -> best constant f        (on model A, checked with model B)
  dynamic  target path -> piecewise-constant schedule [(t_k, f_k)] (on model B)

  surrogate.py fit       --data dataset.json
  surrogate.py inverse   --data dataset.json --target left_drift
  surrogate.py dynamic   --data dataset.json --target zigzag [--segments 4]
  surrogate.py reach     --data dataset.json reachable set of (x@y2, x@y4) for static configs
Outputs go next to the dataset file.
"""
import argparse, json, math, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
C = json.load(open(os.path.join(HERE, 'contract.json'), encoding='utf-8'))
TARGETS = {k: v for k, v in C['targets'].items() if k != 'note'}
Y_CPS = np.array(C['targets']['center']['y_m'])
PP = C['particle']


# ---------------------------------------------------------------- data

def load(path):
    D = json.load(open(path))
    F, Y, fields = [], [], []
    for d in D:
        z = np.array(d['params']['zones'], float)
        f = z / z.sum()
        xs = [s['x_mean'] for s in d['stats']]
        F.append(f)
        Y.append([np.nan if v is None else v for v in xs])
        mf = d['mean_field']
        fields.append((np.array(mf['u']), np.array(mf['v'])))
    geo = D[0]['mean_field']
    return np.array(F), np.array(Y), fields, geo


# ---------------------------------------------------------------- model A: GPR

class GPR:
    def __init__(self, ls, sf, sn):
        self.ls, self.sf, self.sn = ls, sf, sn

    def k(self, A, B):
        d2 = ((A[:, None, :] - B[None, :, :]) ** 2).sum(-1)
        return self.sf ** 2 * np.exp(-0.5 * d2 / self.ls ** 2)

    def fit(self, X, y):
        self.X, self.mu = X, y.mean()
        K = self.k(X, X) + self.sn ** 2 * np.eye(len(X))
        self.Ki = np.linalg.inv(K)
        self.a = self.Ki @ (y - self.mu)
        return self

    def predict(self, Xs):
        Ks = self.k(Xs, self.X)
        m = self.mu + Ks @ self.a
        v = self.sf ** 2 - np.einsum('ij,jk,ik->i', Ks, self.Ki, Ks)
        return m, np.sqrt(np.maximum(v, 0))

    def loo(self, y):
        # closed-form leave-one-out residuals
        return (self.Ki @ (y - self.mu)) / np.diag(self.Ki)


def fit_gprs(F, Y):
    X = F[:, :2]   # f3 = 1 - f1 - f2
    models, report = [], []
    for c in range(Y.shape[1]):
        ok = ~np.isnan(Y[:, c]); y = Y[ok, c]
        best = None
        for ls in (0.1, 0.15, 0.2, 0.3, 0.5):
            for sn in (0.002, 0.005, 0.01):
                g = GPR(ls, max(y.std(), 1e-3), sn).fit(X[ok], y)
                e = float(np.sqrt(np.mean(g.loo(y) ** 2)))
                if best is None or e < best[0]:
                    best = (e, g, ls, sn)
        models.append(best[1])
        report.append(dict(y_m=float(Y_CPS[c]), n=int(ok.sum()), loo_rmse_m=round(best[0], 5),
                ls=best[2], sn=best[3], range_m=[round(float(y.min()), 4), round(float(y.max()), 4)]))
    return models, report


def gpr_path(models, f):
    X = np.atleast_2d(f)[:, :2]
    return np.array([m.predict(X)[0] for m in models]).T   # (n, n_cp)


# ---------------------------------------------------------------- model B: field library

class FieldLibrary:
    """Barycentric interpolation of mean fields on the simplex lattice (i+j+k = n)."""

    def __init__(self, F, fields, geo):
        self.geo = geo
        self.n = int(round(1 / min(v for v in F[:, 0] if v > 1e-9)))
        self.lib = {}
        for f, fld in zip(F, fields):
            key = tuple(int(round(v * self.n)) for v in f)
            self.lib[key] = fld

    def field(self, f):
        n = self.n; p = np.asarray(f) * n
        i, j = int(min(math.floor(p[0]), n - 1)), int(min(math.floor(p[1]), n - 1))
        a, b = p[0] - i, p[1] - j
        if i + j > n - 1:   # outside the lattice triangles
            return self.nearest(f)
        if a + b <= 1:
            nodes = [((i, j), 1 - a - b), ((i + 1, j), a), ((i, j + 1), b)]
        else:
            nodes = [((i + 1, j + 1), a + b - 1), ((i + 1, j), 1 - b), ((i, j + 1), 1 - a)]
        u = v = 0
        for (ii, jj), w in nodes:
            kk = n - ii - jj
            if kk < 0 or (ii, jj, kk) not in self.lib:
                return self.nearest(f)
            u = u + w * self.lib[(ii, jj, kk)][0]
            v = v + w * self.lib[(ii, jj, kk)][1]
        return u, v

    def nearest(self, f):
        key = min(self.lib, key=lambda k: sum((k[q] / self.n - f[q]) ** 2 for q in range(3)))
        return self.lib[key]

    def path(self, schedule, t_end=None):
        """schedule: [(t_start, f)], t from release. Returns (ts, xs, ys)."""
        g = self.geo; dx, x0, nx, ny = g['dx'], g['x0'], g['nx'], g['ny']
        x1, ytop = x0 + nx * dx, C['geometry']['H_liq_m'] - dx
        dt = PP['dt_s']; t_end = t_end or PP['track_duration_s']
        cache = {}

        def bil(G, x, y):
            fi = min(max((x - x0) / dx - 0.5, 0), nx - 1.000001); fj = min(max(y / dx - 0.5, 0), ny - 1.000001)
            i, j = int(fi), int(fj); a, b = fi - i, fj - j
            return G[i, j] * (1 - a) * (1 - b) + G[i + 1, j] * a * (1 - b) + G[i, j + 1] * (1 - a) * b + G[i + 1, j + 1] * a * b

        def vel(t, x, y):
            k = max(q for q, (ts, _) in enumerate(schedule) if ts <= t + 1e-12)
            if k not in cache:
                cache[k] = self.field(schedule[k][1])
            U, V = cache[k]
            return bil(U, x, y), bil(V, x, y)

        x, y = PP['injection_xy_m']; t = 0.0; T, X, Yv = [t], [x], [y]
        while t < t_end and y < Y_CPS[-1]:
            k1 = vel(t, x, y); k2 = vel(t, x + dt / 2 * k1[0], y + dt / 2 * k1[1])
            k3 = vel(t, x + dt / 2 * k2[0], y + dt / 2 * k2[1]); k4 = vel(t, x + dt * k3[0], y + dt * k3[1])
            x += dt / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]); y += dt / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
            t += dt
            x = min(max(x, x0 + 1e-4), x1 - 1e-4); y = min(max(y, 1e-4), ytop)
            T.append(t); X.append(x); Yv.append(y)
        return np.array(T), np.array(X), np.array(Yv)

    def crossings(self, schedule):
        T, X, Yv = self.path(schedule)
        out = []
        for yc in Y_CPS:
            idx = np.where((Yv[:-1] < yc) & (Yv[1:] >= yc))[0]
            if len(idx) == 0:
                out.append(np.nan); continue
            q = idx[0]; f = (yc - Yv[q]) / (Yv[q + 1] - Yv[q])
            out.append(X[q] + f * (X[q + 1] - X[q]))
        return np.array(out)


# ---------------------------------------------------------------- optimisation helpers

def simplex_grid(m=40):
    pts = []
    for i in range(m + 1):
        for j in range(m + 1 - i):
            pts.append((i / m, j / m, (m - i - j) / m))
    return np.array(pts)


def loss(pred, target):
    pred = np.where(np.isnan(pred), 0.3, pred)   # never crossing = large penalty
    return float(np.sqrt(np.mean((pred - target) ** 2)))


def to_zones(f):
    return [round(float(v) * 3 * C['zones']['Ug_total_ms'], 6) for v in f]


# ---------------------------------------------------------------- commands

def cmd_fit(a):
    F, Y, _, _ = load(a.data)
    _, rep = fit_gprs(F, Y)
    out = os.path.join(os.path.dirname(a.data), 'surrogate_fit.json')
    json.dump(dict(n_runs=len(F), checkpoints=rep), open(out, 'w'), indent=1)
    print(json.dumps(rep, indent=1))


def cmd_inverse(a):
    F, Y, fields, geo = load(a.data)
    target = np.array(TARGETS[a.target]['x_m'])
    models, _ = fit_gprs(F, Y)
    lib = FieldLibrary(F, fields, geo)
    G = simplex_grid(60)
    P = gpr_path(models, G)
    L = np.sqrt(np.mean((P - target) ** 2, axis=1))
    order = np.argsort(L)
    # all near-optimal configs (within 20 % of the best): exposes non-uniqueness
    near = [i for i in order if L[i] <= 1.2 * L[order[0]] + 1e-4][:200]
    best = G[order[0]]
    res = dict(target=a.target, target_x=target.tolist(),
        best_f=best.round(4).tolist(), best_zones=to_zones(best),
        gpr_pred_x=P[order[0]].round(5).tolist(), gpr_rmse_m=round(float(L[order[0]]), 5),
        field_pred_x=np.round(lib.crossings([(0.0, best)]), 5).tolist(),
        near_optimal_f=G[near].round(3).tolist(),
        near_optimal_spread=round(float(np.linalg.norm(G[near] - best, axis=1).max()), 3))
    out = os.path.join(os.path.dirname(a.data), f'inverse_{a.target}.json')
    json.dump(res, open(out, 'w'), indent=1)
    print(json.dumps({k: v for k, v in res.items() if k != 'near_optimal_f'}, indent=1))


def cmd_dynamic(a):
    F, _, fields, geo = load(a.data)
    lib = FieldLibrary(F, fields, geo)
    target = np.array(TARGETS[a.target]['x_m'])
    K = a.segments
    rng = np.random.default_rng(0)
    G = simplex_grid(12)

    def unpack(z):
        # z = [t_1..t_{K-1} increments (s), f_k indices] -> schedule
        ts = np.concatenate([[0.0], np.cumsum(np.abs(z[:K - 1]))])
        return [(float(t), G[int(i) % len(G)]) for t, i in zip(ts, z[K - 1:])]

    def obj(z):
        return loss(lib.crossings(unpack(z)), target)

    # static baseline: best constant config on the field model
    stat_l = [loss(lib.crossings([(0.0, g)]), target) for g in G]
    i_stat = int(np.argmin(stat_l))
    stat = (stat_l[i_stat], G[i_stat])

    best = None
    for it in range(a.iters):
        z = np.concatenate([rng.uniform(0.1, 1.5, K - 1), rng.integers(0, len(G), K)])
        if it == 0:   # a schedule that holds the static optimum: dynamic can only improve on it
            z[K - 1:] = i_stat
        e = obj(z)
        # greedy coordinate refinement
        for _ in range(40):
            q = rng.integers(0, 2 * K - 1); z2 = z.copy()
            if q < K - 1:
                z2[q] = max(0.02, z2[q] + rng.normal(0, 0.2))
            else:
                z2[q] = rng.integers(0, len(G))
            e2 = obj(z2)
            if e2 < e:
                z, e = z2, e2
        if best is None or e < best[0]:
            best = (e, z)
    sched = unpack(best[1])
    T, X, Yv = lib.path(sched)
    res = dict(target=a.target, target_x=target.tolist(), segments=K,
        static_best_rmse_m=round(stat[0], 5), static_best_f=stat[1].round(3).tolist(),
        dynamic_rmse_m=round(best[0], 5),
        schedule=[dict(t=round(t, 3), f=f.round(3).tolist(), zones=to_zones(f)) for t, f in sched],
        pred_x=np.round(lib.crossings(sched), 5).tolist(),
        path=np.round(np.c_[T, X, Yv][::5], 4).tolist())
    out = os.path.join(os.path.dirname(a.data), f'dynamic_{a.target}.json')
    json.dump(res, open(out, 'w'), indent=1)
    print(json.dumps({k: v for k, v in res.items() if k != 'path'}, indent=1))


def cmd_reach(a):
    F, Y, fields, geo = load(a.data)
    models, _ = fit_gprs(F, Y)
    G = simplex_grid(60)
    P = gpr_path(models, G)
    res = dict(f=G.round(4).tolist(), x_at_cps=P.round(5).tolist(), y_cps=Y_CPS.tolist(),
        targets={n: dict(best_rmse_m=round(float(np.sqrt(np.mean((P - np.array(t['x_m'])) ** 2, 1)).min()), 5))
    for n, t in TARGETS.items()})
    out = os.path.join(os.path.dirname(a.data), 'reach.json')
    json.dump(res, open(out, 'w'))
    print(json.dumps(res['targets'], indent=1))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    for n in ('fit', 'inverse', 'dynamic', 'reach'):
        p = sp.add_parser(n); p.add_argument('--data', required=True)
        if n in ('inverse', 'dynamic'):
            p.add_argument('--target', required=True, choices=list(TARGETS))
        if n == 'dynamic':
            p.add_argument('--segments', type=int, default=4); p.add_argument('--iters', type=int, default=60)
    a = ap.parse_args()
    globals()['cmd_' + a.cmd](a)


if __name__ == '__main__':
    main()
