"""左偏：左区强，右区弱，产生整体左偏环流，粒子向左漂移。"""


def zones(ctx):
    Ug = ctx['Ug_total']
    return [2.5 * Ug, 0.5 * Ug, 0.0 * Ug]   # 正好 mean = Ug after normalization
