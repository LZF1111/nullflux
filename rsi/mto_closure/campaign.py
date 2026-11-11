"""无人值守 HL 闭合式搜索：LLM 读档案 → 写 closure.py → evaluator.submit → 回灌结果。纯标准库，Linux 直接跑。
环境变量: HL_API_URL (OpenAI 兼容 /v1/chat/completions 全路径) HL_API_KEY HL_MODEL
用法: python campaign.py --rounds 20 --run runs/r1
"""
import argparse, json, os, re, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evaluator as E
import mto_model as M

TASK = """你在为 DMTO（SAPO-34 甲醇制烯烃）流化床反应器写两个跨尺度闭合式，让同一套微型床动力学在不同尺度都预测准 C2H4/C3H6、各集总产物和积碳 wc。
已知失败模式：原文 TFM 用单一 wc（网格内均匀积碳）+ EMMS/bubbling 曳力，在 demo/commercial 尺度把 C2H4/C3H6 高估 >50%。
你要写一个 Python 文件，只能 import math，必须定义：
1) solids_age(s) -> [(weight, theta), ...]：催化剂停留龄分布，theta = t / tau_s（tau_s = 藏量/循环量）。物料守恒要求加权平均 theta = 1（±2%），1..400 个点。
2) contact_efficiency(s) -> float in [0.05, 1]：气固有效接触分率（气泡/空穴旁路、乳化相接触、流型切换对 HD 曳力修正的宏观效果）。
s 是物理特征字典（不含尺度名）：T, D, H, H_over_D, Ug, Umf, U_over_Umf, Re_p, Ar, Fr_D, tau_s, Gs_flux, wc_in, batch。
闭合式必须是物理特征的光滑函数，禁止按 D 或 T 的具体数值做查表/分段硬编码去对答案。
评估：在 micro/pilot/demo 上打分（loss = 2|ln ratio误差| + 集总 |ln| 误差均值 + wc 相对误差），commercial 封存不可见，用于最终外推检验。
接受规则：对当前冠军做 paired_t（三个尺度 loss 差值均值 >0.01 且 >1 个标准误，单尺度退步 ≤0.05）。另按行为（龄分布 CV × 接触效率随尺度的跨度）存 MAP-Elites 格。
只输出一个 ```python 代码块，前面用 ≤5 行说明物理假设。"""


def call_llm(messages):
    url, key, model = os.environ['HL_API_URL'], os.environ.get('HL_API_KEY', ''), os.environ.get('HL_MODEL', 'gpt-4o')
    body = json.dumps({'model': model, 'messages': messages, 'temperature': 0.7, 'max_tokens': 4000}).encode()
    req = urllib.request.Request(url, body, {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())['choices'][0]['message']['content']
        except Exception as e:
            if attempt == 2: raise
            time.sleep(5 * (attempt + 1))


def context(arc):
    s = arc.s
    lines = ['## 基线（单一 wc 均场，等价原文 TFM 的处理）']
    for sc, v in E.baselines().items():
        if sc in E.HOLDOUT: continue
        m = v['meanfield']
        lines.append(f"{sc}: ratio={m['ratio']:.3f} (exp {m['ratio_exp']:.3f})  wc={m['wc']:.2f} (exp {m['wc_exp']})  loss={m['loss']:.3f}")
    lines.append('\n## 各尺度特征')
    for sc in E.TRAIN:
        f = M.features(sc)
        lines.append(f"{sc}: " + ', '.join(f"{k}={f[k]:.4g}" for k in ('D', 'H_over_D', 'Ug', 'U_over_Umf', 'Re_p', 'Fr_D', 'tau_s', 'T') if isinstance(f[k], (int, float))))
    if s['champion']:
        c = s['champion']
        lines.append(f"\n## 当前冠军 {c['hash']} (cell {c['cell']}, loss {c['loss']:.4f})")
        lines.append(open(c['path'], encoding='utf-8').read())
        for sc, v in c['scales'].items():
            lines.append(f"{sc}: ratio={v['ratio']:.3f}/{v['ratio_exp']:.3f} wc={v['wc']:.2f}/{v['wc_exp']} loss={v['loss']:.3f}")
    if s['cells']:
        lines.append('\n## MAP-Elites 格（cell: hash loss）  空格 = 未探索的行为，鼓励去填')
        for cell, e in sorted(s['cells'].items()): lines.append(f"{cell}: {e['hash']} {e['loss']:.4f}")
    if s['history']:
        lines.append('\n## 最近 8 次提交')
        for h in s['history'][-8:]: lines.append(json.dumps(h, ensure_ascii=False))
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rounds', type=int, default=10)
    ap.add_argument('--run', default='runs/default')
    ap.add_argument('--seeds', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'seeds'))
    a = ap.parse_args()
    arc = E.Archive(a.run)
    cand_dir = os.path.join(a.run, 'candidates'); os.makedirs(cand_dir, exist_ok=True)
    if not arc.s['history']:
        for f in sorted(os.listdir(a.seeds)):
            if f.endswith('.py'):
                r = arc.submit(os.path.join(a.seeds, f)); print('seed', f, r['cell'], round(r['loss'], 4), r['accepted'])
    last_err = ''
    for rnd in range(a.rounds):
        msgs = [{'role': 'system', 'content': TASK}, {'role': 'user', 'content': context(arc) + (f'\n\n## 上一个候选失败\n{last_err}' if last_err else '')}]
        reply = call_llm(msgs)
        m = re.search(r'```python\n(.*?)```', reply, re.S)
        if not m: last_err = '未找到 ```python 代码块'; print(rnd, last_err); continue
        path = os.path.join(cand_dir, f'c{len(arc.s["history"]):04d}.py')
        open(path, 'w', encoding='utf-8').write(m.group(1))
        try:
            r = arc.submit(path); last_err = ''
            print(rnd, os.path.basename(path), r['cell'], round(r['loss'], 4), 'ACCEPT' if r['accepted'] else 'reject', r['test'])
        except Exception as e:
            last_err = f'{type(e).__name__}: {e}'; print(rnd, 'invalid', last_err)
    c = arc.s['champion']
    print('champion', c and (c['hash'], round(c['loss'], 4), c['path']))


if __name__ == '__main__':
    main()
