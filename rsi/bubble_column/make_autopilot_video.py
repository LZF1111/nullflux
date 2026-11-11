#!/usr/bin/env python3
"""Showcase video for the bubble-column autopilot.

  make_autopilot_video.py <dir> <out.mp4> [--left OL_mt] [--right CL_mt] [--preview t1,t2]

<dir> holds <case>.npz (export_frames.py) and <case>.json (autopilot.json) per case.
Scenes: title (4 s) -> task (5 s) -> side-by-side replay, open loop vs closed loop, real time
(30 s) -> result card (6 s). Measured CFD data only. --preview writes PNG frames at the given
replay times instead of a video.
"""
import argparse, json, os, subprocess, sys
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, FancyBboxPatch
from matplotlib.colors import LinearSegmentedColormap

FPS = 30
IVORY, INK, CLAY, SLATE, OLIVE, MUTE = '#faf9f5', '#141413', '#d97757', '#6a9bcc', '#788c5d', '#8a877f'
CMAP = LinearSegmentedColormap.from_list('gas', [IVORY, '#e8e6dc', '#9fb8d6', '#3d6a9e'])
CMAP.set_bad(IVORY)
MODE_NAME = {'L': '左区供气', 'C': '中区供气', 'R': '右区供气'}
plt.rcParams.update({'font.family': ['Microsoft YaHei', 'DejaVu Sans'], 'axes.unicode_minus': False})
X0, X1, H = -0.15, 0.15, 0.45


def load(d, name):
    z = np.load(os.path.join(d, name + '.npz'))
    j = json.load(open(os.path.join(d, name + '.json')))
    return dict(t=z['t'], alpha=z['alpha'], u=z['u'], v=z['v'], j=j, path=np.array(j['path']))


def mode_at(c, t):
    k = min(int(t / c['j']['chunk_s']), len(c['j']['modes']) - 1)
    return c['j']['modes'][k]


def hits_until(c, t):
    return [h for h in c['j']['hits'] if h['t'] <= t]


def new_fig():
    fig = plt.figure(figsize=(19.2, 10.8), dpi=100, facecolor=IVORY)
    return fig


def text(fig, x, y, s, size, color=INK, weight='normal', ha='left', **kw):
    fig.text(x, y, s, fontsize=size, color=color, weight=weight, ha=ha, va='center', **kw)


class Panel:
    def __init__(self, fig, rect, c, title, sub, accent):
        self.c, self.accent = c, accent
        ax = fig.add_axes(rect)
        ax.set_facecolor(IVORY)
        nx, ny = c['alpha'].shape[1:]
        xe = np.linspace(X0, X1, nx + 1); ye = np.linspace(0, ny * 0.005, ny + 1)
        self.ny_liq = int(round(0.47 / 0.005))
        self.im = ax.pcolormesh(xe, ye[:self.ny_liq + 1], np.ma.masked_greater(c['alpha'][0][:, :self.ny_liq].T, 0.5),
    cmap=CMAP, vmin=0, vmax=0.12, shading='flat')
        xc = X0 + (np.arange(nx) + 0.5) * 0.005; yc = (np.arange(ny) + 0.5) * 0.005
        sx, sy = slice(2, nx, 5), slice(2, int(0.44 / 0.005), 5)
        self.sx, self.sy = sx, sy
        X, Y = np.meshgrid(xc[sx], yc[sy], indexing='ij')
        self.q = ax.quiver(X, Y, c['u'][0][sx, sy], c['v'][0][sx, sy], color=INK, alpha=0.35,
                scale=6, width=0.0025, headwidth=3)
        for g, gx in c['j']['gate']['x'].items():
            w = c['j']['gate']['w']; gy = c['j']['gate']['y']
            r = Rectangle((gx - w, gy), 2 * w, H - gy, fc=CLAY if g == 'L' else OLIVE, alpha=0.13, ec='none')
            ax.add_patch(r)
            ax.text(gx, H + 0.012, ('左' if g == 'L' else '右') + '门', ha='center', fontsize=15,
                    color=CLAY if g == 'L' else OLIVE, weight='bold')
        self.trail, = ax.plot([], [], '-', color=accent, lw=2.2, alpha=0.75)
        self.dot, = ax.plot([], [], 'o', ms=15, mfc=accent, mec=INK, mew=1.5, zorder=5)
        self.zones = []
        for i, (a, b) in enumerate(((-0.15, -0.05), (-0.05, 0.05), (0.05, 0.15))):
            r = Rectangle((a + 0.004, -0.03), b - a - 0.008, 0.018, fc='#e8e6dc', ec='none', clip_on=False)
            ax.add_patch(r); self.zones.append(r)
        ax.plot([X0, X0, X1, X1], [H + 0.03, 0, 0, H + 0.03], color=INK, lw=2.5)
        ax.set_xlim(X0 - 0.005, X1 + 0.005); ax.set_ylim(-0.04, H + 0.04)
        ax.set_aspect('equal'); ax.axis('off')
        self.ax = ax
        x, y, w, h = rect
        text(fig, x + w / 2, y + h + 0.075, title, 30, weight='bold', ha='center')
        text(fig, x + w / 2, y + h + 0.035, sub, 17, color=MUTE, ha='center')
        self.info = fig.text(x + w / 2, y - 0.045, '', fontsize=20, ha='center', va='center', color=INK)
        self.score = fig.text(x + w + 0.012, y + h * 0.62, '', fontsize=64, ha='left', va='center',
            color=accent, weight='bold')
        fig.text(x + w + 0.012, y + h * 0.5, '次过门', fontsize=18, ha='left', va='center', color=MUTE)

    def update(self, t):
        c = self.c
        k = int(np.clip(np.searchsorted(c['t'], t) - 1, 0, len(c['t']) - 2))
        w = float(np.clip((t - c['t'][k]) / (c['t'][k + 1] - c['t'][k]), 0, 1))
        a = (1 - w) * c['alpha'][k] + w * c['alpha'][k + 1]
        self.im.set_array(np.ma.masked_greater(a[:, :self.ny_liq].T, 0.5).ravel())
        u = (1 - w) * c['u'][k] + w * c['u'][k + 1]; v = (1 - w) * c['v'][k] + w * c['v'][k + 1]
        self.q.set_UVC(u[self.sx, self.sy], v[self.sx, self.sy])
        P = c['path']; m = P[:, 0] <= t
        tail = P[m][-150:]
        if len(tail):
            self.trail.set_data(tail[:, 1], tail[:, 2]); self.dot.set_data([tail[-1, 1]], [tail[-1, 2]])
        md = mode_at(c, t)
        for i, r in enumerate(self.zones):
            r.set_facecolor(self.accent if 'LCR'[i] == md else '#e8e6dc')
        n = len(hits_until(c, t))
        self.score.set_text(str(n))
        self.info.set_text(f'当前模式：{MODE_NAME[md]}')


def card(fig, lines):
    for y, s, size, col, wt in lines:
        text(fig, 0.5, y, s, size, color=col, weight=wt, ha='center')


def frame_title():
    fig = new_fig()
    card(fig, [(0.60, '反应器里的自动驾驶', 64, INK, 'bold'),
        (0.48, '三区气体分布器 × 实时 CFD 闭环控制', 30, CLAY, 'normal'),
        (0.36, '鼓泡塔 0.30 × 0.45 m · twoPhaseEulerFoam 作为被控对象 · 每 0.5 s 决策一次', 20, MUTE, 'normal')])
    return fig


def frame_task(cases):
    fig = new_fig()
    m = cases[0]['j'].get('model') or {}
    card(fig, [(0.75, '任务：让示踪颗粒交替穿过左门、右门', 40, INK, 'bold'),
        (0.62, '执行器只有三个离散模式：全部气量给左区 / 中区 / 右区（总气量不变）', 24, INK, 'normal'),
        (0.53, '开环：按名义模型排好的固定时间表（左 3 s、右 3 s 交替），不看颗粒', 24, SLATE, 'normal'),
        (0.45, '闭环：相机读颗粒位置 → 过门即换目标；4 s 无进展则切中区 1 s 把颗粒"拨"出来', 24, CLAY, 'normal'),
        (0.32, f'被控对象换成与设计模型不同的闭合：升力 {m.get("lift", "无")} + 湍流弥散 {m.get("td", "无")}',
                22, MUTE, 'normal'),
        (0.25, '下面的画面全部来自真实 CFD：蓝色为气含率，箭头为液相速度', 20, MUTE, 'normal')])
    return fig


def frame_result(cases, labels, T):
    fig = new_fig()
    text(fig, 0.5, 0.82, '结果（同一被控对象、同样 %g s）' % T, 40, weight='bold', ha='center')
    for k, (c, lab, col) in enumerate(zip(cases, labels, (SLATE, CLAY))):
        x = 0.3 + 0.4 * k
        n = len(hits_until(c, T))
        text(fig, x, 0.62, lab, 28, ha='center', color=col, weight='bold')
        text(fig, x, 0.47, str(n), 120, ha='center', color=col, weight='bold')
        text(fig, x, 0.34, '次成功过门', 24, ha='center', color=MUTE)
        ts = [h['t'] for h in c['j']['hits']]
        if len(ts) > 1:
            text(fig, x, 0.27, f'平均每 {np.diff([0] + ts).mean():.1f} s 过一次门', 20, ha='center', color=MUTE)
    text(fig, 0.5, 0.13, '同一台设备、同一套执行器：差别只在于有没有用实时位置做反馈', 22, ha='center', color=INK)
    return fig


def rgb(fig):
    fig.canvas.draw()
    return np.asarray(fig.canvas.buffer_rgba())[:, :, :3].copy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir'); ap.add_argument('out')
    ap.add_argument('--left', default='OL_mt'); ap.add_argument('--right', default='CL_mt')
    ap.add_argument('--preview')
    a = ap.parse_args()
    cases = [load(a.dir, a.left), load(a.dir, a.right)]
    labels = ['开环：固定时间表', '闭环：实时反馈']
    T = float(min(c['t'][-1] for c in cases))

    fig = new_fig()
    panels = [Panel(fig, [0.07, 0.12, 0.30, 0.66], cases[0], labels[0], '按名义模型排好的时间表，不看颗粒', SLATE),
       Panel(fig, [0.55, 0.12, 0.30, 0.66], cases[1], labels[1], '每 0.5 s 读颗粒位置，再选模式', CLAY)]
    clock = fig.text(0.5, 0.95, '', fontsize=24, ha='center', va='center', color=INK, weight='bold')

    def replay(t):
        for p in panels:
            p.update(t)
        clock.set_text(f't = {t:5.1f} s   （实时 1×）')
        return rgb(fig)

    if a.preview:
        os.makedirs(a.out, exist_ok=True)
        for s in a.preview.split(','):
            plt.imsave(os.path.join(a.out, f'replay_{s}.png'), replay(float(s)))
        for name, f in (('title', frame_title()), ('task', frame_task(cases)), ('result', frame_result(cases, labels, T))):
            f.savefig(os.path.join(a.out, f'{name}.png'), facecolor=IVORY); plt.close(f)
        print('previews ->', a.out)
        return

    import imageio_ffmpeg
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    W, Hh = 1920, 1080
    proc = subprocess.Popen([ff, '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{Hh}', '-r', str(FPS),
   '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', a.out],
                stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def hold(f, sec):
        img = rgb(f); plt.close(f)
        for _ in range(int(sec * FPS)):
            proc.stdin.write(img.tobytes())

    hold(frame_title(), 4)
    hold(frame_task(cases), 6)
    n = int(T * FPS)
    for i in range(n + 1):
        proc.stdin.write(replay(i / FPS).tobytes())
    last = replay(T)
    for _ in range(FPS):
        proc.stdin.write(last.tobytes())
    plt.close(fig)
    hold(frame_result(cases, labels, T), 7)
    proc.stdin.close(); proc.wait()
    print('video ->', a.out)


if __name__ == '__main__':
    main()
