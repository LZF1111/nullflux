"""Bubble column zone parameterization, validation, and cheap features.

Zone state: [Ug1, Ug2, Ug3] in m/s (left, center, right).
Constraint: mean(Ug_i) == Ug_total (equal zone widths -> volume conservation).
"""
import hashlib, json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT = json.load(open(os.path.join(HERE, 'contract.json'), encoding='utf-8'))
G = CONTRACT['geometry']
P = CONTRACT['physics']
ZC = CONTRACT['zones']


def check(zones):
    """Validate zone velocities; auto-normalize to volume constraint.
    Returns dict: ok, violations, zones (normalized), hash, features.
    """
    zones = [float(v) for v in zones]
    if len(zones) != ZC['n']:
        return dict(ok=False, violations=[f'Expected {ZC["n"]} zones, got {len(zones)}'])

    violations = []
    for i, v in enumerate(zones):
        if not math.isfinite(v) or v < -1e-9:
            violations.append(f'Zone {i+1} velocity {v:.4f} must be finite and >= 0')
        zones[i] = max(0.0, v)

    if violations:
        return dict(ok=False, violations=violations)

    # Normalize to mean constraint
    mean = sum(zones) / ZC['n']
    if mean < 1e-12:
        return dict(ok=False, violations=['All zones zero - no gas flow'])

    scale = ZC['Ug_total_ms'] / mean
    zones = [v * scale for v in zones]

    for i, v in enumerate(zones):
        if v > ZC['Ug_max_ms'] + 1e-9:
            violations.append(f'Zone {i+1} Ug={v:.4f} m/s exceeds max {ZC["Ug_max_ms"]} m/s')
    if violations:
        return dict(ok=False, violations=violations)

    return dict(ok=True, violations=[], zones=zones, hash=zone_hash(zones), features=features(zones))


def zone_hash(zones):
    s = json.dumps([round(v, 6) for v in zones])
    return hashlib.sha1(s.encode()).hexdigest()[:10]


def features(zones):
    """Scalar descriptors of a zone configuration."""
    n = len(zones)
    mean = sum(zones) / n
    edges = G['zone_edges_m']
    zone_centers = [0.5 * (edges[i] + edges[i+1]) for i in range(n)]

    total_q = sum(zones)
    cx = sum(zone_centers[i] * zones[i] for i in range(n)) / total_q if total_q > 1e-12 else 0.0
    cx_norm = cx / (0.5 * (edges[-1] - edges[0]))

    asym = (zones[0] - zones[-1]) / total_q if total_q > 1e-12 else 0.0
    center_frac = zones[n//2] / total_q if total_q > 1e-12 else 1.0 / n

    cv = math.sqrt(sum((v - mean)**2 for v in zones) / n) / mean if mean > 1e-12 else 0.0
    uniformity = 1.0 / (1.0 + cv)

    return dict(
        mean_Ug=round(mean, 6),
        cx_norm=round(cx_norm, 4),
        asymmetry=round(asym, 4),
        center_frac=round(center_frac, 4),
        uniformity=round(uniformity, 4),
        Ug1=round(zones[0], 6),
        Ug2=round(zones[1], 6) if n > 1 else round(mean, 6),
        Ug3=round(zones[2], 6) if n > 2 else round(mean, 6),
    )


def cell(f):
    """MAP-Elites cell: asymmetry x center_fraction."""
    ab = int(math.floor((f['asymmetry'] + 1.0) * 2))
    ab = max(0, min(3, ab))
    cf = f['center_frac']
    cb = 0 if cf < 0.25 else (1 if cf < 0.5 else (2 if cf < 0.75 else 3))
    return f'a{ab}-c{cb}'


def context():
    """Context dict exposed to seed/candidate scripts."""
    return dict(
        n_zones=ZC['n'],
        Ug_total=ZC['Ug_total_ms'],
        Ug_max=ZC['Ug_max_ms'],
        zone_edges=G['zone_edges_m'],
        zone_names=G['zone_names'],
    )
