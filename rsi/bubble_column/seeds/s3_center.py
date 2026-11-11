"""中心集中：只有中间区通气，产生强中心上升流，粒子沿轴线上升。"""


def zones(ctx):
    Ug = ctx['Ug_total']
    return [0.0, 3.0 * Ug, 0.0]   # mean = Ug after normalization
