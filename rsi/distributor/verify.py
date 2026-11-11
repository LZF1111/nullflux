#!/usr/bin/env python3
"""verify 阶段：独立测量，只写 metrics.json（平面 JSON，全是有限数字）。
与 tools/fig12post.py 同口径：Fig.12b 取 y=0 线（|y|<h/2 一层单元，x 分 20 箱，体积平均，÷两端壁值），
在统计窗内的每个写出时刻上先对场做算术平均。KPI 取 z=1.0 m 截面（speciesZ1，主口径）。
封存量（Fig.12a 平台高度等）也写进 metrics.json，但不进验收规则；rsi.py 不把它们给提议者看。
用法：
  候选目录内（cfd_trial 调用）：verify.py
  对已有算例复核测量口径：verify.py --case DIR --t0 A --t1 B --out FILE.json"""
import argparse, glob, json, math, os, re, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np
import layout_eval as L

C_ = L.CONTRACT
sys.path.insert(0, os.path.dirname(C_['run']['post_field']))
import post_field as PF

R = C_['locked_geometry']['R_M']; RR = C_['locked_geometry']['R_R']
M_IN = 18.0 / 3600
KPI_REF = C_['targets']['kpi_paper_cfd']


def times_in(case, t0, t1):
    rec, dec = PF._times(case)
    ts = sorted(set(rec) | set(dec), key=float)
    return [t for t in ts if t0 - 1e-6 <= float(t) <= t1 + 1e-6]


def mean_field(case, ts, field):
    C = V = None; acc = None
    for t in ts:
        C, V, F, _ = PF.load(case, t, field)
        acc = F.astype(float) if acc is None else acc + F
    return C, V, acc / len(ts)


def vavg(F, V, m):
    w = V[m].sum()
    return float((F[m] * V[m]).sum() / w) if w > 0 else float('nan')


def lines(C, V, F):
    r = np.hypot(C[:, 0], C[:, 1]); z = C[:, 2]; h = np.cbrt(V)
    out = {}
    for Z in ('0.06', '0.1', '0.4'):
        lay = (np.abs(z - float(Z)) < 0.51 * h) & (r < R)
        ln = lay & (np.abs(C[:, 1]) < 0.51 * h)
        xb = np.linspace(-R, R, 21); xs, ys = [], []
        for a, b in zip(xb[:-1], xb[1:]):
            m = ln & (C[:, 0] >= a) & (C[:, 0] < b)
            if m.any(): xs.append(0.5 * (a + b) / R); ys.append(vavg(F, V, m))
        wall = 0.5 * (ys[0] + ys[-1]); yw = [y / wall for y in ys]
        rb = np.linspace(0, R, 10)
        th = [vavg(F, V, lay & (r >= a) & (r < b)) for a, b in zip(rb[:-1], rb[1:])]
        th = [v for v in th if math.isfinite(v)]
        out[Z] = dict(x=xs, y=yw, min=float(min(yw)), xmin=float(xs[int(np.argmin(yw))]),
                      rmse=L.paper_rmse(xs, yw, Z), theta_min=float(min(th) / th[-1]))
    return out


def plateau(C, V, F):
    r = np.hypot(C[:, 0], C[:, 1]); z = C[:, 2]
    zb = np.linspace(-0.05, 1.347, 57); zc = 0.5 * (zb[1:] + zb[:-1])
    c2 = np.array([vavg(F, V, (z >= a) & (z < b) & (r < R)) for a, b in zip(zb[:-1], zb[1:])])
    top = c2[np.argmin(np.abs(zc - 1.0))]
    return float(zc[np.argmax((c2 >= 0.99 * top) & (zc > 0))])


def kpis(case, t0, t1):
    f = os.path.join(case, 'postProcessing', 'speciesZ1', 'speciesZ1.dat')
    a = np.loadtxt(f, comments='#'); a = a[np.argsort(a[:, 0])]
    _, i = np.unique(a[:, 0], return_index=True); a = a[i]
    w = a[(a[:, 0] >= t0) & (a[:, 0] <= t1), 1:9]
    if len(w) < 10: raise ValueError(f'speciesZ1 在窗口内只有 {len(w)} 行')
    m = w.mean(0); hc = m[2:8].sum()
    k = dict(C2H4_C3H6=m[3] / m[4], S_C2C3_pct=100 * (m[3] + m[4]) / hc, eta_MeOH_pct=100 * (1 - m[0] / M_IN))
    dev = {n: 100 * (k[n] / KPI_REF[n] - 1) for n in k}
    return k, dev, len(w)


def leak(case, t):
    C, V, A, _ = PF.load(case, t, 'alpha.particles')
    r = np.hypot(C[:, 0], C[:, 1]); z = C[:, 2]
    plen = (z > -0.06) & (z < 0) & (r > RR + 5e-4)
    return float((A[plen] * V[plen]).sum() / (A * V).sum())


def measure(case, t0, t1):
    ts = times_in(case, t0, t1)
    if len(ts) < 2: raise ValueError(f'窗口 [{t0}, {t1}] 内只有 {len(ts)} 个写出时刻')
    C, V, F = mean_field(case, ts, 'C2H4.gas')
    ln = lines(C, V, F)
    half = len(ts) // 2
    l1 = lines(*mean_field(case, ts[:half], 'C2H4.gas')); l2 = lines(*mean_field(case, ts[half:], 'C2H4.gas'))
    loss = lambda d: 0.5 * (d['0.06']['rmse'] + d['0.1']['rmse'])
    k, dev, nk = kpis(case, t0, t1)
    span = float(ts[-1]) - float(ts[0])
    pz = plateau(C, V, F)
    m = dict(
        loss_fig12b=loss(ln), loss_half1=loss(l1), loss_half2=loss(l2), fit_consistent=abs(loss(l1) - loss(l2)),
        rmse_006=ln['0.06']['rmse'], rmse_010=ln['0.1']['rmse'],
        min_over_wall_006=ln['0.06']['min'], min_over_wall_010=ln['0.1']['min'], z04_min_over_wall=ln['0.4']['min'],
        kpi_dev_max_pct=max(abs(v) for v in dev.values()), C2H4_C3H6=k['C2H4_C3H6'], S_C2C3_pct=k['S_C2C3_pct'],
        eta_MeOH_pct=k['eta_MeOH_pct'], kpi_rows=nk,
        leak_frac=leak(case, ts[-1]), sampleCount=len(ts), windowCoverage=min(1.0, span / max(t1 - t0, 1e-9)),
        # 封存量：不进验收规则
        plateau_m=pz, plateau_err_m=abs(pz - C_['targets']['fig12a_plateau_m']),
        xmin_006=ln['0.06']['xmin'], theta_min_over_wall_006=ln['0.06']['theta_min'])
    bad = [n for n, v in m.items() if not math.isfinite(v)]
    if bad: raise ValueError(f'非有限测量值: {bad}')
    return m, ln


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--case'); ap.add_argument('--t0', type=float); ap.add_argument('--t1', type=float); ap.add_argument('--out')
    a = ap.parse_args()
    if a.case:
        m, ln = measure(a.case, a.t0, a.t1)
        json.dump(dict(metrics=m, lines=ln), open(a.out, 'w'), indent=1)
        print(json.dumps(m))
        return
    p = json.load(open(os.environ.get('CFD_PARAMS_PATH', 'trial-params.json')))
    t_end = float(p['t0']) + float(p['duration_s'])
    m, _ = measure('.', t_end - float(p['window_s']), t_end)
    with open(os.environ.get('CFD_METRICS_PATH', 'metrics.json'), 'x') as f:
        json.dump(m, f)
    print(json.dumps(m))


if __name__ == '__main__':
    main()
