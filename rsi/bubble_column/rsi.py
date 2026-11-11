#!/usr/bin/env python3
"""鼓泡塔轨迹控制 RSI 编排器。
  rsi.py init            建模板目录（从 case_template 复制）
  rsi.py check  seed.py  离线检查一个区域配置
  rsi.py submit seed.py [--dry]  提交 CFD 试验
  rsi.py status          显示存档状态
  rsi.py context         提议者可见的档案
"""
import argparse, json, math, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import zone_eval as ZE

C = ZE.CONTRACT
RUN = C['run']
ROOT = RUN['work_root']
ARCH = os.path.join(ROOT, 'archive.json')
TEMPLATE = os.path.join(ROOT, 'template')
STUDY = f"bc-{C['study']}"


def load_arch():
    if os.path.exists(ARCH):
        return json.load(open(ARCH, encoding='utf-8'))
    return dict(study=STUDY, champion=None, control=None, cells={}, trials={})


def save_arch(a):
    os.makedirs(ROOT, exist_ok=True)
    tmp = ARCH + '.tmp'
    json.dump(a, open(tmp, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    os.replace(tmp, ARCH)


def pipeline():
    to = RUN['timeouts_ms']
    return dict(stages=dict(
        generate=dict(command=['python3', os.path.join(HERE, 'stage_generate.py')], timeoutMs=to['generate']),
        mesh=dict(command=['bash', os.path.join(HERE, 'stage_mesh.sh')],             timeoutMs=to['mesh']),
        solve=dict(command=['bash', os.path.join(HERE, 'stage_solve.sh')],           timeoutMs=to['solve']),
        verify=dict(command=['python3', os.path.join(HERE, 'verify.py')],             timeoutMs=to['verify'])))


def load_seed(path):
    """Load a seed/candidate file defining zones(ctx) -> [Ug1, Ug2, Ug3]."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('_seed', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    raw = mod.zones(ZE.context())
    return raw


def cmd_init(_):
    if os.path.exists(TEMPLATE):
        print('模板已存在:', TEMPLATE)
        return
    src = os.path.join(HERE, 'case_template')
    shutil.copytree(src, TEMPLATE)
    print('模板已建:', TEMPLATE)


def cmd_check(a):
    raw = load_seed(a.seed)
    r = ZE.check(raw)
    r.pop('zones', None)
    print(json.dumps(r, indent=1, ensure_ascii=False))
    if not r['ok']:
        sys.exit(1)


def cmd_submit(a):
    arch = load_arch()
    raw = load_seed(a.seed)
    r = ZE.check(raw)
    if not r['ok']:
        sys.exit('区域配置违反约束: ' + '; '.join(r['violations']))

    h = r['hash']
    if h in arch['trials']:
        sys.exit(f'配置 {h} 已试过: {arch["trials"][h].get("state")}')

    zones = r['zones']
    params = dict(
        zones=zones,
        candidate_hash=h,
        np=RUN['np'],
    )
    tdir = os.path.join(ROOT, 'trials', h)
    cfg = dict(
        baseCase=TEMPLATE,
        trialDir=tdir,
        studyId=STUDY,
        trialId=h,
        params=params,
        **pipeline()
    )
    os.makedirs(os.path.join(ROOT, 'configs'), exist_ok=True)
    cpath = os.path.join(ROOT, 'configs', h + '.json')
    json.dump(cfg, open(cpath, 'w'), indent=1)

    rec = dict(hash=h, zones=zones, features=r['features'],
               cell=ZE.cell(r['features']), state='running', started=time.time())
    if a.dry:
        print(json.dumps(dict(config=cpath, record=rec), indent=1, ensure_ascii=False))
        return

    arch['trials'][h] = rec
    save_arch(arch)

    p = subprocess.run(['node', RUN['cfd_trial'], cpath], capture_output=True, text=True)
    arch = load_arch()
    res_path = os.path.join(tdir, 'trial-result.json')
    if not os.path.exists(res_path):
        del arch['trials'][h]
        save_arch(arch)
        sys.exit('cfd_trial 预检拒绝（未登记）: ' + (p.stderr or p.stdout)[-1500:])

    res = json.load(open(res_path))
    rec = arch['trials'][h]
    rec.update(ended=time.time(), cfd_passed=bool(res.get('passed')), error=res.get('error'))

    traj_path = os.path.join(tdir, 'trajectory_stats.json')
    if os.path.exists(traj_path):
        traj = json.load(open(traj_path))
        rec['trajectory_stats'] = traj.get('trajectory_stats', [])
        rec['escape_pct'] = traj.get('escape_pct')

    # Accept as champion if first valid or better x-deviation controllability
    if rec.get('cfd_passed'):
        rec['state'] = 'accepted'
        if arch['champion'] is None:
            arch['champion'] = h
        arch['cells'][rec['cell']] = h
    else:
        rec['state'] = 'failed'

    save_arch(arch)
    print(json.dumps({k: rec[k] for k in ('hash', 'cell', 'state', 'escape_pct', 'error') if k in rec}, indent=1))


def cmd_status(_):
    a = load_arch()
    print(json.dumps(dict(
        study=a['study'],
        champion=a['champion'],
        trials={h: t['state'] for h, t in a['trials'].items()},
        cells=a['cells'],
    ), indent=1, ensure_ascii=False))


def context_text(arch=None):
    arch = arch or load_arch()
    lines = ['## 约束', json.dumps(ZE.context(), ensure_ascii=False)]
    lines.append('## 目标轨迹')
    lines.append(json.dumps(C['targets'], ensure_ascii=False))
    lines.append('## 已完成试验')
    for h, t in sorted(arch['trials'].items(), key=lambda kv: kv[1].get('started', 0)):
        f = t.get('features', {})
        lines.append(
            f"- {h} cell={t.get('cell')} state={t.get('state')} "
            f"asym={f.get('asymmetry', '?'):.3f} cfrac={f.get('center_frac', '?'):.3f} "
            f"escape={t.get('escape_pct', '?')}%"
        )
    lines.append(f'## 冠军 {arch["champion"]}')
    return '\n'.join(lines)


def cmd_context(_):
    print(context_text())


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    sp.add_parser('init')
    sp.add_parser('status')
    sp.add_parser('context')
    p = sp.add_parser('check')
    p.add_argument('seed')
    p = sp.add_parser('submit')
    p.add_argument('seed')
    p.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    globals()['cmd_' + a.cmd](a)


if __name__ == '__main__':
    main()
