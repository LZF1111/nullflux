#!/usr/bin/env python3
"""Lu et al. 2016 (CES 143:341) pilot DMTO 3D: publication-style comparison with the paper.
Read-only on case results. Output: ~/mto_repro/compare/compare_paper.{png,pdf,md}, fig_fields.{png,pdf}.
Field panels use post_field exact polyhedral cuts (true snappy wall faces, no square-pixel staircase)."""
import json, os, sys, warnings
import numpy as np
warnings.filterwarnings('ignore')
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
sys.path.insert(0, os.path.expanduser('~/nullflux-test'))
import post_field as PF

R = os.path.expanduser('~/mto_repro'); OUT = os.path.join(R, 'compare'); os.makedirs(OUT, exist_ok=True)
CASE = os.path.join(R, 'cases', 'pilot3D'); T_MEAN = '118.817922'
J = lambda p: json.load(open(os.path.join(R, p)))
PF._style(plt)
plt.rcParams.update({'axes.titlesize': 9, 'axes.labelsize': 9, 'legend.fontsize': 7.5, 'legend.frameon': False,
                     'xtick.labelsize': 8, 'ytick.labelsize': 8, 'lines.linewidth': 1.2})
COL = dict(sim='#1f4e9c', simlight='#8fb3e0', paper='#c0392b', exp='#d68910', ok='#2e8b57')

PAPER = {'C2H4_C3H6': (1.2449, 1.2096), 'S_C2C3_pct': (77.60, 80.69), 'eta_MeOH_pct': (99.94, 99.97), 'wc_pct': (6.0, 5.655)}
TEX = {'C2H4_C3H6': r'$Y_{\mathrm{C_2H_4}}/Y_{\mathrm{C_3H_6}}$', 'S_C2C3_pct': r'$S_{\mathrm{C_2+C_3}}$',
       'eta_MeOH_pct': r'$\eta_{\mathrm{MeOH}}$', 'wc_pct': r'$w_\mathrm{c}$'}
FIG12B = {'0.06': {'x': [-1, -0.5, -0.3, 0, 0.05, 0.5, 0.6, 1], 'C2H4': [0.080, 0.064, 0.050, 0.068, 0.069, 0.044, 0.039, 0.080]},
          '0.1': {'x': [-1, -0.4, 0, 0.2, 0.6, 1], 'C2H4': [0.080, 0.080, 0.076, 0.076, 0.068, 0.080]},
          '0.4': {'x': [-1, 0, 1], 'C2H4': [0.080, 0.080, 0.080]}}

main = J('stab/kpi_blocks_main.json'); f10 = J('cases/pilot3D/fig10_post.json'); f12 = J('cases/pilot3D/fig12_post.json')
cold = J('cases/pilot3D/cold_check.json')
sim = {k: (main['z1'][k]['full'], main['z1'][k].get('ci95', 0)) for k in ('C2H4_C3H6', 'S_C2C3_pct', 'eta_MeOH_pct')}
sim['wc_pct'] = (f10['wc_alpha_weighted'], 0.0)
stab = {}
for lab, f in [('base np64', 'stab/kpi_blocks_pilot3D.json'), ('np32', 'stab/kpi_blocks_A_np32.json'),
               ('Co 0.25', 'stab/kpi_blocks_B_co025.json'), ('Co 0.6', 'stab/kpi_blocks_C_co06.json')]:
    if os.path.exists(os.path.join(R, f)): stab[lab] = J(f)


def tag(ax, s, dark=False):
    ax.text(0.03, 0.97, s, transform=ax.transAxes, ha='left', va='top', fontsize=9, fontweight='bold',
            color='w' if dark else 'k')


def field_panel(fig, ax, field, axis, pos, crop, label, cmap='viridis', vmin=None, vmax=None, shading='smooth', cbw=0.06):
    d = PF.slice_data(CASE, dict(time=T_MEAN, field=field, axis=axis, pos=pos, crop=crop, vmin=vmin, vmax=vmax))
    m = PF.draw_slice(ax, d, cmap=cmap, shading=shading)
    PF.colorbar(fig, m, ax, label, cax=ax.inset_axes([1.04, 0, cbw, 1]))
    return d


# ---------------- Figure 1: time-averaged fields ----------------
# 固定面板位置（英寸 → 比例），色标贴在各面板右侧，不让 colorbar 挤乱布局
FW, FH = 7.2, 5.4
fig = plt.figure(figsize=(FW, FH), dpi=300)
box = lambda l, b, w, h: fig.add_axes([l / FW, b / FH, w / FW, h / FH])
ax = box(0.55, 0.75, 4.45 * 0.30 / 1.65, 4.45)                 # (a) 主筒全高：宽高按 0.30×1.65 m 比例
field_panel(fig, ax, 'alpha.particlesMean', 'y', 0.0, dict(x0=-0.15, x1=0.15, y0=-0.3, y1=1.35),
            r'$\langle\alpha_\mathrm{s}\rangle$', cmap='cividis', cbw=0.12)
ax.set_xlabel('$x$ [m]'); ax.set_ylabel('$z$ [m]'); ax.set_title('(a)', fontsize=8, loc='left', pad=3)
ax = box(2.6, 3.05, 2.05 * 0.261 / 0.46, 2.05)                # (b) 分布板上方 0–0.45 m
field_panel(fig, ax, 'C2H4.gasMean', 'y', 0.0, dict(x0=-0.1305, x1=0.1305, y0=-0.01, y1=0.45),
            r'$\langle Y_{\mathrm{C_2H_4}}\rangle$', cbw=0.07)
for z in (0.06, 0.1, 0.4):
    ax.axhline(z, color='w', lw=0.6, ls=(0, (3, 2))); ax.text(0.125, z + 0.007, f'$Z$ = {z:g} m', color='w', fontsize=6, ha='right')
ax.set_xlabel('$x$ [m]'); ax.set_ylabel('$z$ [m]'); ax.set_title('(b)', fontsize=8, loc='left', pad=3)
# (b) 右侧放说明文字，避免空白
fig.text(4.95 / FW, 4.2 / FH, 'Lu et al. (2016) pilot DMTO\n3D two-fluid model\nreproduction\n\n'
         r'time average 79.6–118.8 s' '\n' r'exact polyhedral cuts' '\n' r'black lines: walls', fontsize=6.5, va='center', color='0.25')
for i, (f, lab, cm, tg) in enumerate((('C2H4.gasMean', r'$\langle Y_{\mathrm{C_2H_4}}\rangle$', 'viridis', '(c)'),
                                     ('alpha.particlesMean', r'$\langle\alpha_\mathrm{s}\rangle$', 'cividis', '(d)'))):
    ax = box(2.55 + i * 2.45, 0.75, 1.5, 1.5)
    field_panel(fig, ax, f, 'z', 0.06, None, lab, cmap=cm, cbw=0.07)
    ax.axhline(0, color='w', lw=0.6, ls=(0, (3, 2)))
    ax.set_xlabel('$x$ [m]')
    if i == 0: ax.set_ylabel('$y$ [m]')
    else: ax.tick_params(labelleft=False)
    ax.set_title(f'{tg}  $Z$ = 0.06 m', fontsize=8, loc='left', pad=3)
fig.text(0.5, 0.15 / FH, r'(a) solids fraction on $y$ = 0; (b) C$_2$H$_4$ mass fraction above the distributor; '
         r'(c, d) cross-sections at $Z$ = 0.06 m, dashed: Fig. 12b sampling line.', ha='center', fontsize=6.5)
for ext in ('png', 'pdf'): fig.savefig(os.path.join(OUT, f'fig_fields.{ext}'), bbox_inches=None)
plt.close(fig)
# ---------------- Figure 2: quantitative comparison ----------------
fig, axs = plt.subplots(2, 3, figsize=(7.2, 4.9), dpi=300, gridspec_kw=dict(wspace=0.42, hspace=0.55))
# (a) outlet KPI deviation
ax = axs[0, 0]; ks = list(PAPER); x = np.arange(len(ks))
dc = [100 * (sim[k][0] / PAPER[k][1] - 1) for k in ks]; de = [100 * (sim[k][0] / PAPER[k][0] - 1) for k in ks]
ec = [100 * sim[k][1] / PAPER[k][1] for k in ks]; pc = [100 * (PAPER[k][1] / PAPER[k][0] - 1) for k in ks]
ax.axhspan(-1, 1, color=COL['ok'], alpha=0.12, lw=0)
ax.bar(x - 0.19, dc, 0.36, yerr=ec, capsize=1.5, error_kw=dict(lw=0.6), color=COL['sim'], label='vs paper CFD')
ax.bar(x + 0.19, de, 0.36, color=COL['exp'], label='vs experiment')
ax.scatter(x + 0.19, pc, marker='_', s=90, color='k', zorder=5, lw=1, label='paper CFD vs exp.')
ax.axhline(0, color='k', lw=0.5); ax.set_xticks(x); ax.set_xticklabels([r'C$_2^=$/C$_3^=$', r'$S_{\mathrm{C_2+C_3}}$', r'$\eta_{\mathrm{MeOH}}$', r'$w_\mathrm{c}$'], fontsize=7)
ax.set_ylabel('Deviation [%]'); ax.legend(loc='lower left', fontsize=6, handlelength=1.2); tag(ax, '(a)')
ax.tick_params(axis='x', which='minor', bottom=False, top=False)
# (b) numerical sensitivity
ax = axs[0, 1]
if stab:
    labs = list(stab); base = stab[labs[0]]['z1']
    for j, (k, mk) in enumerate((('C2H4_C3H6', 'o'), ('S_C2C3_pct', 's'), ('eta_MeOH_pct', '^'), ('hc_kg_h', 'D'))):
        v = [100 * (stab[l]['z1'][k]['full'] / base[k]['full'] - 1) for l in labs]
        e = [100 * stab[l]['z1'][k].get('ci95', 0) / base[k]['full'] for l in labs]
        ax.errorbar(np.arange(len(labs)) + 0.1 * (j - 1.5), v, yerr=e, fmt=mk, ms=3, capsize=1.5, lw=0.7, mfc='none',
                    label={'hc_kg_h': 'HC rate'}.get(k, TEX.get(k, k)))
    ax.set_xticks(range(len(labs))); ax.set_xticklabels(labs, fontsize=7, rotation=20)
    ax.tick_params(axis='x', which='minor', bottom=False, top=False)
    ax.axhline(0, color='k', lw=0.5); ax.set_ylabel('Deviation from base [%]'); ax.legend(fontsize=5.5, ncol=2, loc='upper left', bbox_to_anchor=(0, 0.9))
tag(ax, '(b)')
# (c) depression depth
ax = axs[0, 2]; zs = ['0.06', '0.1', '0.4']; x = np.arange(3)
ax.bar(x - 0.26, [f12['radial'][z]['line_min_over_wall'] for z in zs], 0.26, color=COL['sim'], label='this work, $y$=0 line')
ax.bar(x, [f12['radial'][z]['shape']['min_over_wall'] for z in zs], 0.26, color=COL['simlight'], label=r'this work, $\theta$-avg.')
ax.bar(x + 0.26, [f12['radial'][z]['paper_min_over_wall'] for z in zs], 0.26, color=COL['paper'], label='paper CFD')
ax.set_xticks(x); ax.set_xticklabels([f'$Z$={z}' for z in zs], fontsize=7); ax.set_ylim(0.4, 1.08)
ax.tick_params(axis='x', which='minor', bottom=False, top=False)
ax.set_ylabel(r'$Y_{\mathrm{C_2H_4}}$ min / wall'); ax.legend(fontsize=5.5, loc='lower right'); tag(ax, '(c)')
# (d-f) Fig.12b radial lines
for i, z in enumerate(zs):
    ax = axs[1, i]; r = f12['radial'][z]
    xl, yl = np.array(r['line_x']), np.array(r['line_C2H4']); wl = 0.5 * (yl[0] + yl[-1])
    p = FIG12B[z]; pw = p['C2H4'][0]
    ax.plot(xl, yl / wl, '-', color=COL['sim'], label='this work')
    ax.plot(p['x'], np.array(p['C2H4']) / pw, 'o--', color=COL['paper'], ms=3, mfc='w', lw=0.8, label='Lu et al. (2016)')
    ax.set_xlim(-1, 1); ax.set_ylim(0.4, 1.1); ax.set_xlabel('$x/R$'); tag(ax, f'({"def"[i]})')
    ax.text(0.97, 0.06, f'$Z$ = {z} m', transform=ax.transAxes, ha='right', fontsize=7.5)
    if i == 0: ax.set_ylabel(r'$Y_{\mathrm{C_2H_4}}/Y_{\mathrm{C_2H_4,wall}}$'); ax.legend(fontsize=6, loc='lower left', bbox_to_anchor=(0, 0.12))
for ext in ('png', 'pdf'): fig.savefig(os.path.join(OUT, f'compare_paper.{ext}'))
plt.close(fig)

# ---------------- Figure 3: axial profile (Fig.12a) ----------------
fig, ax = plt.subplots(figsize=(3.4, 3.0), dpi=300)
a = f12['axial']; z = np.array(a['z'])
for k, c, ls in (('MeOH', COL['paper'], '-'), ('C2H4', COL['sim'], '-'), ('C3H6', COL['ok'], '--')):
    ax.plot(np.array(a[k]), z, color=c, ls=ls, label={'MeOH': 'MeOH', 'C2H4': r'C$_2$H$_4$', 'C3H6': r'C$_3$H$_6$'}[k])
ax.axhline(f12['z_plateau99_m'], color=COL['sim'], ls=':', lw=0.8)
ax.text(0.98, f12['z_plateau99_m'] + 0.012, f"this work: 99 % plateau at {f12['z_plateau99_m']:.2f} m", fontsize=6.5, ha='right', transform=ax.get_yaxis_transform())
ax.axhline(0.2, color=COL['paper'], ls=(0, (1, 1.5)), lw=0.9)
ax.text(0.98, 0.212, 'paper: reaction complete below ~0.2 m', fontsize=6.5, ha='right', color=COL['paper'], transform=ax.get_yaxis_transform())
ax.set_ylim(-0.05, 0.6); ax.set_xlim(left=0); ax.set_xlabel('Cross-section mean mass fraction'); ax.set_ylabel('$z$ [m]')
ax.legend(loc='upper right')
for ext in ('png', 'pdf'): fig.savefig(os.path.join(OUT, f'fig_axial.{ext}'))
plt.close(fig)

# ---------------- table ----------------
rows = [('C2H4/C3H6', sim['C2H4_C3H6'][0], *PAPER['C2H4_C3H6']), ('S(C2+C3) %', sim['S_C2C3_pct'][0], *PAPER['S_C2C3_pct']),
        ('ηMeOH %', sim['eta_MeOH_pct'][0], *PAPER['eta_MeOH_pct']), ('wc %（≈初值，不作证据）', sim['wc_pct'][0], *PAPER['wc_pct'])]
md = ['| 量 | 本算例 | 实验 | 原文 CFD | 相对原文 CFD | 相对实验 | 原文 CFD 相对实验 |', '|---|---|---|---|---|---|---|']
for n, s, e, c in rows: md.append(f'| {n} | {s:.4g} | {e:.4g} | {c:.4g} | {100*(s/c-1):+.2f} % | {100*(s/e-1):+.2f} % | {100*(c/e-1):+.2f} % |')
md.append(f"| 冷态 Δp/床重 | {cold['dp_bed_Pa']/cold['dp_theory_Pa']:.3f} | — | ≈1 | {cold['dp_err_pct']:+.1f} % | — | — |")
for z in zs: md.append(f"| Fig.12b Z={z} m C2H4 min/壁 | {f12['radial'][z]['line_min_over_wall']:.3f} | — | {f12['radial'][z]['paper_min_over_wall']:.3f} | {100*(f12['radial'][z]['line_min_over_wall']/f12['radial'][z]['paper_min_over_wall']-1):+.1f} % | — | — |")
md.append(f"| Fig.12a 反应完成高度 | {f12['z_plateau99_m']:.2f} m | — | ≈0.2 m | 偏早 | — | — |")
if stab:
    md += ['', '数值敏感性（z=1.0 m，相对基准 np64）：', '', '| 算例 | C2H4/C3H6 | S % | ηMeOH % | 烃 kg/h |', '|---|---|---|---|---|']
    for l in stab:
        d = stab[l]['z1']; md.append(f"| {l} | {d['C2H4_C3H6']['full']:.5f} | {d['S_C2C3_pct']['full']:.4f} | {d['eta_MeOH_pct']['full']:.5f} | {d['hc_kg_h']['full']:.4f} |")
md += ['', '图：compare_paper.png/pdf（定量比对）、fig_fields.png/pdf（时均场，精确多面体切片）、fig_axial.png/pdf（Fig.12a 轴向）']
open(os.path.join(OUT, 'compare_paper.md'), 'w').write('\n'.join(md) + '\n')
print('\n'.join(md))
