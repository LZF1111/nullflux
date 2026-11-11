# Few large holes on two rings: stronger, deeper single jets (hypothesis A1 in ANA-3D-009).
import math


def layout(ctx):
    R_R, R_M = ctx['R_R'], ctx['R_M']
    rings = [(0.45, 12), (0.82, 24)]
    n = sum(m for _, m in rings)
    d = 2e3 * math.sqrt(ctx['phi'] * (R_M ** 2 - R_R ** 2) / n)
    holes = []
    for j, (f, m) in enumerate(rings):
        r = math.sqrt(R_R ** 2 + f * (R_M ** 2 - R_R ** 2))
        for i in range(m):
            a = (0.5 * j + i) * 2 * math.pi / m
            holes.append((r * math.cos(a), r * math.sin(a), d))
    return holes
