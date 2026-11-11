#!/usr/bin/env python3
"""generate 阶段（cfd_trial.js 在候选目录里调用）：
trial-params.json → holes.json；按合同改 system/controlDict（起止时间、写出间隔、ascii 网格）与 decomposeParDict。
只写候选目录内文件；不碰模板和源算例。"""
import json, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import layout_eval as L

RUN = L.CONTRACT['run']


def set_top(text, key, value):
    """只改顶层条目（行首无缩进），functions 子字典里同名项不动"""
    pat = re.compile(rf'^{re.escape(key)}\s+[^;\n]*;', re.M)
    line = f'{key:<16}{value};'
    if pat.search(text): return pat.sub(line, text, count=1)
    return re.sub(r'^(endTime\s)', line + '\n' + r'\1', text, count=1, flags=re.M)


def main():
    p = json.load(open(os.environ.get('CFD_PARAMS_PATH', 'trial-params.json')))
    holes = p['holes']
    # 再核一次：参数里的孔必须已经是锁定 5 % 且满足制造约束的结果（防止绕过 rsi.py 直接投递）
    hs = [(float(x), float(y), float(d)) for x, y, d in holes]
    _, k = L.lock_opening(hs)
    bad = L.manufacturing(hs, 1.0)
    # check() 把孔径四舍五入到 1e-4 mm，k 会偏离 1 约 1e-6；1e-3 足以拦住未按 5 % 设计的投递
    if abs(k - 1) > 1e-3: bad.append(f'开孔率未锁定（缩放 {k:.6f}）')
    if bad: sys.exit('候选违反约束：' + '; '.join(bad[:5]))
    json.dump({'hash': p.get('candidate_hash', ''), 'holes': holes}, open('holes.json', 'w'), indent=0)

    t0 = float(p['t0']); t_end = t0 + float(p['duration_s'])
    cd = open('system/controlDict').read()
    for key, val in (('startFrom', 'startTime'), ('startTime', p['t0']), ('stopAt', 'endTime'), ('endTime', f'{t_end:.6f}'),
                     ('writeControl', 'adjustable'), ('writeInterval', p['write_interval_s']), ('purgeWrite', 0)):
        cd = set_top(cd, key, val)
    open('system/controlDict', 'w').write(cd)
    dp = open('system/decomposeParDict').read()
    dp = re.sub(r'^numberOfSubdomains\s+\d+;', f'numberOfSubdomains {int(p["np"])};', dp, count=1, flags=re.M)
    open('system/decomposeParDict', 'w').write(dp)
    f = L.features(hs)
    print(json.dumps({'holes': len(holes), 'd_eq_mm': round(f['d_eq_mm'], 3), 'endTime': t_end, 'np': p['np']}))


if __name__ == '__main__':
    main()
