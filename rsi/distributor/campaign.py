#!/usr/bin/env python3
"""分布器 RSI 无人值守循环：LLM 读档案（不含封存量）→ 写 layout(ctx) 候选 → 离线 check → 代理排序 →
只把代理前 K 个送 CFD（rsi.py submit）→ 每 3 个 CFD 结果回标一次代理 → 下一轮。
环境变量: HL_API_URL（OpenAI 兼容 /v1/chat/completions 全路径）HL_API_KEY HL_MODEL
用法: python3 campaign.py --rounds 6 --per-round 4 --cfd-per-round 1 [--offline]
--offline 只生成和筛选候选，不跑 CFD（合同未批准时用）。"""
import argparse, json, os, re, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import layout_eval as L
import rsi as R

TASK = """你在为 Lu 2016 中试 DMTO 反应器设计"等效"多孔分布板布孔，使 CFD 在分布板上方 Z=0.06/0.1 m 的
C2H4 y=0 径向分布（÷壁值）贴近原文 Fig.12b。原文只给了开孔率 5 %，孔数、孔径、布孔都未知。
现状：当前 211 孔、d≈3.9 mm 的均匀布孔，Z=0.06 m 的 min/壁 ≈0.96，原文约 0.49（凹陷浅很多），反应完成也偏早。
物理假设方向（可推翻）：孔少而大 → 单孔射流更强、穿透更深（Merry 关联 L_jet）→ 射流芯与孔间区差异更大 → 凹陷更深；
布孔的径向位置决定谷位（原文谷位约 x/R = −0.3 和 +0.6，左右不对称）。
写一个 Python 文件，只能 import math，定义 layout(ctx) -> [(x_m, y_m, d_mm), ...]。
ctx 字段：R_R, R_M（环形区内外半径 m）, phi=0.05, u_hole, h_plate_mm, n_min, n_max, d_min_mm, d_max_mm, ligament_min_mm, edge_margin_mm。
硬约束（违反即无效）：孔全部在 R_R..R_M 环内且离边 ≥ edge_margin；孔间筋 ≥ ligament_min；孔数在 [n_min, n_max]；
孔径在 [d_min, d_max] 且不小于网格可分辨尺寸；总开孔面积 = phi·环面积（评估器会统一缩放孔径，缩放超过 ±15 % 视为没按 5 % 设计）。
不能用布孔之外的任何手段（不能改进料、物性、开孔率）。允许非对称、非均匀孔径。
评分：loss = Z=0.06 与 0.1 m 两条线对原文点的 RMSE 均值；还要求出口 KPI 偏离原文 CFD <1 %、Z=0.4 m 保持平坦。
接受规则：比当前冠军低的量必须超过 2 倍统计噪声。另按（孔数档 × 平均半径档）存 MAP-Elites 格，鼓励填空格。
只输出一个 ```python 代码块，前面用 ≤5 行说明物理假设。"""


def call_llm(messages):
    url, key, model = os.environ['HL_API_URL'], os.environ.get('HL_API_KEY', ''), os.environ.get('HL_MODEL', 'claude-opus-5-5')
    body = json.dumps({'model': model, 'messages': messages, 'temperature': 0.8, 'max_tokens': 4000}).encode()
    req = urllib.request.Request(url, body, {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())['choices'][0]['message']['content']
        except Exception:
            if attempt == 4: raise
            time.sleep(30 * (attempt + 1))


CODE_RE = re.compile(r'```(?:python|py)?[ \t]*\r?\n(.*?)```', re.S)


def extract_code(reply):
    m = CODE_RE.search(reply or '')
    return m.group(1) if m else None


def propose(arch, n, last_err, cand_dir, llm=None):
    """返回 (候选, last_err, llm_down)。模型通路故障不算候选错误，也不让整个无人值守循环崩掉。"""
    llm = llm or call_llm
    out = []; llm_down = False
    for k in range(n):
        ctx = R.context_text(arch)
        note = f'\n\n## 上一个候选的问题\n{last_err}' if last_err else ''
        try:
            reply = llm([{'role': 'system', 'content': TASK}, {'role': 'user', 'content': ctx + note + f'\n\n（本轮第 {k + 1}/{n} 个，请与前面的候选在行为格上不同）'}])
        except Exception as e:
            print('llm unavailable:', f'{type(e).__name__}: {e}'[:300], flush=True); llm_down = True; break
        code = extract_code(reply)
        if code is None: last_err = '未找到 ```python 代码块'; continue
        path = os.path.join(cand_dir, f'c{int(time.time())}_{k}.py')
        with open(path, 'w', encoding='utf-8') as f: f.write(code)
        try:
            r = L.check(path)
        except Exception as e:
            last_err = f'{type(e).__name__}: {e}'; print('invalid', os.path.basename(path), last_err); continue
        if not r['ok']: last_err = '; '.join(r['violations'][:3]); print('violates', os.path.basename(path), last_err); continue
        r['surrogate'] = R.surrogate_for(r, arch); last_err = ''
        out.append(r); print('ok', os.path.basename(path), r['cell'], f"n={r['features']['n_holes']}", f"sur={r['surrogate']:.4f}")
    return out, last_err, llm_down


def pick_diverse(cands, tried, k):
    """去掉已试过的，按代理分排序，同一行为格只取一个；格子不够时再用剩下的补足。"""
    cands = sorted([c for c in cands if c['hash'] not in tried], key=lambda c: c['surrogate'])
    seen, first, rest = set(), [], []
    for c in cands:
        (rest if c['cell'] in seen else first).append(c); seen.add(c['cell'])
    return (first + rest)[:k]


def submit_with_wait(path, wait_s, max_waits, sleep=time.sleep):
    """核不够时等别的求解结束再提交，不把整个循环退出；合同/对照问题仍立即停止。"""
    for i in range(max_waits + 1):
        p = subprocess.run([sys.executable, os.path.join(HERE, 'rsi.py'), 'submit', path], capture_output=True, text=True)
        print(p.stdout[-1500:] or p.stderr[-1500:], flush=True)
        if p.returncode == 0 or '核不够' not in p.stderr: return p
        if i < max_waits: print(f'cores busy, wait {wait_s}s ({i + 1}/{max_waits})', flush=True); sleep(wait_s)
    return p


def n_done(arch):
    return sum(1 for t in arch['trials'].values() if t.get('metrics_visible', {}).get('loss_fig12b') is not None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rounds', type=int, default=6); ap.add_argument('--per-round', type=int, default=4)
    ap.add_argument('--cfd-per-round', type=int, default=1); ap.add_argument('--offline', action='store_true')
    ap.add_argument('--wait-s', type=int, default=600); ap.add_argument('--max-waits', type=int, default=144)
    a = ap.parse_args()
    cand_dir = os.path.join(R.ROOT, 'candidates'); os.makedirs(cand_dir, exist_ok=True)
    last_err = ''; calibrated_at = n_done(R.load_arch()); rnd = 0; llm_waits = 0
    while rnd < a.rounds:
        arch = R.load_arch()
        cands, last_err, llm_down = propose(arch, a.per_round, last_err, cand_dir)
        if llm_down and not cands:
            # 模型通路断了：本轮不算，等通路恢复，不浪费轮次
            llm_waits += 1
            if llm_waits > a.max_waits: sys.exit('模型通路长时间不可用，停止')
            print(f'llm down, wait {a.wait_s}s ({llm_waits}/{a.max_waits})', flush=True); time.sleep(a.wait_s); continue
        llm_waits = 0
        pick = pick_diverse(cands, set(arch['trials']), a.cfd_per_round)
        log = dict(round=rnd, proposed=len(cands), picked=[c['hash'] for c in pick], t=time.time())
        with open(os.path.join(R.ROOT, 'campaign.log'), 'a', encoding='utf-8') as f: f.write(json.dumps(log, ensure_ascii=False) + '\n')
        rnd += 1
        if a.offline: print('offline round', rnd - 1, log); continue
        for c in pick:
            p = submit_with_wait(c['path'], a.wait_s, a.max_waits)
            if p.returncode != 0 and ('核不够' in p.stderr or '未批准' in p.stderr or '对照' in p.stderr): sys.exit(p.stderr.strip())
        done = n_done(R.load_arch())
        # 每新增 3 个 CFD 结果回标一次（没有新结果的轮次不重复回标）
        if done >= 3 and done - calibrated_at >= 3:
            subprocess.run([sys.executable, os.path.join(HERE, 'rsi.py'), 'calibrate']); calibrated_at = done
        # 每轮结束刷新出版风格报告图（report/rsi_report.png/pdf）
        subprocess.run([sys.executable, os.path.join(HERE, 'rsi.py'), 'report'], capture_output=True, text=True)
    print(subprocess.run([sys.executable, os.path.join(HERE, 'rsi.py'), 'status'], capture_output=True, text=True).stdout)


if __name__ == '__main__':
    main()
