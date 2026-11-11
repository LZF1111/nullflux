"""DMTO 跨尺度闭合式评估器（轻量代理，纯标准库，Linux/Windows 通用）。

基准 = Lu et al. 2016 的 CSTR 均场模型（单一 wc，即 TFM 每个网格的处理方式）。
候选 = LLM 写的两个闭合式：solids_age(s) 催化剂停留龄分布（替代单一 wc），
       contact_efficiency(s) 气固接触效率（流型/HD 修正对甲醇可及性的作用）。
动力学: Lu et al. 2016 CES 143:341 Table 3 / Eq.(10)；工况与实验值: Lu et al. 2017 CES 171:244 Table 1 / Table 3。
"""
import argparse, ast, hashlib, json, math, os, sys

R = 8.314
TEMPS = (723.0, 748.0, 763.0)
K_TAB = ((.00232, .00300, .00501), (.10030, .12463, .15413), (.15817, .16212, .19234), (.03699, .03467, .04252),
         (.07519, .07910, .09094), (.05159, .04895, .04895), (.05436, .05859, .07432))
ALPHA_TAB = ((.0576, .0649, .043), (.0914, .1008, .0982), (.1743, .1996, .2017), (.3462, .406, .4099),
             (.2575, .2924, .2929), (.3759, .3495, .3336), (.3817, .3856, .3793))
LUMPS = ('CH4', 'C2H4', 'C3H6', 'C3H8', 'C4', 'C5')
NU = (1.0, 0.5, 1 / 3, 1 / 3, 0.25, 0.2)            # mol product per mol MeOH via lump i
NU_M = (16.04, 14.03, 14.03, 14.70, 14.03, 14.03)   # g product per mol MeOH via lump i
M_COKE_PER_MEOH = 84.0 / 6                          # lump 7: C6 coke, 1/6 mol per mol MeOH
DP, RHO_S, MU_G, G = 97e-6, 1500.0, 2.563e-5, 9.81

# T K, gauge MPa, MeOH/steam/lift/fresh-cat kg/h, inventory kg, D/H m; wc_in 来自 2016（再生剂 2%），demo/commercial 未公布，沿用 2%
SCALES = {
    'micro':      dict(T=723, Pg=0.0,   meoh=0.0135, steam=0.02025, lift=0.0,  cat=0.0,     inv=0.009, D=0.019, H=0.33,  wc_in=0.0, batch=True, wc_state=0.82),
    'pilot':      dict(T=738, Pg=0.024, meoh=18.0,   steam=9.0,     lift=0.12, cat=8.8,     inv=9.0,   D=0.261, H=1.347, wc_in=2.0, batch=False),
    'demo':       dict(T=773, Pg=0.103, meoh=2032.0, steam=610.0,   lift=0.0,  cat=351.0,   inv=501.0, D=1.25,  H=4.0,   wc_in=2.0, batch=False),
    'commercial': dict(T=748, Pg=0.108, meoh=241000., steam=60250., lift=0.0,  cat=42000.,  inv=56000., D=10.5, H=8.0,   wc_in=2.0, batch=False),
}
# 2017 Table 3：exp = 实验，tfm = 原文 Fluent TFM 结果（用于验证本代理是否复现 TFM）
EXP = {
    'micro':      dict(CH4=.0145, C2H4=.2409, C3H6=.3825, C3H8=.0506, C4=.1626, C5=.1489, wc=None),
    'pilot':      dict(CH4=.01643, C2H4=.4303, C3H6=.3457, C3H8=.03788, C4=.0913, C5=.07836, wc=6.0),
    'demo':       dict(CH4=.0322, C2H4=.4147, C3H6=.3748, C3H8=.0221, C4=.1024, C5=.0537, wc=7.15),
    'commercial': dict(CH4=.0201, C2H4=.3955, C3H6=.3921, C3H8=.0352, C4=.1245, C5=.0326, wc=7.36),
}
TFM = {
    'micro':      dict(CH4=.00653, C2H4=.24373, C3H6=.37455, C3H8=.08697, C4=.17351, C5=.11471, wc=0.82),
    'pilot':      dict(CH4=.01468, C2H4=.4432, C3H6=.3673, C3H8=.02874, C4=.1073, C5=.03877, wc=5.655),
    'demo':       dict(CH4=.03019, C2H4=.53928, C3H6=.31209, C3H8=.01361, C4=.07497, C5=.02985, wc=7.44),
    'commercial': dict(CH4=.0185, C2H4=.5179, C3H6=.3304, C3H8=.0167, C4=.0826, C5=.0339, wc=6.72),
}


def _lsq(xs, ys):
    n = len(xs); mx = sum(xs) / n; my = sum(ys) / n
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
    return b, my - b * mx


_ARR = [_lsq([1 / t for t in TEMPS], [math.log(k) for k in row]) for row in K_TAB]   # ln k = b/T + a
_ALF = [_lsq(list(TEMPS), list(row)) for row in ALPHA_TAB]                           # alpha 线性于 T


def rates(T, wc):
    """k_i*phi_i (L/gcat/s), i=1..7；773 K（demo）超出动力学拟合区间 723-763 K，为外推。"""
    common = 1.0 / (1.0 + 9.0 * math.exp(2.0 * (wc - 7.8)))
    return [math.exp(b / T + a) * common * math.exp(-(bt * T + at) * wc) for (b, a), (bt, at) in zip(_ARR, _ALF)]


def feed(sc):
    P = 101325.0 + sc['Pg'] * 1e6
    F_meoh = sc['meoh'] * 1000 / 32.04 / 3600
    F_tot = F_meoh + (sc['steam'] + sc['lift']) * 1000 / 18.015 / 3600
    return dict(P=P, F_meoh=F_meoh, F_tot=F_tot, Ctot=P / (R * sc['T']) / 1000, Gs=sc['cat'] * 1000 / 3600, Is=sc['inv'] * 1000)


def features(name):
    """传给候选闭合式的无量纲/物理特征（不含尺度名，防止按名字作弊）。"""
    sc = SCALES[name]; f = feed(sc)
    rho_g = f['P'] * 0.0257 / (R * sc['T'])           # 进料平均分子量 ~25.7 g/mol
    A = math.pi * sc['D'] ** 2 / 4
    Ug = f['F_tot'] * R * sc['T'] / f['P'] / A
    Ar = rho_g * (RHO_S - rho_g) * G * DP ** 3 / MU_G ** 2
    Umf = (math.sqrt(33.7 ** 2 + 0.0408 * Ar) - 33.7) * MU_G / (rho_g * DP)
    tau = f['Is'] / f['Gs'] if f['Gs'] > 0 else float('inf')
    return dict(T=sc['T'], D=sc['D'], H=sc['H'], H_over_D=sc['H'] / sc['D'], Ug=Ug, Umf=Umf, U_over_Umf=Ug / Umf,
                Re_p=rho_g * Ug * DP / MU_G, Ar=Ar, Fr_D=Ug ** 2 / (G * sc['D']), tau_s=tau,
                Gs_flux=sc['cat'] / 3600 / A, wc_in=sc['wc_in'], batch=bool(sc['batch']))


def gas_C(f, is_eta, Kbar, Sbar):
    """CSTR 气相甲醇出口浓度 (mol/L)：F_in = Q C + Is*eta*K*C，Q = (F_tot + Is*eta*S*C)/Ctot。"""
    a = is_eta * Sbar / f['Ctot']; b = f['F_tot'] / f['Ctot'] + is_eta * Kbar
    return f['F_meoh'] / b if a <= 0 else (-b + math.sqrt(b * b + 4 * a * f['F_meoh'])) / (2 * a)


def _outputs(T, pairs):
    """pairs = [(weight, wc)]：催化剂质量加权的产物分布（同一气相 C 下，C 在分数里约掉）。"""
    prod = [0.0] * 6
    for w, wc in pairs:
        r = rates(T, wc)
        for i in range(6):
            prod[i] += w * r[i] * NU_M[i]
    tot = sum(prod)
    out = {LUMPS[i]: prod[i] / tot for i in range(6)}
    out['wc'] = sum(w * wc for w, wc in pairs)
    out['ratio'] = out['C2H4'] / out['C3H6']
    return out


def meanfield(name):
    """Lu 2016 Eq.(11) CSTR：Gs*wc_in + Is*Rc(wc) = Gs*wc，单一 wc。"""
    sc = SCALES[name]
    if sc['batch']:
        return _outputs(sc['T'], [(1.0, sc['wc_state'])])
    f = feed(sc)

    def resid(wc):
        r = rates(sc['T'], wc)
        C = gas_C(f, f['Is'], sum(r), sum(NU[i] * r[i] for i in range(6)))
        return f['Gs'] * (wc - sc['wc_in']) / 100 - f['Is'] * C * r[6] * M_COKE_PER_MEOH
    lo, hi = sc['wc_in'], 14.0
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if resid(mid) < 0 else (lo, mid)
    return _outputs(sc['T'], [(1.0, 0.5 * (lo + hi))])


def population(name, ages, eta):
    """候选模型：颗粒按龄 theta=t/tau 分布，各自沿 dwc/dt = 100*eta*C*k7*phi7*14 积碳；气相仍为 CSTR 并与之耦合。"""
    sc = SCALES[name]
    if sc['batch']:
        return _outputs(sc['T'], [(1.0, sc['wc_state'])])   # 无循环：所有颗粒同龄，分布闭合式不起作用
    f = feed(sc); T = sc['T']; tau = f['Is'] / f['Gs']
    grid = [sc['wc_in'] + 0.005 * j for j in range(int((14.0 - sc['wc_in']) / 0.005) + 1)]
    inv_r7 = [1.0 / (100 * M_COKE_PER_MEOH * rates(T, wc)[6]) for wc in grid]

    def wcs_for(C):
        # t(wc) = ∫ dwc / (eta*C*...)：单调，先积分再反查
        tcum = [0.0]
        for j in range(1, len(grid)):
            tcum.append(tcum[-1] + 0.5 * (inv_r7[j] + inv_r7[j - 1]) * 0.005 / (eta * C))
        out = []
        for th in ages_t:
            t = th * tau
            lo, hi = 0, len(tcum) - 1
            if t >= tcum[-1]:
                out.append(grid[-1]); continue
            while hi - lo > 1:
                m = (lo + hi) // 2
                lo, hi = (m, hi) if tcum[m] <= t else (lo, m)
            fr = (t - tcum[lo]) / max(tcum[hi] - tcum[lo], 1e-300)
            out.append(grid[lo] + fr * (grid[hi] - grid[lo]))
        return out
    ages_w = [w for w, _ in ages]; ages_t = [t for _, t in ages]

    def h(lnC):
        C = math.exp(lnC); wcs = wcs_for(C)
        Kb = Sb = 0.0
        for w, wc in zip(ages_w, wcs):
            r = rates(T, wc); Kb += w * sum(r); Sb += w * sum(NU[i] * r[i] for i in range(6))
        return math.log(gas_C(f, f['Is'] * eta, Kb, Sb)) - lnC
    lo, hi = math.log(1e-14), math.log(f['F_meoh'] / (f['F_tot'] / f['Ctot']))
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if h(mid) > 0 else (lo, mid)
    wcs = wcs_for(math.exp(0.5 * (lo + hi)))
    return _outputs(T, list(zip(ages_w, wcs)))


def errors(pred, exp):
    e = {k: abs(math.log(pred[k] / exp[k])) for k in LUMPS}
    if exp.get('wc'):
        e['wc'] = abs(pred['wc'] - exp['wc']) / exp['wc']
    return e
