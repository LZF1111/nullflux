#!/usr/bin/env python3
"""Paper figures from runs/dataset.json + inverse/dynamic outputs.

  figures.py <runs_dir>  ->  <runs_dir>/fig/*.png|pdf
Fig 1  mean liquid flow (streamlines + |u|) for 6 representative static configs
Fig 2  x at checkpoints over the simplex (ternary maps) + GPR leave-one-out parity
Fig 3  inverse solutions: target vs model vs CFD-validation paths; near-optimal sets on the simplex
Fig 4  dynamic schedule (zigzag): schedule bar + path, static optimum for comparison
"""
import glob, json, os, sys
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.tri as mtri

HERE = os.path.dirname(os.path.abspath(__file__))
C = json.load(open(os.path.join(HERE, 'contract.json'), encoding='utf-8'))
H_LIQ = C['geometry']['H_liq_m']

plt.rcParams.update({'font.size': 8, 'font.family': 'DejaVu Sans', 'axes.linewidth': 0.6,
       'savefig.dpi': 300, 'savefig.bbox': 'tight'})


def tern(f):
    """barycentric (left, centre, right) -> 2D (centre at the top)."""
    f = np.atleast_2d(f)
    return f[:, 2] + 0.5 * f[:, 1], np.sqrt(3) / 2 * f[:, 1]


def tern_axes(ax):
    ax.plot([0, 1, 0.5, 0], [0, 0, np.sqrt(3) / 2, 0], 'k-', lw=0.6)
    ax.text(-0.04, -0.05, 'left', ha='right', fontsize=7)
    ax.text(1.04, -0.05, 'right', ha='left', fontsize=7)
    ax.text(0.5, np.sqrt(3) / 2 + 0.04, 'centre', ha='center', fontsize=7)
    ax.set_aspect('equal'); ax.axis('off')


def save(fig, d, name):
    os.makedirs(d, exist_ok=True)
    for ext in ('png', 'pdf'):
        fig.savefig(os.path.join(d, f'{name}.{ext}'))
    plt.close(fig)


def fig1(data, out):
    pick = ['L6_222', 'L6_600', 'L6_006', 'L6_060', 'L6_303', 'L6_411']
    runs = {d['id']: d for d in data}
    pick = [p for p in pick if p in runs][:6]
    fig, axs = plt.subplots(1, len(pick), figsize=(7.2, 2.6), sharey=True)
    for ax, pid in zip(np.atleast_1d(axs), pick):
        d = runs[pid]; mf = d['mean_field']
        nx, ny, dx, x0 = mf['nx'], mf['ny'], mf['dx'], mf['x0']
        u, v = np.array(mf['u']).T, np.array(mf['v']).T
        xc = x0 + (np.arange(nx) + 0.5) * dx; yc = (np.arange(ny) + 0.5) * dx
        m = yc < H_LIQ
        sp = np.hypot(u, v)[m]
        im = ax.pcolormesh(xc, yc[m], sp, cmap='viridis', vmin=0, vmax=0.3, shading='auto')
        ax.streamplot(xc, yc[m], u[m], v[m], color='w', linewidth=0.4, density=0.8, arrowsize=0.5)
        z = d['params']['zones']
        ax.set_title('Ug = ' + '/'.join(f'{q * 100:.1f}' for q in z) + ' cm/s', fontsize=6.5)
        ax.set_aspect('equal'); ax.set_xticks([-0.15, 0, 0.15])
        for s in d['stats']:
            if s['x_mean'] is not None:
                ax.plot(s['x_mean'], s['y_m'], 'o', ms=3, mfc='#e74c3c', mec='w', mew=0.4)
    np.atleast_1d(axs)[0].set_ylabel('y [m]')
    fig.colorbar(im, ax=axs, shrink=0.8, label='|u_l| [m/s]')
    save(fig, out, 'fig1_static_flows')


def fig2(data, out, fitrep):
    F = np.array([np.array(d['params']['zones']) / sum(d['params']['zones']) for d in data])
    X = np.array([[s['x_mean'] if s['x_mean'] is not None else np.nan for s in d['stats']] for d in data])
    tx, ty = tern(F)
    tri = mtri.Triangulation(tx, ty)
    fig, axs = plt.subplots(1, 4, figsize=(7.2, 1.9))
    for c, ax in enumerate(axs):
        ok = ~np.isnan(X[:, c])
        t2 = mtri.Triangulation(tx[ok], ty[ok])
        cs = ax.tricontourf(t2, X[ok, c], levels=np.linspace(-0.15, 0.15, 13), cmap='RdBu_r')
        ax.plot(tx, ty, 'k.', ms=1.5)
        tern_axes(ax)
        ax.set_title(f'x at y = {C["targets"]["center"]["y_m"][c]} m', fontsize=7)
    fig.colorbar(cs, ax=axs, shrink=0.8, label='x [m]')
    save(fig, out, 'fig2_simplex_maps')


def fig3(out, runs_dir):
    files = sorted(glob.glob(os.path.join(runs_dir, 'inverse_*.json')))
    if not files:
        return
    fig, axs = plt.subplots(1, len(files), figsize=(1.9 * len(files), 2.4), sharey=True)
    for ax, f in zip(np.atleast_1d(axs), files):
        r = json.load(open(f)); y = C['targets']['center']['y_m']
        ax.plot(r['target_x'], y, 'k--o', ms=3, lw=0.8, label='target')
        ax.plot(r['gpr_pred_x'], y, 's-', ms=3, lw=0.8, color='#2980b9', label='inverse (GPR)')
        val = os.path.join(runs_dir, f'V_{r["target"]}', 'traj.json')
        if os.path.exists(val):
            st = json.load(open(val))['stats']
            ax.errorbar([s['x_mean'] for s in st], y, xerr=[s['x_std'] for s in st], fmt='o', ms=3,
          color='#c0392b', lw=0.8, capsize=2, label='CFD check')
        ax.set_xlim(-0.15, 0.15); ax.set_title(r['target'], fontsize=7)
        ax.set_xlabel('x [m]')
    np.atleast_1d(axs)[0].set_ylabel('y [m]'); np.atleast_1d(axs)[0].legend(fontsize=6, frameon=False)
    save(fig, out, 'fig3_inverse')


def fig4(out, runs_dir):
    f = os.path.join(runs_dir, 'dynamic_zigzag.json')
    if not os.path.exists(f):
        return
    r = json.load(open(f))
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(5.2, 2.6), gridspec_kw=dict(width_ratios=[1.3, 1]))
    sch = r['schedule']; tend = max(p[0] for p in r['path'])
    for k, s in enumerate(sch):
        t1 = sch[k + 1]['t'] if k + 1 < len(sch) else tend
        bottom = 0
        for q, col in enumerate(('#3498db', '#95a5a6', '#e67e22')):
            a1.bar(s['t'], s['f'][q], width=t1 - s['t'], bottom=bottom, align='edge', color=col, edgecolor='w', lw=0.3)
            bottom += s['f'][q]
    a1.set_xlabel('t after release [s]'); a1.set_ylabel('gas fraction per zone')
    a1.legend(['left', 'centre', 'right'], fontsize=6, frameon=False, ncol=3, loc='upper center', bbox_to_anchor=(0.5, 1.15))
    P = np.array(r['path'])
    y = C['targets']['center']['y_m']
    a2.plot(P[:, 1], P[:, 2], '-', color='#2c3e50', lw=1, label='dynamic (model)')
    a2.plot(r['target_x'], y, 'k--o', ms=3, lw=0.8, label='target')
    val = os.path.join(runs_dir, 'V_dyn_zigzag', 'traj.json')
    if os.path.exists(val):
        st = json.load(open(val))['stats']
        a2.errorbar([s['x_mean'] for s in st], y, xerr=[s['x_std'] for s in st], fmt='o', ms=3,
                    color='#c0392b', capsize=2, lw=0.8, label='CFD check')
    a2.set_xlim(-0.15, 0.15); a2.set_xlabel('x [m]'); a2.set_ylabel('y [m]')
    a2.set_title(f'RMSE static {r["static_best_rmse_m"] * 100:.1f} cm / dynamic {r["dynamic_rmse_m"] * 100:.1f} cm', fontsize=6.5)
    a2.legend(fontsize=6, frameon=False)
    save(fig, out, 'fig4_dynamic')


def main():
    runs_dir = sys.argv[1]
    data = json.load(open(os.path.join(runs_dir, 'dataset.json')))
    data = [d for d in data if d['id'].startswith('L')]
    fitp = os.path.join(runs_dir, 'surrogate_fit.json')
    out = os.path.join(runs_dir, 'fig')
    fig1(data, out)
    fig2(data, out, json.load(open(fitp)) if os.path.exists(fitp) else None)
    fig3(out, runs_dir)
    fig4(out, runs_dir)
    print('figures ->', out)


if __name__ == '__main__':
    main()
