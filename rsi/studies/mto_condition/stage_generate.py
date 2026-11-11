#!/usr/bin/env python3
"""generate 阶段（工况研究）：在候选目录里按 trial-params.json 改
  0/U.gas inlet2 massFlowRate（甲醇+水进料整体缩放）、0/T.gas / 0/T.particles（全部 738 → T）、
  constant/fvOptions 里 738 K 的 k[7]/a[7] 与 k7/a7（按 arr2 重新插值）、controlDict 起止与写出、decomposeParDict；
写 holes.json（当前 211 孔对照布孔，网格与分布板对照完全相同）。只写候选目录内文件。"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kinetics as K

CFG = json.load(open(os.path.join(HERE, 'config.json'), encoding='utf-8'))


def sub1(pat, rep, text, what, flags=re.M):
    out, n = re.subn(pat, rep, text, flags=flags)
    if n < 1: sys.exit(f'FATAL: {what} 未找到')
    return out


def set_top(text, key, value):
    pat = re.compile(rf'^{re.escape(key)}\s+[^;\n]*;', re.M)
    line = f'{key:<16}{value};'
    if pat.search(text): return pat.sub(line, text, count=1)
    return re.sub(r'^(endTime\s)', line + '\n' + r'\1', text, count=1, flags=re.M)


def edit(path, fn):
    s = open(path).read(); s2 = fn(s); open(path, 'w').write(s2)


def fv_options(text, T):
    k, a = K.interp(T)
    ks = ', '.join(f'{v:.10f}' for v in k); as_ = ', '.join(f'{v:.5f}' for v in a)
    text = sub1(r'static const scalar k\[7\] = \{[^}]*\};', f'static const scalar k[7] = {{{ks}}};', text, 'fvOptions k[7]')
    text = sub1(r'static const scalar a\[7\] = \{[^}]*\};', f'static const scalar a[7] = {{{as_}}};', text, 'fvOptions a[7]')
    text = sub1(r'const scalar k7 = [0-9.eE+-]+, a7 = [0-9.eE+-]+,', f'const scalar k7 = {k[6]:.10f}, a7 = {a[6]:.5f},', text, 'fvOptions k7/a7')
    return text.replace('// 738 K：Table 3', f'// {T:.2f} K（RSI 工况研究）：Table 3')


def main():
    p = json.load(open(os.environ.get('CFD_PARAMS_PATH', 'trial-params.json')))
    lo, hi = CFG['bounds']['feed_scale']; tl, th = CFG['bounds']['T_K']
    f, T = float(p['feed_scale']), float(p['T_K'])
    if not (lo <= f <= hi and tl <= T <= th): sys.exit(f'工况越界：feed_scale={f} T={T}')
    mdot = CFG['base']['inlet2_massFlowRate'] * f
    edit('0/U.gas', lambda s: sub1(r'(inlet2\s*\{[^}]*massFlowRate\s+constant\s+)[0-9.eE+-]+', rf'\g<1>{mdot:.8e}', s, 'U.gas inlet2 massFlowRate'))
    for fld in ('T.gas', 'T.particles'):
        edit('0/' + fld, lambda s: sub1(r'uniform 738(\.0)?\b', f'uniform {T:.4f}', s, fld + ' 738'))
    edit('constant/fvOptions', lambda s: fv_options(s, T))
    t0 = float(p['t0']); t_end = t0 + float(p['duration_s'])
    def control_dict(cd):
        for kk, v in (('startFrom', 'startTime'), ('startTime', p['t0']), ('stopAt', 'endTime'), ('endTime', f'{t_end:.6f}'),
                      ('writeControl', 'adjustable'), ('writeInterval', p['write_interval_s']), ('purgeWrite', 0)):
            cd = set_top(cd, kk, v)
        return cd
    edit('system/controlDict', control_dict)
    edit('system/decomposeParDict', lambda s: sub1(r'^numberOfSubdomains\s+\d+;', f'numberOfSubdomains {int(p["np"])};', s, 'numberOfSubdomains'))
    json.dump({'hash': p.get('candidate_hash', ''), 'holes': p['holes']}, open('holes.json', 'w'), indent=0)
    print(json.dumps(dict(feed_scale=f, T_K=T, inlet2_massFlowRate=mdot, k=K.interp(T)[0], endTime=t_end, np=p['np'])))


if __name__ == '__main__':
    main()
