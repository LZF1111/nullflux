#!/usr/bin/env python3
"""Swarm-herding figures.

  swarm_figs.py <phase_map.json> <swarm_p1_dir> <out_dir>

fig_phase   controllability map: feedback gain over area share and advantage over the best open
     loop, settling speed x target box (offline surrogate, 3 seeds)
fig_live    live-CFD fraction in the corner box vs time, mean +- sd over seeds, per controller and plant
fig_snap    particle snapshots of one feedback run and one open-loop run at 0 / 15 / 30 / 60 s
"""
import glob, json, os, sys
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

plt.rcParams.update({'font.size': 8, 'font.family': ['Microsoft YaHei', 'DejaVu Sans'], 'axes.unicode_minus': False,
'savefig.dpi': 300, 'savefig.bbox': 'tight', 'axes.linewidth': 0.6})
INK, CLAY, SLATE, OLIVE, MUTE = '#141413', '#d97757', '#6a9bcc', '#788c5d', '#8a877f'
BOX_ORDER = ['BL', 'BR', 'BC', 'WL', 'WR', 'C', 'TL', 'TR']
BOX_NAME = dict(BL='左下角', BR='右下角', BC='底部中间', WL='左壁中段', WR='右壁中段', C='中心', TL='左上角', TR='右上角')
CTRL = [('feedback', '颗粒群反馈', CLAY), ('PLCR1', '最优周期开环 L→C→R 1 s', SLATE), ('LR2', '周期 L↔R 2 s', OLIVE),
        ('L', '固定 L', MUTE)]


def save(fig, out, name):
    os.makedirs(out, exist_ok=True)
    for ext in ('png', 'pdf'):
        fig.savefig(os.path.join(out, f'{name}.{ext}'))
    plt.close(fig)


def fig_phase(pm, out):
    T = pm['table']; ws = pm['ws']
    def grid(key):
        return np.array([[next(r for r in T if r['box'] == b and abs(r['ws'] - w) < 1e-9)[key] for w in ws] for b in BOX_ORDER])
    fb = np.maximum(grid('gain_fb'), grid('gain_fb2'))
    op = grid('gain_open')
    adv = fb / op
    fig, axs = plt.subplots(1, 3, figsize=(7.2, 2.6), sharey=True)
    for ax, M, title, cm, vmax in ((axs[0], op, '最优开环 / 面积占比', 'Blues', 12), (axs[1], fb, '反馈 / 面积占比', 'Oranges', 12),
                              (axs[2], adv, '反馈 / 最优开环', 'RdBu_r', None)):
        if vmax:
            im = ax.imshow(M, cmap=cm, vmin=0, vmax=vmax, aspect='auto')
        else:
            im = ax.imshow(np.log2(M), cmap=cm, vmin=-1, vmax=1, aspect='auto')
        for i in range(M.shape[0]):
            for j in range(M.shape[1]):
                ax.text(j, i, f'{M[i, j]:.1f}', ha='center', va='center', fontsize=5.5,
                    color='w' if (vmax and M[i, j] > 0.6 * vmax) else INK)
        ax.set_xticks(range(len(ws))); ax.set_xticklabels([f'{w * 100:g}' for w in ws])
        ax.set_xlabel('沉降速度 w_s [cm/s]'); ax.set_title(title, fontsize=8)
    axs[0].set_yticks(range(len(BOX_ORDER))); axs[0].set_yticklabels([BOX_NAME[b] for b in BOX_ORDER])
    save(fig, out, 'fig_phase')


def load_live(d):
    R = dict()
    for f in sorted(glob.glob(os.path.join(d, '*', 'swarm.json'))):
        j = json.load(open(f))
        name = os.path.basename(os.path.dirname(f))
        ctrl, plant, seed = name.rsplit('_', 2)
        if len(j['chunks']) < 120:
            continue
        R.setdefault((ctrl, plant), []).append(j)
    return R


def fig_live(R, out):
    fig, axs = plt.subplots(1, 2, figsize=(7.2, 2.5), sharey=True)
    for ax, plant, title in ((axs[0], 'base', '基线被控对象'), (axs[1], 'mt', '失配被控对象（Tomiyama 升力 + Burns 弥散）')):
        area = None
        for key, lab, col in CTRL:
            runs = R.get((key, plant), [])
            if not runs:
                continue
            t = np.array([c['t'] for c in runs[0]['chunks']])
            F = np.array([[c['frac'] for c in r['chunks']] for r in runs])
            m, s = F.mean(0), F.std(0)
            ax.plot(t, m * 100, color=col, lw=1.2, label=f'{lab}（n={len(runs)}）')
            ax.fill_between(t, (m - s) * 100, (m + s) * 100, color=col, alpha=0.18, lw=0)
            area = runs[0]['area_frac']
        if area:
            ax.axhline(area * 100, color=INK, lw=0.6, ls='--')
            ax.text(59, area * 100 + 0.8, '面积占比（均匀分布）', ha='right', fontsize=6, color=INK)
        ax.set_xlabel('t [s]'); ax.set_title(title, fontsize=8); ax.set_xlim(0, 60)
    axs[0].set_ylabel('左下角盒内颗粒比例 [%]')
    axs[0].legend(fontsize=6, frameon=False, loc='upper left')
    save(fig, out, 'fig_live')


def fig_snap(R, out):
    pick = [('feedback', '颗粒群反馈', CLAY), ('PLCR1', '最优周期开环', SLATE)]
    times = [0, 15, 30, 60]
    fig, axs = plt.subplots(2, 4, figsize=(7.2, 4.6), sharex=True, sharey=True)
    for row, (key, lab, col) in enumerate(pick):
        runs = R.get((key, 'base'), [])
        if not runs:
            continue
        j = runs[0]; b = j['box']
        for ax, tq in zip(axs[row], times):
            sn = min(j['snaps'], key=lambda s: abs(s['t'] - tq))
            ax.scatter(sn['x'], sn['y'], s=1.2, color=col, lw=0)
            ax.add_patch(Rectangle((b[0], b[2]), b[1] - b[0], b[3] - b[2], fill=False, ec=INK, lw=0.8, ls='--'))
            f = np.mean((np.array(sn['x']) >= b[0]) & (np.array(sn['x']) <= b[1]) & (np.array(sn['y']) >= b[2]) & (np.array(sn['y']) <= b[3]))
            ax.set_title(f'{lab}  t={sn["t"]:g} s  盒内 {f * 100:.0f}%', fontsize=6.5)
            ax.set_xlim(-0.15, 0.15); ax.set_ylim(0, 0.45); ax.set_aspect('equal')
            ax.set_xticks([-0.15, 0, 0.15]); ax.set_yticks([0, 0.15, 0.3, 0.45])
    save(fig, out, 'fig_snap')


def main():
    pm = json.load(open(sys.argv[1]))
    R = load_live(sys.argv[2])
    out = sys.argv[3]
    fig_phase(pm, out)
    fig_live(R, out)
    fig_snap(R, out)
    for (c, p), runs in sorted(R.items()):
        v = [np.mean([q['frac'] for q in r['chunks'][-10:]]) for r in runs]
        print(f'{c:9s} {p:4s} n={len(v)} last5s {np.mean(v) * 100:.1f} +- {np.std(v) * 100:.1f} %')
    print('figures ->', out)


if __name__ == '__main__':
    main()
