# CONTROL: equivalent of the current 211-hole equal-area-band design (cases/pilot3D).
import math


def layout(ctx):
    n = 211
    R_R, R_M = ctx['R_R'], ctx['R_M']
    d = 2e3 * math.sqrt(ctx['phi'] * (R_M ** 2 - R_R ** 2) / n)
    nb = max(1, round(math.sqrt(n / 6)))
    holes, left = [], n
    for k in range(nb):
        f = (k + 0.5) / nb
        r = math.sqrt(R_R ** 2 + f * (R_M ** 2 - R_R ** 2))
        nk = left if k == nb - 1 else max(1, round(n / nb))
        left -= nk
        ph = 0.5 * (k % 2) * 2 * math.pi / nk
        for i in range(nk):
            a = ph + 2 * math.pi * i / nk
            holes.append((r * math.cos(a), r * math.sin(a), d))
    return holes
