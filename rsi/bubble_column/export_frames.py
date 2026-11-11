#!/usr/bin/env python3
"""Pack an autopilot case for rendering: export_frames.py <case> -> <case>/frames.npz
(t, alpha.air and U.water on the 60x120 grid every write, plus autopilot.json)."""
import json, os, re, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import traj as T

case = sys.argv[1]
ix, iy, cnt = T.grid_index(case)
ds = sorted((d for d in os.listdir(case) if re.fullmatch(r'[0-9.]+', d) and float(d) >= 20.0), key=float)
A, U, V = [], [], []
for d in ds:
    a = T.read_internal(os.path.join(case, d, 'alpha.air'), False)
    u = T.read_internal(os.path.join(case, d, 'U.water'), True)
    g = [np.zeros((T.NX, T.NY)) for _ in range(3)]
    for G, val in zip(g, (a, u[:, 0], u[:, 1])):
        np.add.at(G, (ix, iy), val)
        G /= cnt
    A.append(g[0]); U.append(g[1]); V.append(g[2])
np.savez_compressed(os.path.join(case, 'frames.npz'), t=np.array([float(d) - 20.0 for d in ds]),
                    alpha=np.array(A, np.float32), u=np.array(U, np.float32), v=np.array(V, np.float32))
print(case, len(ds), 'frames')
