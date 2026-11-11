"""右偏：右区强，左区弱，粒子向右漂移。"""


def zones(ctx):
    Ug = ctx['Ug_total']
    return [0.0 * Ug, 0.5 * Ug, 2.5 * Ug]
