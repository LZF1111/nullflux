#!/usr/bin/env python3
"""两边统一口径的"智能体用时"：从任务发出到智能体最后一次宣布结束。
CFDriver：最后一个 agent_end（驱动之后的空闲等待不算）；OpenCode：最后一个事件（run 进程随即退出）。
另给出 token（含缓存读）与 LLM 调用次数。用法: agent_wall.py RUN_DIR... → 每行一个 JSON"""
import json, sys, os


def stats(run):
    ev = [json.loads(l) for l in open(os.path.join(run, 'events.jsonl'))]
    # 驱动宣布结束（driver_done）之后的事件不属于本次运行（例如脚本被替换导致的重发），截掉
    k = next((i for i, r in enumerate(ev) if r['e'].get('type') in ('driver_done', 'driver_timeout')), None)
    if k is not None: ev = ev[:k + 1]
    m = json.load(open(os.path.join(run, 'meta.json')))
    t0 = m['t0']; side = m['side']
    if side == 'cfdriver':
        ends = [r['t'] for r in ev if r['e'].get('type') == 'agent_end']
        t1 = ends[-1] if ends else ev[-1]['t']
        us = [r['e'].get('usage') or {} for r in ev if r['e'].get('type') == 'usage']
        tok = sum((u.get('prompt_tokens') or 0) + (u.get('completion_tokens') or 0) for u in us)
        fresh = sum((u.get('prompt_tokens') or 0) - ((u.get('prompt_tokens_details') or {}).get('cached_tokens') or 0) + (u.get('completion_tokens') or 0) for u in us)
        calls = len(us)
    else:
        real = [r for r in ev if r['e'].get('type') not in ('heartbeat',)]
        t1 = real[-1]['t'] if real else t0
        ts = [(r['e'].get('part') or {}).get('tokens') or {} for r in ev if r['e'].get('type') == 'step_finish']
        tok = sum((t.get('input') or 0) + (t.get('output') or 0) + ((t.get('cache') or {}).get('read') or 0) for t in ts)
        fresh = sum((t.get('input') or 0) + (t.get('output') or 0) for t in ts)
        calls = len(ts)
    try: j = json.load(open(os.path.join(run, 'judge.json')))
    except OSError: j = {}
    return dict(run=os.path.basename(run.rstrip('/')), side=side, passed=j.get('passed'), St=j.get('St'),
                agent_wall_s=round(t1 - t0), harness_wall_s=round(m.get('wall_s') or 0), tokens=tok, fresh_tokens=fresh, llm_calls=calls)


if __name__ == '__main__':
    for r in sys.argv[1:]:
        try: print(json.dumps(stats(r), ensure_ascii=False))
        except Exception as e: print(json.dumps({'run': r, 'error': str(e)}))
