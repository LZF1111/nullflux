"""Baseline: uniform gas distribution across all three zones."""


def zones(ctx):
    """Equal flow in all zones - establishes symmetric central circulation."""
    Ug = ctx['Ug_total']
    return [Ug, Ug, Ug]
