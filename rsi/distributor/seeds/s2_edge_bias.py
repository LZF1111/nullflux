# 80 medium holes biased to the outer 60 % of the ring area (gen_distributor 'edge' family).
import math


def layout(ctx):
    n = 80
    R_R, R_M = ctx['R_R'], ctx['R_M']
    d = 2e3 * math.sqrt(ctx['phi'] * (R_M ** 2 - R_R ** 2) / n)
    nb = 3
    holes, left = [], n
    for k in range(nb):
        f = 0.4 + 0.6 * (k + 0.5) / nb
        r = math.sqrt(R_R ** 2 + f * (R_M ** 2 - R_R ** 2))
        nk = left if k == nb - 1 else round(n / nb)
        left -= nk
        for i in range(nk):
            a = (0.5 * (k % 2) + i) * 2 * math.pi / nk
            holes.append((r * math.cos(a), r * math.sin(a), d))
    return holes
