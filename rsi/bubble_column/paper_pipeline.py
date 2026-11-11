#!/usr/bin/env python3
"""paper_pipeline.py — 论文完整执行流程管理器。

步骤：
  1. phase1  跑 N_STATIC 个静态配置 → CFD + 轨迹统计
  2. phase2  训练 GPR 代理模型
  3. phase3  对4个目标轨迹分别求逆问题 → 得到最优静态配置
  4. phase4  对 zigzag 目标合成动态切换序列
  5. phase5  把逆问题结果和动态序列各跑一次 CFD 验证
  6. report  汇总结果，输出 paper_data.json（Figures 数据来源）

用法：
  paper_pipeline.py status        当前进度
  paper_pipeline.py run phase1    执行第1阶段
  paper_pipeline.py run phase2
  ...
  paper_pipeline.py run all       全部顺序执行
  paper_pipeline.py report        生成报告数据
"""
import argparse, json, math, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import zone_eval as ZE

C = ZE.CONTRACT
ROOT = C['run']['work_root']
ARCH_PATH = os.path.join(ROOT, 'archive.json')

# 静态配置集合（Phase 1 要跑的全部种子）
STATIC_SEEDS = [
    'seeds/s0_uniform.py',
    'seeds/s1_left.py',
    'seeds/s2_right.py',
    'seeds/s3_center.py',
    'seeds/s4_annular.py',
]

# 中间强度配置：在 s0-s1 和 s0-s2 之间各插2个点，增加代理模型密度
INTERMEDIATE_SEEDS = [
    'seeds/s5_mild_left.py',
    'seeds/s6_mild_right.py',
    'seeds/s7_left_center.py',
    'seeds/s8_right_center.py',
]


def load_arch():
    if os.path.exists(ARCH_PATH):
        return json.load(open(ARCH_PATH))
    return dict(trials={})


def run_rsi_submit(seed_path, dry=False):
    cmd = [sys.executable, os.path.join(HERE, 'rsi.py'), 'submit', seed_path]
    if dry:
        cmd.append('--dry')
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE)
    print(result.stdout)
    if result.returncode != 0:
        print('STDERR:', result.stderr[:500], file=sys.stderr)
    return result.returncode == 0


def run_surrogate(cmd_name, target=None):
    cmd = [sys.executable, os.path.join(HERE, 'surrogate.py'), cmd_name]
    if target:
        cmd += ['--target', target]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE)
    print(result.stdout)
    if result.returncode != 0:
        print('STDERR:', result.stderr[:500], file=sys.stderr)
    return result.returncode == 0


def cmd_status(_):
    arch = load_arch()
    done = [(h, t) for h, t in arch['trials'].items() if t.get('cfd_passed')]
    surr = os.path.exists(os.path.join(ROOT, 'surrogate.json'))
    inv  = {name: os.path.exists(os.path.join(ROOT, f'inverse_{name}.json'))
            for name in C['targets'] if name != 'note'}
    seqs = {name: os.path.exists(os.path.join(ROOT, f'sequence_{name}.json'))
            for name in C['targets'] if name != 'note'}

    print(f'Phase 1 — Static CFD runs:  {len(done)} / {len(STATIC_SEEDS)+len(INTERMEDIATE_SEEDS)} done')
    for h, t in done:
        z = t.get('zones', [])
        print(f'  {h}  zones={[round(v,4) for v in z]}  escape={t.get("escape_pct","?")}%')
    print(f'Phase 2 — GPR trained:      {"YES" if surr else "NO"}')
    print(f'Phase 3 — Inverse solutions:')
    for name, found in inv.items():
        print(f'  {name:15s} {"found" if found else "pending"}')
    print(f'Phase 4 — Dynamic sequences:')
    for name, found in seqs.items():
        print(f'  {name:15s} {"found" if found else "pending"}')


def cmd_run(a):
    phase = a.phase

    if phase in ('phase1', 'all'):
        print('=== Phase 1: Static CFD runs ===')
        arch = load_arch()
        all_seeds = STATIC_SEEDS + INTERMEDIATE_SEEDS
        for seed in all_seeds:
            path = os.path.join(HERE, seed)
            if not os.path.exists(path):
                print(f'  skip {seed} (file not found)')
                continue
            # Check if already done
            import importlib.util
            spec = importlib.util.spec_from_file_location('_s', path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            r = ZE.check(mod.zones(ZE.context()))
            if r['ok'] and r['hash'] in arch.get('trials', {}):
                print(f'  skip {seed} (already in archive: {r["hash"]})')
                continue
            print(f'  Submitting {seed}...')
            ok = run_rsi_submit(path)
            if not ok:
                print(f'  WARNING: {seed} failed, continuing...')
        if phase != 'all':
            return

    if phase in ('phase2', 'all'):
        print('=== Phase 2: Train GPR surrogate ===')
        ok = run_surrogate('train')
        if not ok:
            sys.exit('GPR training failed')
        if phase != 'all':
            return

    if phase in ('phase3', 'all'):
        print('=== Phase 3: Inverse solutions for all targets ===')
        for name in C['targets']:
            if name == 'note':
                continue
            print(f'  Solving inverse for target: {name}')
            run_surrogate('inverse', target=name)
        if phase != 'all':
            return

    if phase in ('phase4', 'all'):
        print('=== Phase 4: Dynamic sequence synthesis for zigzag ===')
        run_surrogate('sequence', target='zigzag')
        if phase != 'all':
            return

    if phase in ('phase5', 'all'):
        print('=== Phase 5: CFD validation of inverse + dynamic results ===')
        # Build trial-params.json from each inverse result and submit
        for name in C['targets']:
            if name == 'note':
                continue
            inv_path = os.path.join(ROOT, f'inverse_{name}.json')
            if not os.path.exists(inv_path):
                print(f'  skip {name}: inverse result not found')
                continue
            inv = json.load(open(inv_path))
            params = dict(
                zones=inv['best_zones'],
                candidate_hash=f'inv_{name}',
                np=C['run']['np'],
                _note=f'Inverse-problem validation for target={name}',
            )
            # Write a one-off seed file
            seed_path = os.path.join(HERE, f'seeds/inv_{name}.py')
            with open(seed_path, 'w') as f:
                z = inv['best_zones']
                f.write(f'"""Inverse-problem result for target={name}."""\n\n')
                f.write(f'def zones(ctx):\n')
                f.write(f'    return {z}\n')
            print(f'  Submitting validation run for {name}...')
            run_rsi_submit(seed_path)

        # Dynamic sequence validation
        seq_path = os.path.join(ROOT, 'sequence_zigzag.json')
        if os.path.exists(seq_path):
            seq = json.load(open(seq_path))
            tdir = os.path.join(ROOT, 'trials', 'dynamic_zigzag')
            os.makedirs(tdir, exist_ok=True)
            params = dict(
                schedule=seq['schedule'],
                candidate_hash='dynamic_zigzag',
                np=C['run']['np'],
                _note='Dynamic switching validation for zigzag target',
            )
            json.dump(params, open(os.path.join(tdir, 'trial-params.json'), 'w'), indent=1)
            print('  Dynamic zigzag trial-params.json written to:', tdir)
            print('  Run manually: cd', tdir, '&& python3', os.path.join(HERE, 'stage_generate.py'))

    if phase in ('report', 'all'):
        cmd_report(None)


def cmd_report(_):
    """Aggregate all results into paper_data.json."""
    arch = load_arch()
    surr_path = os.path.join(ROOT, 'surrogate.json')
    reach_path = os.path.join(ROOT, 'reachability.json')

    fig_data = {}

    # Fig 2: Static CFD — flow pattern + trajectory stats per config
    fig2 = {}
    for h, t in arch['trials'].items():
        if not t.get('cfd_passed'):
            continue
        traj = t.get('trajectory_stats', [])
        fig2[h] = dict(
            zones=t.get('zones'),
            features=t.get('features'),
            trajectory_stats=traj,
        )
    fig_data['fig2_static_configs'] = fig2

    # Fig 3: GPR surrogate quality (LOO predictions from surrogate.json)
    if os.path.exists(surr_path):
        fig_data['fig3_surrogate_quality'] = dict(path=surr_path)

    # Fig 4: Inverse problem solutions
    fig4 = {}
    for name in C['targets']:
        if name == 'note':
            continue
        inv_path = os.path.join(ROOT, f'inverse_{name}.json')
        if os.path.exists(inv_path):
            fig4[name] = json.load(open(inv_path))
    fig_data['fig4_inverse_solutions'] = fig4

    # Fig 5: Dynamic switching zigzag
    seq_path = os.path.join(ROOT, 'sequence_zigzag.json')
    if os.path.exists(seq_path):
        fig_data['fig5_dynamic_sequence'] = json.load(open(seq_path))

    # Fig 6: Reachability
    if os.path.exists(reach_path):
        fig_data['fig6_reachability'] = dict(path=reach_path)

    out_path = os.path.join(ROOT, 'paper_data.json')
    json.dump(fig_data, open(out_path, 'w'), indent=1)
    print(f'Paper data → {out_path}')
    print(f'  Static configs : {len(fig2)}')
    print(f'  Inverse results: {len(fig4)}')
    print(f'  Zigzag sequence: {"YES" if os.path.exists(seq_path) else "NO"}')
    print(f'  Reachability   : {"YES" if os.path.exists(reach_path) else "NO"}')


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    sp.add_parser('status')
    sp.add_parser('report')
    p = sp.add_parser('run')
    p.add_argument('phase',
                   choices=['phase1','phase2','phase3','phase4','phase5','report','all'])
    a = ap.parse_args()
    globals()['cmd_' + a.cmd](a)


if __name__ == '__main__':
    main()
