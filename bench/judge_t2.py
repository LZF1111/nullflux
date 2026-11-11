#!/usr/bin/env python3
"""T2 判定：在 T1 判定基础上，St 区间改为 [0.19, 0.21]，并要求求解器最后时间 ≥ 299.9 s。
用法: judge_t2.py RUN_DIR → 打印 JSON，写 RUN_DIR/judge.json"""
import glob, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import judge_t1 as J

J.LO, J.HI = 0.19, 0.21
T_END = 299.9


def last_time(run):
    best = None
    for f in glob.glob(os.path.join(run, '**', 'log*'), recursive=True):
        try:
            with open(f, 'rb') as fh:
                fh.seek(0, 2); n = fh.tell(); fh.seek(max(0, n - 200000)); tail = fh.read().decode(errors='replace')
        except OSError: continue
        m = re.findall(r'^Time = ([0-9.eE+-]+)\s*$', tail, re.M)
        if m:
            t = float(m[-1]); best = t if best is None else max(best, t)
    return best


def main(run):
    J.main(run)
    p = os.path.join(run, 'judge.json'); out = json.load(open(p))
    out['task'] = 'T2'; out['final_time'] = last_time(run)
    ok_t = out['final_time'] is not None and out['final_time'] >= T_END
    if not ok_t:
        out['passed'] = False
        out['reason'] = '; '.join(x for x in [out.get('reason'), f'求解最后时间 {out["final_time"]} < {T_END}'] if x)
    json.dump(out, open(p, 'w'), indent=1, ensure_ascii=False)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main(os.path.abspath(sys.argv[1]))
