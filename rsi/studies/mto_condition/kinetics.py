"""Lu 2016 Table 3 动力学插值 + 中试 CSTR 模型（cstr/cstr_mto.py 的纯 Python 移植，不依赖 numpy）。
interp(T) 给 fvOptions 的 k[7]/a[7]；solve(T, feed_scale) 只用作工况研究的廉价代理（排序用，不是证据）。"""
import math

K_TAB = [[0.00232, 0.00300], [0.10030, 0.12463], [0.15817, 0.16212], [0.03699, 0.03467],
         [0.07519, 0.07910], [0.05159, 0.04895], [0.05436, 0.05859]]          # 723 K, 748 K; L/gcat/s
A_TAB = [[0.0576, 0.0649], [0.0914, 0.1008], [0.1743, 0.1996], [0.3462, 0.406],
         [0.2575, 0.2924], [0.3759, 0.3495], [0.3817, 0.3856]]
M = [16.043, 28.054, 42.081, 44.097, 56.107, 70.134, 84.16]
NU = [1., 1 / 2, 1 / 3, 1 / 3, 1 / 4, 1 / 5, 1 / 6]
M_MEOH, M_H2O = 32.042, 18.015


def interp(T):
    """arr2：723–748 K 两点 Arrhenius（k）+ 线性（α），与 cstr_mto.interp(T, 'arr2') 相同"""
    x = (1 / T - 1 / 723.) / (1 / 748. - 1 / 723.)
    k = [math.exp(math.log(a) + x * (math.log(b) - math.log(a))) for a, b in K_TAB]
    al = [a + (T - 723.) / 25. * (b - a) for a, b in A_TAB]
    return k, al


def _bisect(f, a, b, tol=1e-12, it=200):
    fa = f(a)
    for _ in range(it):
        m = 0.5 * (a + b); fm = f(m)
        if fa * fm <= 0: b = m
        else: a, fa = m, fm
        if b - a < tol * max(1, abs(m)): break
    return 0.5 * (a + b)


def solve(T=738., feed_scale=1.0, P=0.024e6 + 101325., Is=9000., Gs=8.8e3 / 3600, wc_in=2.0,
          F_MeOH=18e3 / 3600, F_H2O=(9e3 + 0.12e3) / 3600):
    """稳态 CSTR：返回 wc、MeOH 转化率、气相 C2+C3 选择性、C2H4/C3H6。进料（甲醇+水）整体乘 feed_scale。"""
    k, a = interp(T)
    Ctot = P / (1000 * 8.314 * T)
    nM0, nW0 = F_MeOH * feed_scale / M_MEOH, F_H2O * feed_scale / M_H2O

    def state(wc):
        g = 1.0 / (1.0 + 9.0 * math.exp(2.0 * (wc - 7.8)))
        kp = [ki * g * math.exp(-ai * wc) for ki, ai in zip(k, a)]
        ksum = sum(kp); s6 = sum(kp[i] * NU[i] for i in range(6))
        C = _bisect(lambda C: (nM0 + nW0 + Is * C * (s6 - kp[6])) / Ctot * C - (nM0 - Is * ksum * C), 0.0, Ctot)
        return C, kp

    def coke_res(wc):
        C, kp = state(wc)
        return Gs * wc_in + Is * kp[6] * NU[6] * C * M[6] * 100.0 - Gs * wc

    wc = _bisect(coke_res, wc_in, 30.0)
    C, kp = state(wc)
    r = [Is * x * C for x in kp]
    mass = [ri * n * m for ri, n, m in zip(r, NU, M)]
    gas = sum(mass[:6])
    return dict(wc=wc, conv=100 * sum(r) / nM0, S_gas=100 * (mass[1] + mass[2]) / gas, ratio=mass[1] / mass[2])
