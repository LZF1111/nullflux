#!/usr/bin/env python3
"""Run one bubble-column case on the server.

  case_runner.py <case_dir> <params.json>

params.json:
  {"id": "...", "zones": [Ug1, Ug2, Ug3]}       static: this config from t=0
  {"id": "...", "schedule": [{"t": 20.0, "zones": [...]}, ...]} dynamic: uniform until the
        first entry, then step changes (0.05 s linear ramp) at each t
Steps: copy template -> zone tables -> blockMesh -> setFields -> writeCellCentres ->
solve to settle_s (one write) -> solve to settle_s+track_s writing every write_interval_s ->
traj.py -> traj.json. Fails loudly; result.json records status and wall time.
"""
import json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import zone_eval as ZE

C = ZE.CONTRACT
TH = C['thresholds']
ALPHA_IN = C['physics']['alpha_inlet']
UG = C['zones']['Ug_total_ms']
SETTLE = float(os.environ.get('BC_SETTLE', TH['settle_s']))
TRACK = float(os.environ.get('BC_TRACK', TH['track_s']))
RAMP = 0.05


def norm_zones(z):
    """n zones of equal width: scale to the fixed total gas flow (mean Ug = UG)."""
    z = [max(0.0, float(v)) for v in z]
    m = sum(z) / len(z)
    if m <= 0:
        sys.exit('bad zones: no gas')
    return [v * UG / m for v in z]


def check_zones(z):
    if len(z) != 3:
        return norm_zones(z)
    r = ZE.check(z)
    if not r['ok']:
        sys.exit('bad zones: ' + '; '.join(r['violations']))
    return r['zones']


def schedule_from(p):
    """-> list of (t, [Ug1,Ug2,Ug3]) breakpoints, piecewise linear in time."""
    if 'zones' in p:
        z = check_zones(p['zones'])
        return [(0.0, z), (1000.0, z)]
    steps = []
    for e in sorted(p['schedule'], key=lambda e: float(e['t'])):
        steps.append((float(e['t']), check_zones(e['zones'])))
    n = len(steps[0][1])
    bp, cur = [(0.0, [UG] * n)], [UG] * n
    for t, z in steps:
        bp += [(t, cur), (t + RAMP, z)]
        cur = z
    bp.append((1000.0, cur))
    return bp


def write_tables(case, bp):
    for i in range(len(bp[0][1])):
        u = [(t, (0.0, z[i] / ALPHA_IN, 0.0) if z[i] > 0 else (0.0, 0.0, 0.0)) for t, z in bp]
        a = [(t, ALPHA_IN if z[i] > 0 else 0.0) for t, z in bp]
        with open(os.path.join(case, 'constant', f'zone{i + 1}_U.dat'), 'w', newline='\n') as f:
            f.write('(\n' + ''.join(f'    ({t:.6f} ({v[0]:g} {v[1]:.8g} {v[2]:g}))\n' for t, v in u) + ')\n')
        with open(os.path.join(case, 'constant', f'zone{i + 1}_alpha.dat'), 'w', newline='\n') as f:
            f.write('(\n' + ''.join(f'    ({t:.6f} {v:g})\n' for t, v in a) + ')\n')


def apply_model(case, m):
    """Model variants for the sim2real sensitivity study: params["model"] =
    {"lift": "Tomiyama", "td": "Burns" | "LopezDeBertodano", "db": 0.006}."""
    if not m:
        return
    pp = os.path.join(case, 'constant', 'phaseProperties')
    s = open(pp).read()
    if m.get('db'):
        s, n = re.subn(r'(d0\s+)[^;]+;', rf"\g<1>{m['db']:g};", s, count=1)
        assert n == 1, 'd0 not found'
    if m.get('lift'):
        s, n = re.subn(r'^lift\s*\(\s*\);', 'lift\n(\n    (air in water) { type %s; }\n);' % m['lift'], s, flags=re.M)
        assert n == 1, 'lift () not found'
    if m.get('td'):
        coef = {'Burns': 'sigma 0.9;', 'LopezDeBertodano': 'Ctd 1.0;'}[m['td']]
        s, n = re.subn(r'^turbulentDispersion\s*\(\s*\);',
                'turbulentDispersion\n(\n    (air in water) { type %s; %s }\n);' % (m['td'], coef), s, flags=re.M)
        assert n == 1, 'turbulentDispersion () not found'
    open(pp, 'w', newline='\n').write(s)


def set_ctrl(case, **kv):
    p = os.path.join(case, 'system', 'controlDict')
    s = open(p).read()
    for k, v in kv.items():
        s, n = re.subn(rf'^{k}\s+[^;]*;', f'{k:<16}{v};', s, flags=re.M)
        if n != 1:
            sys.exit(f'controlDict: {k} not found')
    open(p, 'w', newline='\n').write(s)


def foam(case, app, log, *args):
    bashrc = C['run']['foam_bashrc']
    cmd = f'source {bashrc} >/dev/null 2>&1; {app} {" ".join(args)} > {log} 2>&1'
    r = subprocess.run(['bash', '-c', cmd], cwd=case)
    txt = open(os.path.join(case, log), errors='replace').read()
    if r.returncode != 0 or 'FOAM FATAL' in txt or not re.search(r'^End\s*$', txt, re.M):
        raise RuntimeError(f'{app} failed (rc={r.returncode}); tail:\n' + txt[-1500:])


def main():
    case, ppath = sys.argv[1], sys.argv[2]
    p = json.load(open(ppath))
    t0 = time.time()
    res = dict(id=p.get('id'), params=p, status='running', host=os.uname().nodename)
    if os.path.exists(case):
        shutil.rmtree(case)
    shutil.copytree(os.path.join(HERE, p.get('template', 'case_template')), case)
    json.dump(p, open(os.path.join(case, 'params.json'), 'w'), indent=1)
    try:
        write_tables(case, schedule_from(p))
        apply_model(case, p.get('model'))
        foam(case, 'blockMesh', 'log.blockMesh')
        foam(case, 'setFields', 'log.setFields')
        foam(case, 'postProcess', 'log.cellCentres', '-func', 'writeCellCentres', '-time', '0')
        set_ctrl(case, endTime=SETTLE, writeInterval=SETTLE)
        foam(case, 'twoPhaseEulerFoam', 'log.solve1')
        set_ctrl(case, endTime=SETTLE + TRACK, writeInterval=TH['write_interval_s'])
        foam(case, 'twoPhaseEulerFoam', 'log.solve2')
        r = subprocess.run([sys.executable, os.path.join(HERE, 'traj.py'), case], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError('traj.py failed:\n' + (r.stderr or r.stdout)[-1500:])
        res['status'] = 'done'
    except Exception as e:
        res['status'] = 'failed'
        res['error'] = str(e)
    res['wall_s'] = round(time.time() - t0, 1)
    json.dump(res, open(os.path.join(case, 'result.json'), 'w'), indent=1)
    print(json.dumps({k: res[k] for k in ('id', 'status', 'wall_s')}))
    sys.exit(0 if res['status'] == 'done' else 1)


if __name__ == '__main__':
    main()
