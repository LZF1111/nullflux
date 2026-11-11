# 种子 0：完全返混（CSTR 停留龄 = 指数分布），接触效率恒为 1
import math

def solids_age(s):
    n = 80
    out = []
    for j in range(n):
        th = -math.log(1 - (j + 0.5) / n)
        out.append((1.0, th))
    m = sum(t for _, t in out) / n
    return [(1.0, t / m) for _, t in out]

def contact_efficiency(s):
    return 1.0
