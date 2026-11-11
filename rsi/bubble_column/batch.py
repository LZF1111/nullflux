#!/usr/bin/env python3
"""Batch runner for Phase 1 (static training set) and later validation runs.

  batch.py lattice  [--n 6] [--jobs 28]   all zone splits (i,j,k)/n of the total gas, i+j+k=n
  batch.py file     <list.json> [--jobs N] run the param dicts listed in a JSON file
  batch.py collect     gather runs/*/traj.json -> runs/dataset.json

Runs go to ~/bubble_col/runs/<id>; existing finished runs are skipped.
"""
import argparse, glob, json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import zone_eval as ZE

RUNS = os.path.expanduser('~/bubble_col/runs')
UG = ZE.CONTRACT['zones']['Ug_total_ms']


def run_one(p):
    case = os.path.join(RUNS, p['id'])
    res = os.path.join(case, 'result.json')
    if os.path.exists(res) and json.load(open(res)).get('status') == 'done':
        return p['id'], 'skip'
    os.makedirs(RUNS, exist_ok=True)
    pp = os.path.join(RUNS, p['id'] + '.params.json')
    json.dump(p, open(pp, 'w'))
    r = subprocess.run([sys.executable, os.path.join(HERE, 'case_runner.py'), case, pp],
                capture_output=True, text=True)
    return p['id'], 'done' if r.returncode == 0 else 'FAILED'


def run_all(plist, jobs):
    with ThreadPoolExecutor(jobs) as ex:
        for pid, st in ex.map(run_one, plist):
            print(pid, st, flush=True)


def cmd_lattice(a):
    n = a.n
    plist = []
    for i in range(n + 1):
        for j in range(n + 1 - i):
            k = n - i - j
            z = [3 * UG * i / n, 3 * UG * j / n, 3 * UG * k / n]
            plist.append(dict(id=f'L{n}_{i}{j}{k}', zones=z))
    print(f'{len(plist)} lattice runs, {a.jobs} parallel', flush=True)
    run_all(plist, a.jobs)


def cmd_file(a):
    run_all(json.load(open(a.path)), a.jobs)


def cmd_collect(_):
    data = []
    for f in sorted(glob.glob(os.path.join(RUNS, '*', 'traj.json'))):
        d = json.load(open(f))
        d.pop('paths', None)
        data.append(d)
    out = os.path.join(RUNS, 'dataset.json')
    json.dump(data, open(out, 'w'))
    print(f'{len(data)} runs -> {out}')


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    p = sp.add_parser('lattice'); p.add_argument('--n', type=int, default=6); p.add_argument('--jobs', type=int, default=28)
    p = sp.add_parser('file'); p.add_argument('path'); p.add_argument('--jobs', type=int, default=8)
    sp.add_parser('collect')
    a = ap.parse_args()
    globals()['cmd_' + a.cmd](a)


if __name__ == '__main__':
    main()
