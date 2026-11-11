"""无人值守循环（通用）：提议 → 离线 check + 代理排序 → 入队 → 调度器按空闲核并行跑（含分级筛选）→
每新增 calib_every 个完整结果回标一次代理。与旧 campaign.py 的区别：提交不阻塞，队列里可以同时有多个试验。
队列保持"刚好够填满空闲核 + 一个备用"，不一次性生成太多候选（档案变了，后面的候选应基于新档案提议）。"""
import json, os, time

from . import archive as A
from . import propose as P


def calibrate(study, sch, a):
    s = study.calibrate(list(a['trials'].values()), a)
    if s is not None: a['surrogate'] = s
    return s


def run(study, sch, rounds, per_round=4, slots=None, offline=False, wait_s=600, max_llm_waits=144, calib_every=3,
        llm=None, sleep=time.sleep, log=print, max_ticks=None):
    """rounds = 提议轮数（每轮最多 per_round 个候选，按 MAP-Elites 每格一个挑进队列）。
    slots = 同时在跑+排队的目标试验数；默认按 (cpus - reserve) // np。"""
    slots = slots or max(1, (sch.cpus - study.reserve_cores) // study.np)
    cand_dir = os.path.join(study.work_root, 'candidates')
    last_err = ''; rnd = 0; llm_waits = 0; ticks = 0
    calibrated_at = A.n_done(study, sch.load())
    while True:
        st = sch.tick(); ticks += 1
        a = sch.load()
        if (a['control'] or {}).get('state') == 'control_failed':
            log('对照未复现基准，停止：先查流水线'); return 'control_failed'
        done = A.n_done(study, a)
        if done >= calib_every and done - calibrated_at >= calib_every:
            s = calibrate(study, sch, a); sch.save(a); calibrated_at = done; log('calibrate', json.dumps(s))
        busy = st['running'] + st['queued']
        if rnd < rounds and busy < slots:
            cands, last_err, down = P.propose(study, a, per_round, last_err, cand_dir, llm=llm, log=log)
            if down and not cands:
                llm_waits += 1
                if llm_waits > max_llm_waits: log('模型通路长时间不可用，停止'); return 'llm_down'
                log(f'llm down, wait {wait_s}s ({llm_waits}/{max_llm_waits})'); sleep(wait_s); continue
            llm_waits = 0
            a = sch.load()
            tried = set(a['trials']) | {q['hash'] for q in a['queue']}
            pick = P.pick_diverse(cands, tried, slots - busy)
            if not offline:
                for c in pick:
                    ok, why = sch.enqueue(c, arch=a)
                    if not ok: log('enqueue refused', c['hash'], why)
                sch.save(a)
            with open(os.path.join(study.work_root, 'campaign.log'), 'a', encoding='utf-8') as f:
                f.write(json.dumps(dict(round=rnd, proposed=len(cands), picked=[c['hash'] for c in pick], offline=offline,
                                        t=time.time()), ensure_ascii=False) + '\n')
            rnd += 1
            if offline: continue
            sch.tick()
        if rnd >= rounds and sch.idle():
            return 'done'
        if offline and rnd >= rounds: return 'done'
        if max_ticks and ticks >= max_ticks: return 'max_ticks'
        sleep(wait_s if busy >= slots or rnd >= rounds else 1)
