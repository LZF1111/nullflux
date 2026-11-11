# 种子 2：N 级串联（Gamma 龄分布，N 随 H/D 增大），接触效率随 U/Umf 下降（气泡旁路）
import math

def solids_age(s):
    N = max(1, min(20, int(round(1 + s['H_over_D']))))
    n = 120
    # Gamma(N, 1/N) 的分位点，用 N 个指数和的近似：Wilson-Hilferty
    out = []
    for j in range(n):
        p = (j + 0.5) / n
        z = math.sqrt(2) * _erfinv(2 * p - 1)
        th = max(1e-4, (1 - 1 / (9 * N) + z / (3 * math.sqrt(N))) ** 3)
        out.append(th)
    m = sum(out) / n
    return [(1.0, t / m) for t in out]

def _erfinv(y):
    a = 0.147
    ln = math.log(1 - y * y)
    t = 2 / (math.pi * a) + ln / 2
    return math.copysign(math.sqrt(math.sqrt(t * t - ln / a) - t), y)

def contact_efficiency(s):
    return max(0.05, min(1.0, 1.0 / (1.0 + 0.02 * max(0.0, s['U_over_Umf'] - 1.0))))
