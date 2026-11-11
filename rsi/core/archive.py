"""存档与接受判据（与具体研究无关）。存档格式与 rsi/distributor/archive.json 兼容：
study, champion, control, cells, trials, surrogate；新增 queue（待跑的候选）和每个试验的 fidelity 子记录。"""
import json, math, os


def load(path, study):
    if os.path.exists(path):
        a = json.load(open(path, encoding='utf-8'))
    else:
        a = dict(study=study.name, champion=None, control=None, cells={}, trials={}, surrogate=study.default_surrogate())
    a.setdefault('queue', [])
    return a


def save(path, a):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(a, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def split_metrics(study, metrics):
    sealed = set(study.sealed)
    return ({k: v for k, v in metrics.items() if k not in sealed}, {k: v for k, v in metrics.items() if k in sealed})


def decide(study, arch, rec, res):
    """完整保真度试验结束后的判定。对照 → control_ok/failed；无效证据 → invalid；
    否则对冠军做带噪声的接受：增益 > max(accept_min_gain, kappa·hypot(噪声))。MAP-Elites 每格留目标最小者。"""
    m = rec.get('metrics_visible', {})
    valid = bool(res.get('passed')) and rec.get('evidence_verified')
    if rec['control']:
        ok, d = study.control_check(m, valid)
        rec['state'] = 'control_ok' if ok else 'control_failed'
        rec['control_diff'] = d
        arch['control'] = rec
        if ok and arch['champion'] is None: arch['champion'] = rec['hash']
        return
    if not valid: rec['state'] = 'invalid'; return
    champ = arch['trials'].get(arch['champion'] or '', None)
    if champ is None:
        rec['state'] = 'accepted'
    else:
        cm = champ['metrics_visible']
        gain = study.objective(cm) - study.objective(m)
        need = max(study.accept_min_gain, study.accept_kappa * math.hypot(study.noise(m), study.noise(cm)))
        rec['gain'] = gain; rec['need'] = need
        rec['state'] = 'accepted' if gain > need else 'rejected'
    if rec['state'] == 'accepted': arch['champion'] = rec['hash']
    elite = arch['trials'].get(arch['cells'].get(rec['cell'], ''), None)
    if elite is None or study.objective(m) < study.objective(elite['metrics_visible']): arch['cells'][rec['cell']] = rec['hash']


def screen_reference(study, arch, fid):
    """分级筛选的参照：冠军（没有就对照）在该保真度上的目标与噪声；都没跑过这一级就返回 None（直接晋级）。"""
    for h in (arch.get('champion'), (arch.get('control') or {}).get('hash')):
        t = arch['trials'].get(h or '')
        r = (t or {}).get('fidelity', {}).get(fid)
        if r and r.get('valid'): return r
    # 参照只跑过完整级别（如旧流水线跑的对照）：退回用它的完整级别目标。跨级偏差要由 screen_margin 覆盖
    for h in (arch.get('champion'), (arch.get('control') or {}).get('hash')):
        t = arch['trials'].get(h or '')
        m = (t or {}).get('metrics_visible') or {}
        if t and t.get('state') in ('accepted', 'control_ok') and m:
            try: return dict(objective=study.objective(m), noise=study.noise(m), valid=True, cross_fidelity=True)
            except (KeyError, TypeError, ValueError): pass
    return None


def screen_decide(study, arch, rec, fid, res, metrics):
    """低保真度结果 → promote / prune。只淘汰"明显更差"的：目标比参照差超过 margin + kappa·hypot(噪声)。
    对照和参照缺失时总是晋级，所以分级只会少跑、不会错杀冠军候选之外的东西。"""
    valid = bool(res.get('passed')) and bool(rec.get('fidelity', {}).get(fid, {}).get('evidence_verified'))
    r = rec.setdefault('fidelity', {}).setdefault(fid, {})
    r['valid'] = valid
    if valid:
        r['objective'] = study.objective(metrics); r['noise'] = study.noise(metrics)
    if rec['control']: return 'promote'
    if not valid: return 'prune'
    ref = screen_reference(study, arch, fid)
    if ref is None: return 'promote'
    worse = r['objective'] - ref['objective']
    allow = study.screen_margin + study.screen_kappa * math.hypot(r['noise'], ref.get('noise', 0.0))
    r['screen_worse'] = worse; r['screen_allow'] = allow; r['screen_ref_cross'] = bool(ref.get('cross_fidelity'))
    return 'prune' if worse > allow else 'promote'


def n_done(study, arch):
    """有完整目标值的试验数（与旧 campaign.n_done 同口径：不看状态）"""
    return sum(1 for t in arch['trials'].values() if _has_obj(study, t))


def _has_obj(study, t):
    try: return math.isfinite(study.objective(t.get('metrics_visible') or {}))
    except (KeyError, TypeError, ValueError): return False
