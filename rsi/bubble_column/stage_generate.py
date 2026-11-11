#!/usr/bin/env python3
"""generate 阶段（重写）：支持静态和动态（时变）两种模式。

trial-params.json 中：
  静态模式：  zones: [Ug1, Ug2, Ug3]           → settle期均匀，tracking期固定
  动态模式：  schedule: [{t, zones}, ...]        → 任意时变切换序列

输出：zone{1,2,3}_U.txt 和 zone{1,2,3}_alpha.txt（OpenFOAM tableFile 格式）
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import zone_eval as ZE

C = ZE.CONTRACT
TH = C['thresholds']
P = json.load(open(os.environ.get('CFD_PARAMS_PATH', 'trial-params.json')))

T_SETTLE   = TH['settle_s']       # 15.0 s  — uniform gas, let flow develop
T_END      = T_SETTLE + TH['track_s']  # 23.0 s
Ug_total   = C['zones']['Ug_total_ms']
C0, Uinf   = 1.2, 0.25            # Zuber-Findlay drift-flux params


def alpha_from_ug(ug):
    """Inlet void fraction from drift-flux: alpha = Ug/(C0*Ug + Uinf)."""
    return min(ug / (C0 * ug + Uinf), 0.50) if ug > 1e-9 else 0.0


def build_schedule(p):
    """Return list of (t, [Ug1, Ug2, Ug3]) breakpoints covering [0, T_END].

    Two cases:
      1. p has 'schedule' key  → dynamic; each entry validated & normalised
      2. p has 'zones' key     → static after settle; uniform during settle
    """
    # uniform settling phase: all zones equal for t in [0, T_SETTLE]
    uniform = [Ug_total, Ug_total, Ug_total]

    if 'schedule' in p:
        raw_sched = p['schedule']   # [{t, zones}, ...]
        entries = []
        for entry in raw_sched:
            t = float(entry['t'])
            r = ZE.check(entry['zones'])
            if not r['ok']:
                sys.exit(f"Schedule entry at t={t} invalid: {r['violations']}")
            entries.append((t, r['zones']))
        entries.sort(key=lambda e: e[0])
        # Prepend settle phase
        schedule = [(0.0, uniform)]
        if entries[0][0] > T_SETTLE:
            schedule.append((T_SETTLE, entries[0][1]))
        for t, z in entries:
            if t < T_SETTLE:
                continue          # skip pre-settle overrides
            schedule.append((t, z))
        return schedule

    # Static: uniform settle, then fixed config
    r = ZE.check(p['zones'])
    if not r['ok']:
        sys.exit('Zone invalid: ' + '; '.join(r['violations']))
    return [(0.0, uniform), (T_SETTLE, r['zones'])]


def write_table(path, breakpoints):
    """Write OpenFOAM tableFile for a scalar (ug or alpha)."""
    with open(path, 'w') as f:
        for t, v in breakpoints:
            f.write(f'{t:.6f}  {v:.8f}\n')


def write_vector_table(path, breakpoints):
    """Write OpenFOAM tableFile for a vector (Uy only, x=z=0)."""
    with open(path, 'w') as f:
        for t, uy in breakpoints:
            f.write(f'{t:.6f}  ( 0  {uy:.8f}  0 )\n')


schedule = build_schedule(P)

for zone_idx in range(3):
    # U table: vector (0, Ug, 0)
    u_bp  = [(t, z[zone_idx]) for t, z in schedule]
    al_bp = [(t, alpha_from_ug(z[zone_idx])) for t, z in schedule]

    write_vector_table(f'zone{zone_idx+1}_U.txt',    u_bp)
    write_table        (f'zone{zone_idx+1}_alpha.txt', al_bp)

# Summary
mode = 'dynamic' if 'schedule' in P else 'static'
info = dict(
    mode=mode,
    n_breakpoints=len(schedule),
    breakpoints=[(t, [round(v, 4) for v in z]) for t, z in schedule],
    candidate_hash=P.get('candidate_hash', 'manual'),
)
json.dump(info, open('zone_params.json', 'w'), indent=1)
print(json.dumps({'mode': mode, 'n_breakpoints': len(schedule)}))
