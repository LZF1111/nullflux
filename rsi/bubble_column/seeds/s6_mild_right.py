"""中等右偏：介于 s0_uniform 和 s2_right 之间。"""


def zones(ctx):
    Ug = ctx['Ug_total']
    return [0.5 * Ug, 0.9 * Ug, 1.6 * Ug]
