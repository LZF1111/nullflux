#!/usr/bin/env python3
"""T1 判定（不看模型自述）：在运行目录里找 forceCoeffs 的 coefficient.dat，取后 50 % 时段的 Cl，
去均值后做 FFT 求主频 f，St = f·D/U（D = U = 1）。同时检查同一算例下求解日志有 End。
用法: judge_t1.py RUN_DIR → 打印 JSON，并写 RUN_DIR/judge.json"""
import glob, json, os, sys
import numpy as np

D = U = 1.0
LO, HI = 0.16, 0.17


def read_coeff(path):
    rows, cols = [], None
    for line in open(path, errors='replace'):
        if line.startswith('#'):
            h = line[1:].split()
            if 'Cl' in h and h[0].lower() == 'time': cols = h
            continue
        p = line.split()
        if p:
            try: rows.append([float(x) for x in p])
            except ValueError: pass
    if not rows or not cols: return None
    a = np.array([r[:len(cols)] for r in rows if len(r) >= len(cols)])
    return a[:, 0], a[:, cols.index('Cl')]


def st_of(t, cl):
    keep = t >= t[0] + 0.5 * (t[-1] - t[0])
    t, cl = t[keep], cl[keep]
    if len(t) < 64: return None, 0
    tu = np.linspace(t[0], t[-1], len(t))
    y = np.interp(tu, t, cl); y -= y.mean()
    f = np.fft.rfftfreq(len(y), tu[1] - tu[0]); P = np.abs(np.fft.rfft(y * np.hanning(len(y))))
    k = int(np.argmax(P[1:])) + 1
    return float(f[k] * D / U), float((t[-1] - t[0]) * f[k])


def main(run):
    out = dict(task='T1', run=run, passed=False, St=None, periods=None, ended=False, coeff_file=None, reason='')
    files = sorted(glob.glob(os.path.join(run, '**', 'coefficient*.dat'), recursive=True), key=os.path.getmtime)
    if not files: out['reason'] = '没有 coefficient.dat'
    else:
        out['coeff_file'] = os.path.relpath(files[-1], run)
        # 同一函数对象可能因重启分成多个时间目录：合并同一 postProcessing/<name>/ 下的全部文件
        base = files[-1].split(os.sep + 'postProcessing' + os.sep)[0]
        name = files[-1].split(os.sep + 'postProcessing' + os.sep)[1].split(os.sep)[0]
        parts = [read_coeff(f) for f in glob.glob(os.path.join(base, 'postProcessing', name, '*', 'coefficient*.dat'))]
        parts = [p for p in parts if p]
        if not parts: out['reason'] = 'coefficient.dat 没有 Cl 列'
        else:
            t = np.concatenate([p[0] for p in parts]); cl = np.concatenate([p[1] for p in parts])
            o = np.argsort(t); t, cl = t[o], cl[o]
            t, u = np.unique(t, return_index=True); cl = cl[u]
            out['St'], out['periods'] = st_of(t, cl)
            # 只认求解器日志（含 "Time = " 时间步）里的 End；blockMesh/decomposePar 的 End 不算
            logs = glob.glob(os.path.join(base, 'log*')) + glob.glob(os.path.join(base, '*.log'))
            def solver_ended(f):
                txt = open(f, errors='replace').read()
                return '\nTime = ' in txt and any(l.strip() == 'End' for l in txt.splitlines()[-50:])
            out['ended'] = any(solver_ended(f) for f in logs)
            ok_st = out['St'] is not None and LO <= out['St'] <= HI
            out['passed'] = bool(ok_st and out['ended'] and (out['periods'] or 0) >= 5)
            if not out['passed']:
                out['reason'] = '; '.join(x for x, bad in [(f'St {out["St"]} 不在 [{LO}, {HI}]', not ok_st),
                                                          ('日志没有 End', not out['ended']),
                                                          (f'稳定段周期数 {out["periods"]} < 5', (out['periods'] or 0) < 5)] if bad)
    try: out['self_report'] = json.load(open(os.path.join(run, 'result.json')))
    except Exception: out['self_report'] = None
    json.dump(out, open(os.path.join(run, 'judge.json'), 'w'), indent=1, ensure_ascii=False)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main(os.path.abspath(sys.argv[1]))
