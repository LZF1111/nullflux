"""中等左偏：介于 s0_uniform 和 s1_left 之间，增加代理模型密度。"""


def zones(ctx):
    Ug = ctx['Ug_total']
    return [1.6 * Ug, 0.9 * Ug, 0.5 * Ug]
