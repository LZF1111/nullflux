"""左偏+中心混合：左区强 + 中心次强，右区弱。增加代理模型覆盖。"""


def zones(ctx):
    Ug = ctx['Ug_total']
    return [1.8 * Ug, 1.0 * Ug, 0.2 * Ug]
