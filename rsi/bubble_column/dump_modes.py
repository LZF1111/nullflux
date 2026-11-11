#!/usr/bin/env python3
"""Dump the mode field series used by swarm_feas.py to one npz (for running offline studies elsewhere).

  dump_modes.py <runs_dir> <out.npz>
"""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import swarm_feas as SF

runs, out = sys.argv[1], sys.argv[2]
d = dict()
for m, rid in SF.MODES.items():
    U, V = SF.load_mode(runs, rid)
    mf = json.load(open(os.path.join(runs, rid, 'traj.json')))['mean_field']
    d[f'{m}_u'], d[f'{m}_v'] = U.astype(np.float32), V.astype(np.float32)
    d[f'{m}_mu'], d[f'{m}_mv'] = np.array(mf['u'], np.float32), np.array(mf['v'], np.float32)
np.savez_compressed(out, **d)
print(out, {k: v.shape for k, v in d.items()})
