"""右偏+中心混合：右区强 + 中心次强，左区弱。"""


def zones(ctx):
    Ug = ctx['Ug_total']
    return [0.2 * Ug, 1.0 * Ug, 1.8 * Ug]
