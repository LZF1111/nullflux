#!/usr/bin/env python3
"""generate 阶段（放大设计）：按 trial-params.json 用 gen_scale.py custom 在 ./_gen 生成完整算例，
再覆盖候选目录的 system/ constant/ 0/（只写候选目录内文件），留 case_meta.json 与 deviations.log.md。"""
import json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS = ('D_m', 'H_m', 'T_K', 'inv_t', 'steam_ratio')


def main():
    p = json.load(open(os.environ.get('CFD_PARAMS_PATH', 'trial-params.json')))
    dur, t0 = float(p['duration_s']), float(p['avg_from_s'])
    gp = dict(base='commercial', end=dur, avg=[t0, dur], **{k: p[k] for k in KEYS})
    with open('_gen_params.json', 'w') as f: json.dump(gp, f)
    env = dict(os.environ, GEN_PARAMS=os.path.abspath('_gen_params.json'), MAXDT=str(p['max_dt']))
    r = subprocess.run(['python3', os.path.join(HERE, 'gen_scale.py'), 'custom', '_gen', str(int(p['np']))], env=env,
                       capture_output=True, text=True)
    print(r.stdout); print(r.stderr, file=sys.stderr)
    if r.returncode: sys.exit(f'FATAL: gen_scale 失败 rc={r.returncode}')
    for sub in ('system', 'constant'):
        for name in os.listdir(os.path.join('_gen', sub)):
            src, dst = os.path.join('_gen', sub, name), os.path.join(sub, name)
            if os.path.isdir(dst): shutil.rmtree(dst)
            (shutil.copytree if os.path.isdir(src) else shutil.copyfile)(src, dst)
    shutil.rmtree('0'); shutil.copytree(os.path.join('_gen', '0.orig'), '0')
    for f in ('case_meta.json', 'deviations.log.md'): shutil.copyfile(os.path.join('_gen', f), f)
    shutil.rmtree('_gen'); os.remove('_gen_params.json')
    meta = json.load(open('case_meta.json'))
    print(json.dumps(dict(cells=meta['cells'], U_in=meta['U_in'], H0=meta['H0'], wc0=meta['wc0'], end=meta['end'])))


if __name__ == '__main__':
    main()
