#!/usr/bin/env python3
"""T5 判定（不看模型结论）：Hysing et al. 2009 二维上升气泡 test case 1。
文献参考值（TP2D，最细网格 h=1/320）：最大上升速度 vc_max = 0.2417，出现在 t = 0.9213；t = 3 时质心 yc = 1.0813。
通过条件（开跑前写定）：
  1. 求解日志在最后一个时间步之后有 End，最后时间 ≥ 2.999。
  2. yc(t=3) 由判定脚本自己从算例的 t=3 场（alpha + 单元中心 + 单元体积）独立计算，与 1.0813 相差 ≤ 2 %。
  3. 智能体输出的时间历程：vc_max 与 0.2417 相差 ≤ 4 %，t_vc_max 与 0.9213 相差 ≤ 0.1；
     历程自洽：历程末点 yc 与第 2 条独立计算值相差 ≤ 1 %，且 ∫vc dt 与 yc 增量相差 ≤ 3 %（防止编造曲线）。
用法: judge_t5.py RUN_DIR   （需要已 source OpenFOAM 环境）"""
import glob, json, os, re, shutil, subprocess, sys, tempfile
import numpy as np

VC_REF, T_REF, YC_REF = 0.2417, 0.9213, 1.0813
TOL_VC, TOL_T, TOL_YC = 0.04, 0.1, 0.02


def last_time(case):
    best = None
    for f in glob.glob(os.path.join(case, 'log*')):
        txt = open(f, errors='replace').read()
        m = re.findall(r'^Time = ([0-9.eE+-]+)\s*$', txt, re.M)
        if not m: continue
        ended = re.search(r'^End\s*$', txt[txt.rfind('\nTime = '):], re.M) is not None
        best = max(best or (0, False), (float(m[-1]), ended))
    return best


def read_field(path, n):
    """ASCII volScalarField/volVectorField 的 internalField（uniform 或 nonuniform List）"""
    txt = open(path, errors='replace').read()
    m = re.search(r'internalField\s+uniform\s+([^;]+);', txt)
    if m:
        v = m.group(1).strip().strip('()').split()
        return np.tile(np.array([float(x) for x in v]), (n, 1)) if len(v) > 1 else np.full(n, float(v[0]))
    m = re.search(r'internalField\s+nonuniform\s+List<(\w+)>\s*(\d+)\s*\(', txt)
    if not m: raise ValueError('不能解析 ' + path)
    cnt = int(m.group(2)); body = txt[m.end():]
    if m.group(1) == 'scalar':
        return np.array(body.split(None, cnt)[:cnt], dtype=float)
    vals = re.findall(r'\(([^()]+)\)', body[:cnt * 80])[:cnt]
    return np.array([[float(x) for x in v.split()] for v in vals])


def independent_yc(case, t_end):
    """把算例复制到临时目录，必要时 reconstructPar 最后时刻，写单元中心/体积，按轻相体积分数加权求 yc"""
    d = tempfile.mkdtemp(prefix='j5-')
    try:
        c = os.path.join(d, 'c')
        ign = shutil.ignore_patterns('log*', 'postProcessing', '*.foam')
        shutil.copytree(case, c, ignore=ign, symlinks=False)
        times = [x for x in os.listdir(c) if re.fullmatch(r'[0-9.eE+-]+', x) and float(x) > 0]
        if not times or max(float(x) for x in times) < t_end - 1e-6:
            if glob.glob(os.path.join(c, 'processor*')):
                subprocess.run(['reconstructPar', '-latestTime'], cwd=c, capture_output=True, timeout=1800)
        times = [x for x in os.listdir(c) if re.fullmatch(r'[0-9.eE+-]+', x) and float(x) > 0]
        tl = max(times, key=float)
        if float(tl) < t_end - 1e-6: return None, f'没有 t≥{t_end} 的场（最后 {tl}）'
        subprocess.run(['postProcess', '-func', 'writeCellCentres', '-time', tl], cwd=c, capture_output=True, timeout=600)
        subprocess.run(['postProcess', '-func', 'writeCellVolumes', '-time', tl], cwd=c, capture_output=True, timeout=600)
        T = os.path.join(c, tl)
        alphas = [f for f in glob.glob(os.path.join(T, 'alpha.*')) if not f.endswith(('.orig', '_0'))]
        if not alphas: return None, 't=3 场里没有 alpha.*'
        V = read_field(os.path.join(T, 'V'), 0); n = len(V)
        C = read_field(os.path.join(T, 'C'), n)
        a = read_field(alphas[0], n)
        # 气泡是少数相（体积 π·0.25² ≈ 0.196，域 2）：取体积小的那一相
        if (a * V).sum() > 0.5 * V.sum(): a = 1 - a
        return float((a * V * C[:, 1]).sum() / (a * V).sum()), os.path.basename(alphas[0])
    except Exception as e:
        return None, f'独立计算失败：{e}'
    finally:
        shutil.rmtree(d, ignore_errors=True)


def main(run):
    out = dict(task='T5', run=run, passed=False, reason='', ref=dict(vc_max=VC_REF, t_vc_max=T_REF, yc_t3=YC_REF))
    try: rep = json.load(open(os.path.join(run, 'result.json')))
    except Exception: rep = None
    out['self_report'] = rep
    reasons = []
    if not rep or 'case' not in rep or 'series' not in rep:
        out['reason'] = 'result.json 缺失或缺 case/series'; return finish(run, out)
    case = os.path.normpath(os.path.join(run, rep['case']))
    lt = last_time(case); out['final_time'], out['ended'] = lt if lt else (None, False)
    if not (lt and lt[1] and lt[0] >= 2.999): reasons.append(f'求解未到 3 或无 End（{lt}）')
    yc_ind, how = independent_yc(case, 3.0)
    out['yc_t3_independent'] = yc_ind; out['yc_how'] = how
    if yc_ind is None: reasons.append('yc(3) 无法独立计算：' + how)
    elif abs(yc_ind - YC_REF) > TOL_YC * YC_REF: reasons.append(f'yc(3) = {yc_ind:.4f} 偏离 {YC_REF} 超过 2 %')
    try:
        s = np.loadtxt(os.path.join(run, rep['series']), comments=('#', '//'))
        t, yc, vc = s[:, 0], s[:, 1], s[:, 2]
        i = int(np.argmax(vc)); out['vc_max'] = float(vc[i]); out['t_vc_max'] = float(t[i])
        if abs(vc[i] - VC_REF) > TOL_VC * VC_REF: reasons.append(f'vc_max = {vc[i]:.4f} 偏离 {VC_REF} 超过 4 %')
        if abs(t[i] - T_REF) > TOL_T: reasons.append(f't(vc_max) = {t[i]:.3f} 偏离 {T_REF} 超过 0.1')
        if t[-1] < 2.99: reasons.append(f'时间历程只到 {t[-1]}')
        integ = float(np.trapz(vc, t)); dy = float(yc[-1] - yc[0])
        out['consistency'] = dict(int_vc=integ, dyc=dy)
        if abs(integ - dy) > 0.03 * abs(dy): reasons.append(f'历程不自洽：∫vc dt = {integ:.4f}，yc 增量 = {dy:.4f}')
        if yc_ind is not None and abs(yc[-1] - yc_ind) > 0.01 * yc_ind: reasons.append(f'历程末点 yc {yc[-1]:.4f} 与场计算 {yc_ind:.4f} 不符')
    except Exception as e:
        reasons.append(f'时间历程读不了：{e}')
    out['passed'] = not reasons; out['reason'] = '; '.join(reasons)
    return finish(run, out)


def finish(run, out):
    json.dump(out, open(os.path.join(run, 'judge.json'), 'w'), indent=1, ensure_ascii=False)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main(os.path.abspath(sys.argv[1]))
