#!/usr/bin/env python3
"""通用 RSI 命令行：
  python3 -m core.cli STUDY init                 建模板（插件提供 init_template）
  python3 -m core.cli STUDY check CAND           离线检查候选
  python3 -m core.cli STUDY control              对照入队
  python3 -m core.cli STUDY enqueue CAND         候选入队
  python3 -m core.cli STUDY tick                 收割 + 按空闲核启动（不阻塞）
  python3 -m core.cli STUDY run --rounds N       无人值守循环（提议 → 入队 → 并行调度）
  python3 -m core.cli STUDY status
选项 --staged 0/1 覆盖插件默认的分级设置；--work-root 改工作目录（测试用）。"""
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from core import load_study, loop  # noqa: E402
from core.scheduler import Scheduler  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('study'); ap.add_argument('cmd', choices=['init', 'check', 'control', 'enqueue', 'tick', 'run', 'status'])
    ap.add_argument('cand', nargs='?'); ap.add_argument('--staged', type=int); ap.add_argument('--work-root')
    ap.add_argument('--rounds', type=int, default=4); ap.add_argument('--per-round', type=int, default=4)
    ap.add_argument('--reserve', type=int, help='覆盖插件的 reserve_cores（低优先级研究用大值，只用别人剩下的核）')
    ap.add_argument('--slots', type=int); ap.add_argument('--wait-s', type=int, default=600); ap.add_argument('--offline', action='store_true')
    ap.add_argument('--speculative', action='store_true', help='对照在跑时就预跑候选；完整结果等对照 control_ok 后才判定')
    a = ap.parse_args(argv)
    kw = {}
    if a.staged is not None: kw['staged'] = bool(a.staged)
    if a.work_root: kw['work_root'] = a.work_root
    S = load_study(a.study, **kw)
    if a.reserve is not None: S.reserve_cores = a.reserve
    sch = Scheduler(S, speculative=a.speculative)
    if a.cmd == 'init':
        if not hasattr(S, 'init_template'): sys.exit('该研究没有 init_template')
        print(S.init_template()); return
    if a.cmd == 'check':
        r = S.check(a.cand); r.pop('holes', None); r['surrogate'] = S.surrogate(r, sch.load()) if r['ok'] else None
        print(json.dumps(r, indent=1, ensure_ascii=False)); sys.exit(0 if r['ok'] else 1)
    if a.cmd in ('control', 'enqueue'):
        path = S.control_path if a.cmd == 'control' else a.cand
        ok, why = sch.enqueue(S.check(path), control=a.cmd == 'control')
        print(why); sys.exit(0 if ok else 1)
    if a.cmd == 'tick': print(json.dumps(sch.tick())); return
    if a.cmd == 'run':
        print(loop.run(S, sch, a.rounds, per_round=a.per_round, slots=a.slots, offline=a.offline, wait_s=a.wait_s,
                       log=lambda *x: print(*x, flush=True))); return
    arch = sch.load()
    print(json.dumps(dict(study=arch['study'], champion=arch['champion'], control=arch['control'] and arch['control']['state'],
                          queue=[(q['hash'], q['fidelity']) for q in arch['queue']],
                          trials={h: (t['state'], (t.get('run') or {}).get('fidelity')) for h, t in arch['trials'].items()},
                          cells=arch['cells'], surrogate=arch['surrogate']), indent=1, ensure_ascii=False))


if __name__ == '__main__':
    main()
