#!/usr/bin/env python3
"""T3 判定（不看模型自述）：鼓泡床压降。
找 surfaceFieldValue 输出（surfaceFieldValue.dat），识别进口/出口两组（按函数对象目录名含 in/out，或按均值高低），
取 2–6 s 时间平均 Δp = p_in − p_out。理论值：完全流化时 Δp = 颗粒净重/截面积 + 气柱静压
 = (ρp − ρg)·αp0·H0·g + ρg·g·H = (2500 − 1.18)·0.55·0.4·9.81 + 1.18·9.81·1.0 ≈ 5405 Pa。通过区间 ±5 %（开跑前写定）。
同时要求求解器日志有 End、最后时间 ≥ 5.99 s。用法: judge_t3.py RUN_DIR"""
import glob, json, os, re, sys
import numpy as np

RHO_P, RHO_G, A0, H0, H, G = 2500.0, 1.18, 0.55, 0.4, 1.0, 9.81
DP_TH = (RHO_P - RHO_G) * A0 * H0 * G + RHO_G * G * H
LO, HI = 0.95 * DP_TH, 1.05 * DP_TH
T_A, T_B, T_END = 2.0, 6.0, 5.99


def read_sfv(path):
    rows = []
    for line in open(path, errors='replace'):
        if line.startswith('#') or not line.strip(): continue
        p = line.replace('(', ' ').replace(')', ' ').split()
        try: rows.append([float(x) for x in p[:2]])
        except ValueError: pass
    return np.array(rows) if rows else None


def series(files):
    parts = [read_sfv(f) for f in files]; parts = [p for p in parts if p is not None and len(p)]
    if not parts: return None
    a = np.concatenate(parts); a = a[np.argsort(a[:, 0])]
    _, u = np.unique(a[:, 0], return_index=True)
    return a[u]


def last_time(base):
    best = None
    for f in glob.glob(os.path.join(base, 'log*')) + glob.glob(os.path.join(base, '*.log')):
        txt = open(f, errors='replace').read()
        if '\nTime = ' not in txt: continue
        m = re.findall(r'^Time = ([0-9.eE+-]+)\s*$', txt, re.M)
        # End 出现在最后一个时间步之后即算正常结束：twoPhaseEulerFoam v2306 在 End 之后析构时会 abort，
        # 打出上百行栈回溯，不能只看日志最后 50 行（参考算例校准时发现，开跑前修正）
        ended = re.search(r'^End\s*$', txt[txt.rfind('\nTime = '):], re.M) is not None
        if m: best = max(best or (0, False), (float(m[-1]), ended))
    return best


def main(run):
    out = dict(task='T3', run=run, passed=False, dp_Pa=None, dp_theory=round(DP_TH, 1), final_time=None, ended=False, reason='')
    files = glob.glob(os.path.join(run, '**', 'postProcessing', '*', '*', 'surfaceFieldValue*.dat'), recursive=True)
    groups = {}
    for f in files:
        k = f.split(os.sep + 'postProcessing' + os.sep)
        groups.setdefault((k[0], k[1].split(os.sep)[0]), []).append(f)
    # 只保留看起来是 p 的组：头部字段名含 (p) 而不是 p_rgh
    def is_p(fs):
        for line in open(fs[0], errors='replace'):
            if line.startswith('#') and ('areaAverage(p)' in line or 'average(p)' in line or re.search(r'\(p\)', line)): return True
        return False
    groups = {k: v for k, v in groups.items() if is_p(v)}
    out['groups'] = sorted(k[1] for k in groups)
    if len(groups) < 2: out['reason'] = f'找到的 p 面平均输出不足两组: {out["groups"]}'
    else:
        base = sorted(groups)[0][0]
        avg = {}
        for k, fs in groups.items():
            a = series(fs)
            if a is None: continue
            w = a[(a[:, 0] >= T_A) & (a[:, 0] <= T_B)]
            if len(w) >= 5: avg[k[1]] = float(w[:, 1].mean())
        if len(avg) < 2: out['reason'] = f'2–6 s 内数据不足: {avg}'
        else:
            name_in = [n for n in avg if re.search(r'in', n, re.I) and not re.search(r'out', n, re.I)]
            name_out = [n for n in avg if re.search(r'out|top', n, re.I)]
            pin = avg[name_in[0]] if name_in else max(avg.values())
            pout = avg[name_out[0]] if name_out else min(avg.values())
            out['dp_Pa'] = round(pin - pout, 1); out['p_avg'] = avg
        lt = last_time(base)
        if lt: out['final_time'], out['ended'] = lt
        ok_dp = out['dp_Pa'] is not None and LO <= out['dp_Pa'] <= HI
        ok_t = out['ended'] and (out['final_time'] or 0) >= T_END
        out['passed'] = bool(ok_dp and ok_t)
        if not out['passed']:
            out['reason'] = '; '.join(x for x, bad in [(f'Δp {out["dp_Pa"]} 不在 [{LO:.0f}, {HI:.0f}]', not ok_dp),
                                                      (f'求解未到 {T_END} s 或无 End（{out["final_time"]}, End={out["ended"]}）', not ok_t)] if bad) or out['reason']
    try: out['self_report'] = json.load(open(os.path.join(run, 'result.json')))
    except Exception: out['self_report'] = None
    json.dump(out, open(os.path.join(run, 'judge.json'), 'w'), indent=1, ensure_ascii=False)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main(os.path.abspath(sys.argv[1]))
