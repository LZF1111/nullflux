#!/usr/bin/env python3
"""verify 阶段（放大设计）：只读 postProcessing（outletSpecies、cokeMean、bedInventory），写 metrics.json。
口径与 tools/kpi_scale.py 相同：出口质量流量窗口均值 ×72（wedge 5°），去 H2O/MeOH 的烃分布。
Y = S(C2H4+C3H6) × η(MeOH) / 100；前后半窗 Y 差作噪声；藏量守恒（bedInventory·ρs·72 / 设计藏量）作留出检查。"""
import glob, json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, 'config.json'), encoding='utf-8'))
SECTOR, RHO_S = 72.0, 1500.0


def series(case, fo, fn):
    seen = {}
    for f in sorted(glob.glob(os.path.join(case, 'postProcessing', fo, '*', fn)), key=lambda p: float(p.split(os.sep)[-2])):
        for ln in open(f):
            if ln.startswith('#') or not ln.strip(): continue
            v = [float(x) for x in ln.split()]
            seen[v[0]] = v
    return [seen[t] for t in sorted(seen)]


def kpi(rows, meoh_kg_h):
    n = len(rows); F = [sum(r[i] for r in rows) / n * SECTOR * 3600 for i in range(1, 9)]
    hc = sum(F[2:8]); S = 100 * (F[3] + F[4]) / hc; eta = 100 * (1 - F[0] / meoh_kg_h)
    return dict(S=S, eta=eta, ratio=F[3] / F[4], Y=S * eta / 100)


def measure(case, t0, t1, p):
    meoh = CFG['base']['meoh_kg_h']
    w = [r for r in series(case, 'outletSpecies', 'surfaceFieldValue.dat') if t0 <= r[0] <= t1]
    if len(w) < 10: raise ValueError(f'outletSpecies 窗口 [{t0}, {t1}] 只有 {len(w)} 行')
    k = kpi(w, meoh); h = len(w) // 2; k1, k2 = kpi(w[:h], meoh), kpi(w[h:], meoh)
    c = [r[1] for r in series(case, 'cokeMean', 'volFieldValue.dat') if t0 <= r[0] <= t1]
    inv = [r[1] for r in series(case, 'bedInventory', 'volFieldValue.dat') if t0 <= r[0] <= t1]
    yc = sum(c) / len(c)
    ref = CFG['control_reference']
    m = dict(neg_Y=-k['Y'], Y_pct=k['Y'], S_C2C3_pct=k['S'], eta_MeOH_pct=k['eta'], C2H4_C3H6=k['ratio'],
             wc_pct=100 * yc / (1 - yc), fit_consistent=abs(k1['Y'] - k2['Y']), sampleCount=len(w),
             windowCoverage=min(1.0, (w[-1][0] - w[0][0]) / max(t1 - t0, 1e-9)),
             inv_ratio=sum(inv) / len(inv) * RHO_S * SECTOR / (float(p['inv_t']) * 1000),
             kpi_dev_ref_max_pct=max(abs(100 * (a / ref[b] - 1)) for a, b in ((k['ratio'], 'C2H4_C3H6'), (k['S'], 'S_C2C3_pct'),
                                                                               (k['eta'], 'eta_MeOH_pct'))))
    bad = [n for n, v in m.items() if not math.isfinite(v)]
    if bad: raise ValueError(f'非有限测量值: {bad}')
    return m


def main():
    p = json.load(open(os.environ.get('CFD_PARAMS_PATH', 'trial-params.json')))
    t1 = float(p['duration_s']) - 1e-4
    m = measure('.', float(p['avg_from_s']), t1, p)
    with open(os.environ.get('CFD_METRICS_PATH', 'metrics.json'), 'x') as f: json.dump(m, f)
    print(json.dumps(m))


if __name__ == '__main__':
    main()
