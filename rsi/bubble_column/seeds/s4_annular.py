"""环形分布：左右两区通气，中间关闭。产生壁面上升、中心下降的反常环流。"""


def zones(ctx):
    Ug = ctx['Ug_total']
    return [1.5 * Ug, 0.0, 1.5 * Ug]   # mean = Ug after normalization
