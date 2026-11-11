#!/usr/bin/env python3
"""verify 阶段（工况研究）：只读 postProcessing/speciesZ1/speciesZ1.dat（z=1.0 m 截面质量通量，同分布板 verify 口径），
写 metrics.json。甲醇进料 M_IN 按 feed_scale 缩放。目标 neg_S = −气相 C2+C3 选择性（越小越好）；
前后半窗各算一次选择性，差值作统计噪声。"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, 'config.json'), encoding='utf-8'))


def rows(path, t0, t1):
    seen = {}
    with open(path) as f:
        for ln in f:
            if ln.startswith('#') or not ln.strip(): continue
            v = [float(x) for x in ln.split()]
            seen[v[0]] = v        # 重复时刻（续算重叠）留最后一次
    return [seen[t] for t in sorted(seen) if t0 <= t <= t1]


def kpi(w, m_in):
    n = len(w); m = [sum(r[i] for r in w) / n for i in range(1, 9)]
    hc = sum(m[2:8])
    return dict(C2H4_C3H6=m[3] / m[4], S_C2C3_pct=100 * (m[3] + m[4]) / hc, eta_MeOH_pct=100 * (1 - m[0] / m_in))


def measure(case, t0, t1, feed_scale):
    w = rows(os.path.join(case, 'postProcessing', 'speciesZ1', 'speciesZ1.dat'), t0, t1)
    if len(w) < 10: raise ValueError(f'speciesZ1 在窗口内只有 {len(w)} 行')
    m_in = CFG['base']['M_IN_MeOH'] * feed_scale
    k = kpi(w, m_in); h = len(w) // 2
    k1, k2 = kpi(w[:h], m_in), kpi(w[h:], m_in)
    ref = CFG['control_reference']
    m = dict(neg_S=-k['S_C2C3_pct'], S_C2C3_pct=k['S_C2C3_pct'], eta_MeOH_pct=k['eta_MeOH_pct'], C2H4_C3H6=k['C2H4_C3H6'],
             fit_consistent=abs(k1['S_C2C3_pct'] - k2['S_C2C3_pct']), sampleCount=len(w),
             windowCoverage=min(1.0, (w[-1][0] - w[0][0]) / max(t1 - t0, 1e-9)),
             kpi_dev_ref_max_pct=max(abs(100 * (k[n] / ref[n] - 1)) for n in ('C2H4_C3H6', 'S_C2C3_pct', 'eta_MeOH_pct')))
    bad = [n for n, v in m.items() if not math.isfinite(v)]
    if bad: raise ValueError(f'非有限测量值: {bad}')
    return m


def main():
    p = json.load(open(os.environ.get('CFD_PARAMS_PATH', 'trial-params.json')))
    t_end = float(p['t0']) + float(p['duration_s'])
    m = measure('.', t_end - float(p['window_s']), t_end, float(p['feed_scale']))
    with open(os.environ.get('CFD_METRICS_PATH', 'metrics.json'), 'x') as f: json.dump(m, f)
    print(json.dumps(m))


if __name__ == '__main__':
    main()
