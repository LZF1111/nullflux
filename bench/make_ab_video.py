#!/usr/bin/env python3
"""A/B 对比视频：左 CFDriver4MTO，右 OpenCode，同一条墙钟时间轴。
数据只来自录制：events.jsonl（事件流）、samples.jsonl（30 s 服务器采样）、meta.json、judge.json。
每一帧：顶部时钟与倍速；每边一栏，显示已用时间、工具调用数、token、报错/重试次数、求解进程与 Time，
以及最近 12 条事件（时间戳 + 摘要）；片尾一张判定结果表。
用法: make_ab_video.py RUN_CFD RUN_OC OUT.mp4 [--fps 10 --seconds 90]"""
import argparse, json, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import imageio.v2 as imageio

W, H = 1920, 1080
BG, PANEL, FG, MUT, ACC, OK, BAD = (12, 13, 16), (22, 24, 30), (236, 238, 242), (140, 146, 160), (245, 197, 66), (63, 181, 168), (255, 138, 91)


def font(sz, mono=False):
    for f in (['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 'C:/Windows/Fonts/consola.ttf'] if mono else
              ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'C:/Windows/Fonts/msyh.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']):
        if os.path.exists(f): return ImageFont.truetype(f, sz)
    return ImageFont.load_default()


F_T, F_B, F_S, F_M = font(40), font(26), font(21), font(19, True)


def jl(p):
    out = []
    if os.path.exists(p):
        for line in open(p, encoding='utf-8', errors='replace'):
            try: out.append(json.loads(line))
            except ValueError: pass
    return out


def summarize_oc(e):
    """OpenCode --format json 事件 → (类别, 文本, token 增量)"""
    t = e.get('type'); p = e.get('part') or {}
    if t == 'tool_use' or p.get('type') == 'tool':
        st = (p.get('state') or {}); tool = p.get('tool', '?'); inp = st.get('input') or {}
        arg = inp.get('command') or inp.get('filePath') or inp.get('pattern') or ''
        kind = 'error' if st.get('status') == 'error' else 'tool'
        return kind, f'{tool} {str(arg)[:70]}', 0
    if t == 'text' and p.get('text'): return 'text', p['text'].strip().replace('\n', ' ')[:90], 0
    if t == 'step_finish':
        tok = (p.get('tokens') or {}); n = (tok.get('input') or 0) + (tok.get('output') or 0) + ((tok.get('cache') or {}).get('read') or 0)
        return None, '', n
    if t == 'error': return 'error', str(e.get('error') or e)[:90], 0
    return None, '', 0


def summarize_cfd(e):
    t = e.get('type')
    if t == 'tool_call': return 'tool', f"{e.get('name')} {json.dumps(e.get('args'), ensure_ascii=False)[:70]}", 0
    if t == 'tool_result' and ('error' in str(e.get('result'))[:200].lower()): return 'error', f"{e.get('name')} 返回错误", 0
    if t == 'assistant_end' and e.get('text'): return 'text', e['text'].strip().replace('\n', ' ')[:90], 0
    if t == 'error': return 'error', str(e.get('message'))[:90], 0
    if t in ('agent_recovering', 'recovery', 'retry'): return 'retry', str(e.get('message') or t)[:90], 0
    if t == 'usage':
        u = e.get('usage') or {}; return None, '', (u.get('prompt_tokens') or 0) + (u.get('completion_tokens') or 0)
    return None, '', 0


def load_side(run, summarize, label):
    meta = json.load(open(os.path.join(run, 'meta.json')))
    evs = []
    tok = 0
    for r in jl(os.path.join(run, 'events.jsonl')):
        k, s, dt = summarize(r['e']); tok += dt
        evs.append(dict(t=r['t'], kind=k, text=s, tok=tok))
    judge = {}
    try: judge = json.load(open(os.path.join(run, 'judge.json')))
    except Exception: pass
    return dict(label=label, meta=meta, ev=evs, samples=jl(os.path.join(run, 'samples.jsonl')), judge=judge,
                t0=meta['t0'], t1=meta.get('t1') or (evs[-1]['t'] if evs else meta['t0']))


def state_at(side, t):
    ev = [e for e in side['ev'] if e['t'] <= t]
    n = lambda k: sum(1 for e in ev if e['kind'] == k)
    sm = [s for s in side['samples'] if s['t'] <= t]
    return dict(el=max(0, min(t, side['t1']) - side['t0']), tools=n('tool'), errors=n('error'), retries=n('retry'),
                tok=ev[-1]['tok'] if ev else 0, last=[e for e in ev if e['kind']][-12:],
                procs=sm[-1]['procs'] if sm else 0, ftime=sm[-1]['time'] if sm else '', done=t >= side['t1'])


def hms(s): s = int(s); return f'{s // 3600:d}:{s % 3600 // 60:02d}:{s % 60:02d}'


def panel(d, x, side, st, t0):
    d.rounded_rectangle([x, 120, x + 920, 1040], 18, fill=PANEL)
    d.text((x + 30, 140), side['label'], font=F_T, fill=FG)
    d.text((x + 640, 152), '已完成' if st['done'] else '运行中', font=F_B, fill=OK if st['done'] else ACC)
    kv = [('已用时间', hms(st['el'])), ('工具调用', st['tools']), ('token', f"{st['tok'] / 1000:.0f} k"),
          ('报错', st['errors']), ('重试/恢复', st['retries']), ('求解进程', st['procs']), ('求解 Time', st['ftime'] or '—')]
    for i, (k, v) in enumerate(kv):
        cx, cy = x + 30 + (i % 4) * 220, 210 + (i // 4) * 90
        d.text((cx, cy), k, font=F_S, fill=MUT); d.text((cx, cy + 28), str(v), font=F_B, fill=FG)
    d.line([x + 30, 400, x + 890, 400], fill=(44, 48, 58), width=2)
    y = 420
    for e in st['last']:
        col = {'error': BAD, 'retry': ACC, 'tool': FG, 'text': MUT}.get(e['kind'], MUT)
        d.text((x + 30, y), hms(e['t'] - t0), font=F_M, fill=MUT)
        d.text((x + 140, y), e['text'][:62], font=F_M, fill=col); y += 48


def final_card(d, A, B):
    d.text((80, 80), 'T1 判定结果（脚本自动判定，不看模型自述）', font=F_T, fill=FG)
    rows = [('', A['label'], B['label'])]
    for k, f in [('通过', lambda s: '是' if s['judge'].get('passed') else '否'), ('St（判定脚本）', lambda s: f"{s['judge']['St']:.4f}" if s['judge'].get('St') is not None else '—'),
                 ('墙钟时间', lambda s: hms(s['t1'] - s['t0'])), ('工具调用', lambda s: sum(1 for e in s['ev'] if e['kind'] == 'tool')),
                 ('报错', lambda s: sum(1 for e in s['ev'] if e['kind'] == 'error')), ('token', lambda s: f"{(s['ev'][-1]['tok'] if s['ev'] else 0) / 1000:.0f} k"),
                 ('未通过原因', lambda s: s['judge'].get('reason') or '—')]:
        rows.append((k, str(f(A)), str(f(B))))
    for i, r in enumerate(rows):
        y = 180 + i * 90
        for j, c in enumerate(r):
            d.text((80 + j * 600, y), c[:40], font=F_B, fill=FG if i else MUT)
        d.line([80, y + 64, 1840, y + 64], fill=(44, 48, 58), width=1)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('cfd'); ap.add_argument('oc'); ap.add_argument('out')
    ap.add_argument('--fps', type=int, default=10); ap.add_argument('--seconds', type=float, default=90)
    a = ap.parse_args()
    A = load_side(a.cfd, summarize_cfd, 'CFDriver4MTO'); B = load_side(a.oc, summarize_oc, 'OpenCode')
    t0 = min(A['t0'], B['t0']); t1 = max(A['t1'], B['t1'])
    n = int(a.fps * a.seconds); speed = (t1 - t0) / a.seconds
    wr = imageio.get_writer(a.out, fps=a.fps, codec='libx264', quality=8, macro_block_size=8)
    for i in range(n):
        t = t0 + (t1 - t0) * i / max(1, n - 1)
        im = Image.new('RGB', (W, H), BG); d = ImageDraw.Draw(im)
        d.text((40, 40), f'同模型 A/B · T1 圆柱绕流 Re=100 · 墙钟 {hms(t - t0)} · {speed:.0f}× 延时', font=F_B, fill=FG)
        panel(d, 40, A, state_at(A, t), t0); panel(d, 960, B, state_at(B, t), t0)
        wr.append_data(np.asarray(im))
    im = Image.new('RGB', (W, H), BG); final_card(ImageDraw.Draw(im), A, B)
    for _ in range(a.fps * 8): wr.append_data(np.asarray(im))
    wr.close(); print(a.out, f'{n} frames, {speed:.1f}x')


if __name__ == '__main__':
    main()
