#!/usr/bin/env python3
"""T4 判定（不看模型自述）：三套网格的鼓泡床压降网格无关性研究。
按 constant/polyMesh/owner 头里的 nCells 找到 3000 / 12000 / 48000 单元的三个算例（每种取第一个找到的、能判通过的优先），
每个算例单独用 judge_t3 的规则：2–6 s 平均 Δp ∈ 理论值 ±5 %，日志有 End，最后时间 ≥ 5.99 s。
另外核对 result.json：三套都报了 dp_Pa，且与数据相差 ≤ 2 %。三套全过 + 自报一致 → passed。用法: judge_t4.py RUN_DIR"""
import glob, json, os, re, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import judge_t3 as J

MESH = {3000: '30x100', 12000: '60x200', 48000: '120x400'}


def ncells(case):
    try:
        head = open(os.path.join(case, 'constant', 'polyMesh', 'owner'), errors='replace').read(2000)
        m = re.search(r'nCells:\s*(\d+)', head)
        return int(m.group(1)) if m else None
    except OSError:
        return None


def judge_case(case):
    # judge_t3 以"运行目录"为根递归找 postProcessing；给每个算例单独一个只含它的临时根，避免串到别的算例
    with tempfile.TemporaryDirectory() as d:
        os.symlink(os.path.abspath(case), os.path.join(d, 'case'))
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            J.main(d)
        return json.load(open(os.path.join(d, 'judge.json')))


def main(run):
    out = dict(task='T4', run=run, passed=False, cases={}, reason='')
    cands = {}
    for owner in glob.glob(os.path.join(run, '**', 'constant', 'polyMesh', 'owner'), recursive=True):
        case = owner.split(os.sep + 'constant' + os.sep)[0]
        if os.sep + 'processor' in case: continue
        n = ncells(case)
        if n in MESH: cands.setdefault(MESH[n], []).append(case)
    for mesh in MESH.values():
        best = None
        for case in sorted(cands.get(mesh, [])):
            j = judge_case(case)
            j['case'] = os.path.relpath(case, run)
            if best is None or (j['passed'] and not best['passed']): best = j
        out['cases'][mesh] = best and {k: best[k] for k in ('case', 'passed', 'dp_Pa', 'final_time', 'ended', 'reason')}
    missing = [m for m, c in out['cases'].items() if c is None]
    bad = [m for m, c in out['cases'].items() if c and not c['passed']]
    try: rep = json.load(open(os.path.join(run, 'result.json')))
    except Exception: rep = None
    out['self_report'] = rep
    mism = []
    if rep and isinstance(rep.get('cases'), list):
        got = {str(c.get('mesh', '')).replace(' ', '').replace('×', 'x'): c.get('dp_Pa') for c in rep['cases']}
        for m, c in out['cases'].items():
            if c and c['dp_Pa'] is not None:
                v = got.get(m)
                if not isinstance(v, (int, float)) or abs(v - c['dp_Pa']) > 0.02 * abs(c['dp_Pa']): mism.append(f'{m} 自报 {v} vs 数据 {c["dp_Pa"]}')
    else:
        mism.append('result.json 缺失或格式不对')
    reasons = ([f'缺网格 {missing}'] if missing else []) + [f'{m}: {out["cases"][m]["reason"]}' for m in bad] + mism
    out['passed'] = not reasons
    out['reason'] = '; '.join(reasons)
    json.dump(out, open(os.path.join(run, 'judge.json'), 'w'), indent=1, ensure_ascii=False)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main(os.path.abspath(sys.argv[1]))
