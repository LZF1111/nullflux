#!/usr/bin/env python3
"""Quick validation: check all seed configs and print summary."""
import importlib.util, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import zone_eval as ZE

seed_dir = os.path.join(HERE, 'seeds')
for sfile in sorted(os.listdir(seed_dir)):
    if not sfile.endswith('.py'):
        continue
    path = os.path.join(seed_dir, sfile)
    spec = importlib.util.spec_from_file_location('_s', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    raw = mod.zones(ZE.context())
    r = ZE.check(raw)
    if r['ok']:
        f = r['features']
        zones = [round(v, 4) for v in r['zones']]
        print(f"{sfile:25s} ok  zones={zones}  hash={r['hash']}  cell={ZE.cell(f)}  asym={f['asymmetry']:+.3f}")
    else:
        print(f"{sfile:25s} FAIL  {r['violations']}")
