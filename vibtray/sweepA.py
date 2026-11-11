"""Level A sweeps: true-size periodic patches. Usage: python sweepA.py <name>"""
import json, math, sys, time
import numpy as np
import taichi as ti
ti.init(arch=ti.cuda, default_fp=ti.f32, device_memory_GB=5, offline_cache=True)
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
import dem as D
import patch as PT

G = PT.gamma_to_amp
OUT = __import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), 'results')


def vert(f, gz, **kw):
	d = dict(f=f, Az=G(gz, f), label=f'V f{f:g} Gz{gz:g}')
	d.update(kw)
	return d


def horiz(f, gh, gz=0.0, phase_deg=None, circ=False, **kw):
	"""Horizontal along x; with gz>0 and phase_deg, vertical leads horizontal by phase."""
	d = dict(f=f, Ax=G(gh, f), Az=G(gz, f))
	if circ:
		d['Ay'] = G(gh, f)
		d['phy'] = math.pi / 2
	if phase_deg is not None:
		d['phx'] = -math.radians(phase_deg)
	d['label'] = (f'{"C" if circ else "H"} f{f:g} Gh{gh:g} Gz{gz:g}'
				  + (f' ph{phase_deg:g}' if phase_deg is not None else ''))
	d.update(kw)
	return d


SWEEPS = {}

SWEEPS['regime'] = dict(
	cases=[vert(f, gz) for f in (30, 60, 120) for gz in (0.8, 1.5, 2.5, 4.0, 6.0)]
	+ [horiz(60, gh) for gh in (0.3, 0.6, 1.2)]
	+ [horiz(60, gh, circ=True) for gh in (0.3, 0.6, 1.2)]
	+ [horiz(60, 0.8, gz=1.5, phase_deg=p) for p in (0, 45, 90, 135, 180)]
	+ [horiz(60, 0.8, gz=1.5, phase_deg=90, eps=0.2, Tm=0.05, label='CONV60 FM20')],
	kw=dict(t_settle=0.03, t_warm=0.12, t_meas=0.3, L=4e-3, dt=1.5e-6))


def main(name):
	sw = SWEEPS[name]
	t0 = time.time()
	out, meta = PT.run([dict(c) for c in sw['cases']], **sw['kw'])
	meta['name'] = name
	meta['wall_total'] = time.time() - t0
	for o in out:
		o['case'] = {k: v for k, v in o['case'].items() if k != 'vanes'}
	json.dump(dict(meta=meta, out=out), open(f'{OUT}\\A_{name}.json', 'w'), indent=1, default=float)
	print('wall', meta['wall_total'], 'N', meta['N'], 'flags', meta['flags'])
	for o in out:
		print(f"{o['case']['label']:28s} dz={o['dz_cm']*1e6:7.1f}um zmax={o['zmax']*1e3:6.2f}mm "
			  f"T={o['Tgran']:.2e} v=({o['vx']*1e3:6.2f},{o['vy']*1e3:6.2f})mm/s "
			  f"e={o['expo_mean']:.3f} ev/s={o['events_per_s']:6.1f} cv={o['cv_end']:.3f} "
			  f"b={o['cv_fit'][1]:.2f} iso={o['iso']:.3f} vpw99={o['vimp_pw99']:.3f} "
			  f"vpp99={o['vimp_pp99']:.3f} ovl={o['ovl_max']:.3f}")


if __name__ == '__main__':
	main(sys.argv[1])
