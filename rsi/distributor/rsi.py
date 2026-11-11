#!/usr/bin/env python3
"""分布器布孔 RSI 编排器（Lu 2016 pilot DMTO）。
提议者（LLM 或人）写候选 layout(ctx) → check（沙箱 + 5 % 锁定 + 制造约束）→ 代理筛选 → CFD 试验（cfd_trial.js 四阶段、
哈希证据）→ 独立复核证据 → 对冠军做带噪声的接受判据 → MAP-Elites 存档。封存量只在 final 打开。
  rsi.py init                    建模板目录（只读源算例）
  rsi.py replay                  用已有 pilot3D 结果复核测量口径（不跑 CFD）
  rsi.py check  cand.py          离线检查一个候选
  rsi.py submit cand.py [--control] [--dry]   跑 CFD 试验并登记（需合同已批准）
  rsi.py context                 提议者可见的档案（不含封存量）
  rsi.py status | final | calibrate"""
import argparse, glob, json, math, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import layout_eval as L

C = L.CONTRACT; RUN = C['run']; TH = C['thresholds']
ROOT = RUN['work_root']; ARCH = os.path.join(ROOT, 'archive.json'); TEMPLATE = os.path.join(ROOT, 'template')
STUDY = f"dist-v{C['version']}"
SEALED = set(C['roles']['sealed'])


def load_arch():
    if os.path.exists(ARCH): return json.load(open(ARCH, encoding='utf-8'))
    return dict(study=STUDY, champion=None, control=None, cells={}, trials={}, surrogate=dict(lam=0.03, amp=0.6))


def save_arch(a):
    os.makedirs(ROOT, exist_ok=True)
    tmp = ARCH + '.tmp'; json.dump(a, open(tmp, 'w', encoding='utf-8'), indent=1, ensure_ascii=False); os.replace(tmp, ARCH)


def t_end():
    return float(RUN['t0']) + RUN['duration_s']


def acceptance():
    # endTime 留 1e-4 s 余量（求解器最后一步的 Time 可能略小于名义终点）；窗口必须落在 endTime 内
    te = round(t_end() - 1e-4, 6)
    return dict(
        endTime=te, objective='loss_fig12b',
        metrics=[
            dict(name='loss_fig12b', role='fit', min=0, max=10),
            dict(name='kpi_dev_max_pct', role='fit', min=0, max=TH['kpi_dev_max_pct']),
            dict(name='fit_consistent', role='fit', min=0, max=TH['fit_consistent_max']),
            dict(name='sampleCount', role='fit', min=TH['sample_min']),
            dict(name='z04_min_over_wall', role='holdout', min=TH['z04_min_over_wall_min']),
            dict(name='leak_frac', role='holdout', min=0, max=TH['leak_frac_max']),
            dict(name='windowCoverage', role='holdout', min=TH['coverage_min'], max=1.0)],
        measurement=dict(
            windowStart=round(te - RUN['window_s'], 6), windowEnd=round(te, 6), windowMetric='windowCoverage', timingMetric='sampleCount',
            description=(f"续算 {RUN['duration_s']} s，前 {RUN['duration_s'] - RUN['window_s']:.1f} s 丢弃，统计后 {RUN['window_s']} s；"
                         f"写出间隔 {RUN['write_interval_s']} s。Fig.12b 取各写出时刻 C2H4 算术平均后的 y=0 线（|y|<h/2，x 20 箱，÷壁），"
                         "与原文估读点比 RMSE；前后半窗各算一次作一致性。KPI 取 z=1.0 m 截面 speciesZ1 窗口均值。")))


def pipeline():
    to = RUN['timeouts_ms']
    return dict(stages=dict(
        generate=dict(command=['python3', os.path.join(HERE, 'stage_generate.py')], timeoutMs=to['generate']),
        mesh=dict(command=['bash', os.path.join(HERE, 'stage_mesh.sh')], timeoutMs=to['mesh']),
        solve=dict(command=['bash', os.path.join(HERE, 'stage_solve.sh')], timeoutMs=to['solve']),
        verify=dict(command=['python3', os.path.join(HERE, 'verify.py')], timeoutMs=to['verify'])), acceptance=acceptance())


def cmd_init(_):
    if os.path.exists(TEMPLATE): print('模板已存在', TEMPLATE); return
    os.makedirs(TEMPLATE)
    shutil.copytree(os.path.join(RUN['src_case'], 'system'), os.path.join(TEMPLATE, 'system'))
    shutil.copytree(os.path.join(RUN['src_case'], 'constant'), os.path.join(TEMPLATE, 'constant'),
                    ignore=shutil.ignore_patterns('polyMesh', 'polyMesh.*', '*.bak*'))
    shutil.copytree(RUN['zero_dir'], os.path.join(TEMPLATE, '0'))
    os.makedirs(os.path.join(TEMPLATE, 'constant', 'polyMesh'))
    open(os.path.join(TEMPLATE, 'constant', 'polyMesh', 'README'), 'w').write('mesh stage rebuilds polyMesh from prebaffle_mesh\n')
    print('模板已建', TEMPLATE)


def cmd_replay(a):
    """测量口径复核：对已有 pilot3D 结果，verify 的 y=0 线 min/壁 必须等于 fig12_post.json（同一时刻集）"""
    import verify as V
    ref = json.load(open('/home/user/mto_repro/cases/pilot3D/fig12_post.json'))
    ts = ref['times']; case = '/home/user/mto_repro/cases/pilot3D'
    Cc, Vv, F = V.mean_field(case, ts, 'C2H4.gas')
    ln = V.lines(Cc, Vv, F)
    rows = []
    for Z in ('0.06', '0.1', '0.4'):
        mine, theirs = ln[Z]['min'], ref['radial'][Z]['line_min_over_wall']
        rows.append(dict(Z=Z, verify=mine, fig12post=theirs, diff=mine - theirs, rmse_vs_paper=ln[Z]['rmse']))
    pz = V.plateau(Cc, Vv, F)
    ok = all(abs(r['diff']) < 2e-3 for r in rows) and abs(pz - ref['z_plateau99_m']) < 0.03
    out = dict(passed=ok, rows=rows, plateau=dict(verify=pz, fig12post=ref['z_plateau99_m']), n_times=len(ts),
               baseline_loss_fig12b=0.5 * (ln['0.06']['rmse'] + ln['0.1']['rmse']))
    os.makedirs(ROOT, exist_ok=True); json.dump(out, open(os.path.join(ROOT, 'replay.json'), 'w'), indent=1)
    print(json.dumps(out, indent=1, ensure_ascii=False))
    if not ok: sys.exit('测量口径与 fig12post.py 不一致：先修 verify.py，不能开始搜索')


def cmd_check(a):
    r = L.check(a.cand)
    a_ = load_arch(); r['surrogate'] = surrogate_for(r, a_)
    r.pop('holes'); print(json.dumps(r, indent=1, ensure_ascii=False))
    if not r['ok']: sys.exit(1)


def surrogate_for(r, arch):
    s = arch['surrogate']; xs = [i / 20 - 1 for i in range(41)]
    hs = [tuple(h) for h in r['holes']]
    return 0.5 * (L.paper_rmse(xs, L.surrogate_line(hs, 0.06, xs, s['lam'], s['amp']), '0.06') +
                  L.paper_rmse(xs, L.surrogate_line(hs, 0.1, xs, s['lam'], s['amp']), '0.1'))


def busy_cores():
    # /proc/*/comm 截断到 15 字符（reactingTwoPhas），要看 cmdline 的 argv0
    n = 0
    for p in glob.glob('/proc/[0-9]*/cmdline'):
        try:
            with open(p, 'rb') as f: argv0 = f.read().split(b'\0')[0].decode(errors='replace')
            if os.path.basename(argv0).endswith('Foam'): n += 1
        except OSError: pass
    return n


def cmd_submit(a):
    if C.get('thresholds_status') != 'APPROVED':
        sys.exit('合同阈值尚未批准（contract.json thresholds_status != APPROVED）：不启动 CFD')
    arch = load_arch()
    r = L.check(a.cand)
    if not r['ok'] and not a.control: sys.exit('候选违反约束：' + '; '.join(r['violations']))
    if r['hash'] in arch['trials']: sys.exit(f"候选 {r['hash']} 已试过：{arch['trials'][r['hash']].get('state')}")
    if arch['control'] is None and not a.control: sys.exit('先用 --control 跑对照（当前 211 孔设计），验证流水线能复现基准')
    if arch['control'] and arch['control'].get('state') == 'control_failed': sys.exit('对照未复现基准：流水线有问题，停止搜索')
    if busy_cores() + RUN['np'] > (os.cpu_count() or 1) - RUN['reserve_cores']:
        sys.exit(f'核不够：已有 {busy_cores()} 个求解进程，再开 {RUN["np"]} 会超配')
    params = dict(holes=r['holes'], candidate_hash=r['hash'], t0=RUN['t0'], duration_s=RUN['duration_s'], window_s=RUN['window_s'],
                  write_interval_s=RUN['write_interval_s'], np=RUN['np'], control=bool(a.control))
    tdir = os.path.join(ROOT, 'trials', r['hash'])
    cfg = dict(baseCase=TEMPLATE, trialDir=tdir, studyId=STUDY, trialId=r['hash'], params=params, **pipeline())
    os.makedirs(os.path.join(ROOT, 'configs'), exist_ok=True)
    cpath = os.path.join(ROOT, 'configs', r['hash'] + '.json'); json.dump(cfg, open(cpath, 'w'), indent=1)
    spec = dict(study_id=STUDY, base_case=TEMPLATE, pipeline=pipeline())
    json.dump(spec, open(os.path.join(ROOT, 'study_spec.json'), 'w'), indent=1)
    rec = dict(hash=r['hash'], path=r['path'], cell=r['cell'], features=r['features'], surrogate=surrogate_for(r, arch),
               control=bool(a.control), state='running', started=time.time())
    if a.dry: print(json.dumps(dict(config=cpath, record=rec), indent=1, ensure_ascii=False)); return
    arch['trials'][r['hash']] = rec; save_arch(arch)
    p = subprocess.run(['node', RUN['cfd_trial'], cpath], capture_output=True, text=True)
    arch = load_arch(); rec = arch['trials'][r['hash']]
    res_path = os.path.join(tdir, 'trial-result.json')
    if not os.path.exists(res_path):
        # 配置/目录预检就被拒（还没建候选目录）：是框架错误，不是候选或对照的物理结果，不登记
        del arch['trials'][r['hash']]; save_arch(arch)
        sys.exit('cfd_trial 预检拒绝（未登记）：' + (p.stderr or p.stdout)[-1500:])
    res = json.load(open(res_path))
    rec.update(ended=time.time(), cfd_passed=bool(res.get('passed')), error=res.get('error'))
    if res.get('passed'):
        v = subprocess.run(['node', RUN['cfd_trial'], '--verify', res_path, '--study-id', STUDY, '--trial-id', r['hash'],
                            '--value', repr(res['value']), '--study-spec', os.path.join(ROOT, 'study_spec.json'),
                            '--params', json.dumps(params), '--trial-dir', tdir], capture_output=True, text=True)
        rec['evidence_verified'] = v.returncode == 0
        if v.returncode != 0: rec['error'] = 'evidence: ' + v.stderr[-500:]
    metrics = json.load(open(os.path.join(tdir, 'metrics.json'))) if os.path.exists(os.path.join(tdir, 'metrics.json')) else {}
    rec['metrics_visible'] = {k: v for k, v in metrics.items() if k not in SEALED}
    rec['metrics_sealed'] = {k: v for k, v in metrics.items() if k in SEALED}
    decide(arch, rec, res)
    save_arch(arch)
    print(json.dumps({k: rec[k] for k in ('hash', 'cell', 'state', 'metrics_visible', 'error') if k in rec}, indent=1, ensure_ascii=False))


def decide(arch, rec, res):
    m = rec.get('metrics_visible', {})
    valid = bool(res.get('passed')) and rec.get('evidence_verified')
    if rec['control']:
        ref = C['control_reference']['line_min_over_wall_006']
        d = abs(m.get('min_over_wall_006', 9) - ref) if m else 9
        rec['state'] = 'control_ok' if (valid and d <= TH['control_tol']) else 'control_failed'
        rec['control_diff'] = d
        arch['control'] = rec
        if rec['state'] == 'control_ok' and arch['champion'] is None: arch['champion'] = rec['hash']
        return
    if not valid: rec['state'] = 'invalid'; return
    champ = arch['trials'].get(arch['champion'] or '', None)
    noise = lambda t: 0.5 * t['metrics_visible']['fit_consistent']
    if champ is None:
        rec['state'] = 'accepted'
    else:
        gain = champ['metrics_visible']['loss_fig12b'] - m['loss_fig12b']
        need = max(TH['accept_min_gain'], TH['accept_kappa'] * math.hypot(noise(rec), noise(champ)))
        rec['gain'] = gain; rec['need'] = need
        rec['state'] = 'accepted' if gain > need else 'rejected'
    if rec['state'] == 'accepted': arch['champion'] = rec['hash']
    elite = arch['trials'].get(arch['cells'].get(rec['cell'], ''), None)
    if elite is None or m['loss_fig12b'] < elite['metrics_visible']['loss_fig12b']: arch['cells'][rec['cell']] = rec['hash']


def context_text(arch=None):
    arch = arch or load_arch(); lines = []
    lines.append('## 约束（不可改）'); lines.append(json.dumps(L.context(), ensure_ascii=False))
    lines.append('## 目标：Fig.12b 原文点（÷壁）'); lines.append(json.dumps(C['targets']['fig12b'], ensure_ascii=False))
    def num(v, p):
        # 失败试验的 metrics 可能缺项或为 None/字符串：显示 nan，不能让提议上下文崩掉
        try: return f'{float(v):.{p}f}'
        except (TypeError, ValueError): return 'nan'
    for h, t in sorted(arch['trials'].items(), key=lambda kv: kv[1].get('started', 0)):
        mv = t.get('metrics_visible') or {}; ft = t.get('features') or {}
        lines.append(f"- {h} cell={t.get('cell')} state={t.get('state')} n={ft.get('n_holes')} d={num(ft.get('d_eq_mm'), 2)}mm "
                     f"r/R={num(ft.get('r_mean_over_R'), 2)} loss={num(mv.get('loss_fig12b'), 4)} "
                     f"min006={num(mv.get('min_over_wall_006'), 3)} min010={num(mv.get('min_over_wall_010'), 3)} "
                     f"kpi_dev={num(mv.get('kpi_dev_max_pct'), 2)}% sur={num(t.get('surrogate'), 3)}")
    lines.append(f"## 冠军 {arch['champion']}；格子 {json.dumps(arch['cells'])}")
    return '\n'.join(lines)


def cmd_context(_): print(context_text())


def cmd_status(_):
    a = load_arch()
    print(json.dumps(dict(study=a['study'], champion=a['champion'], control=a['control'] and a['control']['state'],
                          trials={h: t['state'] for h, t in a['trials'].items()}, cells=a['cells'], surrogate=a['surrogate'],
                          thresholds_status=C.get('thresholds_status')), indent=1, ensure_ascii=False))


def cmd_calibrate(_):
    """RSI 的自改进环节：用已完成 CFD 试验回标代理模型（lam, amp），让下一轮筛选更准。只改代理，不改评估器。"""
    a = load_arch(); done = [t for t in a['trials'].values() if t.get('metrics_visible', {}).get('loss_fig12b') is not None]
    if len(done) < 3: sys.exit(f'只有 {len(done)} 个 CFD 结果，至少 3 个才回标')
    best = None
    for lam in (0.01, 0.02, 0.03, 0.05, 0.08):
        for amp in (0.2, 0.4, 0.6, 0.9, 1.2):
            a['surrogate'] = dict(lam=lam, amp=amp)
            err = sum((surrogate_for(L.check(t['path']), a) - t['metrics_visible']['loss_fig12b']) ** 2 for t in done)
            if best is None or err < best[0]: best = (err, lam, amp)
    a['surrogate'] = dict(lam=best[1], amp=best[2], rmse=math.sqrt(best[0] / len(done)), n=len(done)); save_arch(a)
    print(json.dumps(a['surrogate']))


def cmd_final(_):
    a = load_arch(); h = a['champion']
    if not h or h == (a['control'] or {}).get('hash'): sys.exit('还没有超过对照的冠军')
    t = a['trials'][h]; s = t['metrics_sealed']; ctl = a['control']['metrics_sealed']
    out = dict(champion=h, sealed=s, control_sealed=ctl,
               plateau_pass=s['plateau_err_m'] <= C['thresholds']['plateau_tol_m'],
               plateau_better_than_control=s['plateau_err_m'] < ctl['plateau_err_m'],
               note='通过只说明这是与原文 CFD 一致的标定布孔；需在 pilot3D_fine 细网格上复算冠军与对照后才能写入报告')
    print(json.dumps(out, indent=1, ensure_ascii=False))


def cmd_report(a):
    """出版风格报告：各试验 Fig.12b y=0 线 vs 原文 + 布孔图 + Z=0.06 m C2H4 截面（精确多面体切片）。
    没有完成的试验时用 pilot3D 基准（--case）出同版式图，便于先检查版式。"""
    import numpy as np
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    from matplotlib.patches import Circle
    import verify as V
    PF = V.PF; PF._style(plt)
    arch = load_arch(); te = t_end()
    rows = []
    for h, t in arch['trials'].items():
        tdir = os.path.join(ROOT, 'trials', h)
        if not t.get('cfd_passed'): continue
        _, ln = V.measure(tdir, te - RUN['window_s'], te)
        rows.append(dict(label=('control 211' if t['control'] else h) + ('  ★' if h == arch['champion'] else ''), lines=ln, case=tdir,
                         holes=L.check(t['path'])['holes'], t1=te))
    if not rows:
        ref = json.load(open('/home/user/mto_repro/cases/pilot3D/fig12_post.json'))
        case = a.case or '/home/user/mto_repro/cases/pilot3D'
        Cc, Vv, F = V.mean_field(case, ref['times'], 'C2H4.gas')
        rows.append(dict(label='baseline 211', lines=V.lines(Cc, Vv, F), case=case,
                         holes=L.check(os.path.join(HERE, 'seeds', 's0_uniform211.py'))['holes'], t1=float(ref['times'][-1]), times=ref['times']))
    cols = plt.cm.viridis(np.linspace(0.05, 0.8, max(len(rows), 1)))
    fig = plt.figure(figsize=(7.2, 4.6), dpi=300)
    gs = fig.add_gridspec(2, 3, wspace=0.42, hspace=0.5)
    for i, Z in enumerate(('0.06', '0.1', '0.4')):
        ax = fig.add_subplot(gs[0, i]); tg = C['targets']['fig12b'][Z]
        ax.plot(tg['x'], np.array(tg['C2H4']) / tg['C2H4'][0], 'o--', color='#c0392b', ms=3, mfc='w', lw=0.8, label='Lu et al. (2016)')
        for r, c in zip(rows, cols):
            ln = r['lines'][Z]; ax.plot(ln['x'], ln['y'], '-', color=c, lw=1.1, label=r['label'])
        ax.set_xlim(-1, 1); ax.set_ylim(0.4, 1.1); ax.set_xlabel('$x/R$')
        ax.set_title(f'({"abc"[i]})  $Z$ = {Z} m', fontsize=8, loc='left', pad=3)
        if i == 0: ax.set_ylabel(r'$Y_{\mathrm{C_2H_4}}/Y_{\mathrm{C_2H_4,wall}}$')
        if i == 2: ax.legend(fontsize=5.5, loc='lower center')
    # (d) 冠军（或基准）布孔
    best = rows[-1] if len(rows) == 1 else next((r for r in rows if '★' in r['label']), rows[0])
    ax = fig.add_subplot(gs[1, 0]); g = C['locked_geometry']
    for rr in (g['R_M'], g['R_R']): ax.add_patch(Circle((0, 0), rr, fill=False, lw=0.7, color='k'))
    for x, y, d in best['holes']: ax.add_patch(Circle((x, y), d * 5e-4, color='#1f4e9c', lw=0))
    ax.set_xlim(-0.14, 0.14); ax.set_ylim(-0.14, 0.14); ax.set_aspect('equal'); ax.set_xlabel('$x$ [m]'); ax.set_ylabel('$y$ [m]')
    ax.set_title(f'(d)  {len(best["holes"])} holes, 5 % open', fontsize=8, loc='left', pad=3)
    # (e) Z=0.06 m C2H4 截面
    ax = fig.add_subplot(gs[1, 1]); ts = best.get('times') or V.times_in(best['case'], best['t1'] - RUN['window_s'], best['t1'])
    t = ts[-1]
    d = PF.slice_data(best['case'], dict(time=t, field='C2H4.gas', axis='z', pos=0.06))
    # 时间平均：同一组切片单元上把各时刻场平均
    acc = np.zeros_like(d['F']); n = 0
    for tt in ts:
        pp, Fi, Vc, sg, kd, src = PF._slice_parts(best['case'], tt, 'C2H4.gas', 2, 0.06, 0, 1); acc += Fi; n += 1
    d = PF.slice_data(best['case'], dict(time=t, field='C2H4.gas', axis='z', pos=0.06, F=(d['polys'], acc / n, d['Vc'], d['segs'], d['kinds'], d['src'])))
    m = PF.draw_slice(ax, d, shading='smooth'); ax.axhline(0, color='w', lw=0.6, ls=(0, (3, 2)))
    PF.colorbar(fig, m, ax, r'$\langle Y_{\mathrm{C_2H_4}}\rangle$', cax=ax.inset_axes([1.04, 0, 0.07, 1]))
    ax.set_xlabel('$x$ [m]'); ax.tick_params(labelleft=False); ax.set_title('(e)  $Z$ = 0.06 m', fontsize=8, loc='left', pad=3)
    # (f) 指标表
    ax = fig.add_subplot(gs[1, 2]); ax.axis('off')
    txt = [f"{'':<13}{'min/wall':>9}{'loss':>7}", f"{'paper CFD':<13}{0.487:>9.3f}{'—':>7}"]
    for r in rows:
        ln = r['lines']; txt.append(f"{r['label'][:13]:<13}{ln['0.06']['min']:>9.3f}{0.5 * (ln['0.06']['rmse'] + ln['0.1']['rmse']):>7.3f}")
    note = '\n\nno RSI trial finished yet:\nlayout check on baseline' if 'times' in rows[0] else ''
    ax.text(0.32, 1, '(f)  $Z$ = 0.06 m summary\n\n' + '\n'.join(txt) + note, va='top', family='monospace', fontsize=5.6, transform=ax.transAxes)
    out = os.path.join(ROOT, 'report'); os.makedirs(out, exist_ok=True)
    for ext in ('png', 'pdf'): fig.savefig(os.path.join(out, f'rsi_report.{ext}'))
    print(json.dumps(dict(png=os.path.join(out, 'rsi_report.png'), trials=len(rows))))


def main():
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest='cmd', required=True)
    for n in ('init', 'replay', 'context', 'status', 'calibrate', 'final'): sp.add_parser(n)
    p = sp.add_parser('report'); p.add_argument('--case')
    p = sp.add_parser('check'); p.add_argument('cand')
    p = sp.add_parser('submit'); p.add_argument('cand'); p.add_argument('--control', action='store_true'); p.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    globals()['cmd_' + a.cmd](a)


if __name__ == '__main__':
    main()
