"""并行、非阻塞的试验调度器。
- 候选进 arch['queue']（带 fidelity 级别）；tick() 收割结束的试验、按空闲核数启动新试验，然后立即返回。
- 每个试验是一个后台 `node cfd_trial.js cfg.json`；pid 记在存档里，调度器进程重启后照样能收割（看 trial-result.json）。
- 分级筛选：低保真度结束 → screen_decide → 晋级就把同一候选以下一级重新入队，淘汰就记 pruned；完整级别 → decide。
- 只有一个保真度时，试验目录、trialId、study_spec.json 与旧 rsi/distributor 完全一致（回归要求）。"""
import glob, json, os, subprocess, sys, time

from . import archive as A
from . import claims as CL


def busy_cores_proc():
    """正在跑的 *Foam 进程数（/proc/*/comm 截断到 15 字符，看 cmdline 的 argv0）"""
    n = 0
    for p in glob.glob('/proc/[0-9]*/cmdline'):
        try:
            with open(p, 'rb') as f: argv0 = f.read().split(b'\0')[0].decode(errors='replace')
            if os.path.basename(argv0).endswith('Foam'): n += 1
        except OSError: pass
    return n


def pid_alive(pid):
    if not pid: return False
    try:
        # 本进程启动的子进程结束后是僵尸，kill(0) 仍成功：先收尸
        if os.waitpid(int(pid), os.WNOHANG)[0] == int(pid): return False
    except (ChildProcessError, OSError, ValueError, AttributeError): pass
    try: os.kill(int(pid), 0); return True
    except (OSError, ValueError): return False


class Scheduler:
    def __init__(self, study, busy_cores=busy_cores_proc, cpus=None, launcher=None, verifier=None, alive=pid_alive,
                 now=time.time, log=print, claims=None, speculative=False):
        self.s = study
        # 预跑：对照还在跑（未判定）时也启动普通候选，但完整级别的结果要等对照 control_ok 后才判定
        self.speculative = speculative
        self.claims = claims if claims is not None else os.environ.get('RSI_CLAIMS', '')
        self.busy_cores, self.cpus = busy_cores, cpus or (os.cpu_count() or 1)
        self.launcher = launcher or self._launch
        self.verifier = verifier or self._verify
        self.alive, self.now, self.log = alive, now, log
        self.arch_path = os.path.join(study.work_root, 'archive.json')
        self.fids = study.fidelities()
        assert self.fids and self.fids[-1].full and sum(f.full for f in self.fids) == 1, 'exactly one full fidelity, last'

    # ---- 路径与命名 ----
    def single(self): return len(self.fids) == 1

    def fid(self, name): return next(f for f in self.fids if f.name == name)

    def trial_id(self, h, fid): return h if self.single() else f'{h}-{fid}'

    def trial_dir(self, h, fid): return os.path.join(self.s.work_root, 'trials', self.trial_id(h, fid))

    def spec_path(self, fid):
        return os.path.join(self.s.work_root, 'study_spec.json' if self.single() else f'study_spec_{fid}.json')

    def load(self): return A.load(self.arch_path, self.s)

    def save(self, a): A.save(self.arch_path, a)

    # ---- 入队 ----
    def enqueue(self, chk, control=False, arch=None):
        """把一个已 check 的候选放进队列（最低保真度）。返回 (ok, 原因)。"""
        own = arch is None; a = arch or self.load()
        if not chk.get('ok') and not control: return False, '候选违反约束：' + '; '.join(chk.get('violations', [])[:5])
        if chk['hash'] in a['trials'] or any(q['hash'] == chk['hash'] for q in a['queue']):
            return False, f"候选 {chk['hash']} 已试过或已在队列"
        ctl_known = any(q.get('control') for q in a['queue']) or any(t.get('control') for t in a['trials'].values())
        if a['control'] is None and not control and not ctl_known:
            return False, '先跑对照，验证流水线能复现基准'
        if (a['control'] or {}).get('state') == 'control_failed': return False, '对照未复现基准：流水线有问题，停止搜索'
        first = self.fids[0].name
        a['queue'].append(dict(hash=chk['hash'], path=chk['path'], cell=chk.get('cell'), features=chk.get('features', {}),
                               surrogate=self.s.surrogate(chk, a), control=bool(control), fidelity=first, queued=self.now()))
        if own: self.save(a)
        return True, 'queued'

    # ---- 启动 ----
    def free_cores(self, a):
        # 刚启动的试验 mapFields/decompose 阶段还没有 Foam 进程：按存档里运行中的核数补上；
        # 别的调度器/外部作业登记在 claims 文件里的"正在启动"核数也要扣掉
        starting = sum(self.s.fidelity_np(self.fid(r['fidelity'])) for t in a['trials'].values()
                       for r in [t.get('run') or {}] if r and not r.get('solving_seen'))
        ext = CL.others(self.claims, self.s.name) if self.claims else 0
        return self.cpus - self.s.reserve_cores - self.busy_cores() - starting - ext

    def _start(self, a, q):
        s, f = self.s, self.fid(q['fidelity'])
        chk = s.check(q['path'])
        params = s.trial_params(chk, f, q['control'])
        pipe = s.pipeline(f)
        tid, tdir = self.trial_id(q['hash'], f.name), self.trial_dir(q['hash'], f.name)
        cfg = dict(baseCase=s.base_case, trialDir=tdir, studyId=s.name, trialId=tid, params=params, **pipe)
        os.makedirs(os.path.join(s.work_root, 'configs'), exist_ok=True)
        cpath = os.path.join(s.work_root, 'configs', tid + '.json')
        with open(cpath, 'w') as fh: json.dump(cfg, fh, indent=1)
        with open(self.spec_path(f.name), 'w') as fh: json.dump(dict(study_id=s.name, base_case=s.base_case, pipeline=pipe), fh, indent=1)
        rec = a['trials'].get(q['hash']) or dict(hash=q['hash'], path=q['path'], cell=q['cell'], features=q['features'],
                                                 surrogate=q['surrogate'], control=q['control'], started=self.now())
        rec['state'] = 'running'
        if self.claims: CL.add(self.claims, f'{s.name}:{tid}', s.fidelity_np(f), owner=s.name)
        pid = self.launcher(cpath, os.path.join(s.work_root, 'configs', tid + '.out'))
        rec['run'] = dict(fidelity=f.name, pid=pid, config=cpath, params=params, trial_id=tid, trial_dir=tdir, t=self.now())
        a['trials'][q['hash']] = rec
        self.log(f"start {tid} np={s.fidelity_np(f)} pid={pid}")

    def _launch(self, cpath, out):
        fh = open(out, 'ab')
        p = subprocess.Popen(['node', self.s.cfd_trial, cpath], stdout=fh, stderr=subprocess.STDOUT, start_new_session=True)
        return p.pid

    @staticmethod
    def _solver_started(tdir):
        """求解器已经在跑（solve 日志里出现时间步）：此后它的核由 busy_cores() 计入"""
        p = os.path.join(tdir, 'logs', 'solve.stdout.log')
        try:
            with open(p, 'rb') as fh:
                fh.seek(max(0, os.path.getsize(p) - 65536)); return b'Time = ' in fh.read()
        except OSError:
            return False

    # ---- 收割 ----
    def _verify(self, res_path, tid, value, spec, params, tdir):
        v = subprocess.run(['node', self.s.cfd_trial, '--verify', res_path, '--study-id', self.s.name, '--trial-id', tid,
                            '--value', repr(value), '--study-spec', spec, '--params', json.dumps(params), '--trial-dir', tdir],
                           capture_output=True, text=True)
        return v.returncode == 0, v.stderr[-500:]

    def _reap(self, a, h, rec):
        run = rec['run']; f = self.fid(run['fidelity']); tdir = run['trial_dir']
        res_path = os.path.join(tdir, 'trial-result.json')
        if self.alive(run.get('pid')):
            if not run.get('solving_seen') and self._solver_started(tdir):
                run['solving_seen'] = True
                if self.claims: CL.remove(self.claims, f"{self.s.name}:{run['trial_id']}")
            return False
        if self.claims: CL.remove(self.claims, f"{self.s.name}:{run['trial_id']}")
        if not rec['control'] and os.path.exists(res_path):
            ctl = (a['control'] or {}).get('state')
            if ctl == 'control_failed':
                rec.pop('run'); rec['state'] = 'invalid'; rec['error'] = '对照未复现基准：预跑结果作废'
                self.log(f"void {h} [{f.name}]: 对照失败，预跑结果作废"); return True
            if ctl != 'control_ok':
                if not run.get('deferred'): self.log(f"defer {h} [{f.name}]: 对照未判定，结果暂不登记"); run['deferred'] = True
                return False
        if not os.path.exists(res_path):
            # 预检就被拒（没建候选目录）：框架错误，不登记成物理结果
            self.log(f"reject {run['trial_id']}: cfd_trial 预检拒绝（未登记）")
            if 'fidelity' in rec: rec['state'] = 'error'; rec.pop('run')
            else: del a['trials'][h]
            return True
        with open(res_path, encoding='utf-8') as fh: res = json.load(fh)
        ev, err = False, res.get('error')
        if res.get('passed'):
            ev, verr = self.verifier(res_path, run['trial_id'], res['value'], self.spec_path(f.name), run['params'], tdir)
            if not ev: err = 'evidence: ' + verr
        mp = os.path.join(tdir, 'metrics.json')
        metrics = {}
        if os.path.exists(mp):
            with open(mp, encoding='utf-8') as fh: metrics = json.load(fh)
        vis, sealed = A.split_metrics(self.s, metrics)
        rec.pop('run')
        if f.full:
            rec.update(ended=self.now(), cfd_passed=bool(res.get('passed')), error=err, evidence_verified=ev,
                       metrics_visible=vis, metrics_sealed=sealed, fidelity_final=f.name)
            if not self.single(): rec.setdefault('fidelity', {})[f.name] = dict(valid=bool(res.get('passed')) and ev, evidence_verified=ev)
            A.decide(self.s, a, rec, res)
            self.log(f"done {h} [{f.name}] {rec['state']}")
        else:
            rec.setdefault('fidelity', {})[f.name] = dict(evidence_verified=ev, metrics_visible=vis, error=err, ended=self.now())
            verdict = A.screen_decide(self.s, a, rec, f.name, res, vis)
            if verdict == 'promote':
                nxt = self.fids[self.fids.index(f) + 1].name
                rec['state'] = 'promoted'
                a['queue'].insert(0, dict(hash=h, path=rec['path'], cell=rec['cell'], features=rec['features'],
                                          surrogate=rec['surrogate'], control=rec['control'], fidelity=nxt, queued=self.now()))
            else:
                rec['state'] = 'pruned'   # 被淘汰的不占 MAP-Elites 格子
            self.log(f"screen {h} [{f.name}] {verdict}")
        return True

    # ---- 一拍 ----
    def tick(self):
        """收割 → 按空闲核启动。返回 dict(running, queued, started, reaped)。不阻塞。"""
        a = self.load(); reaped = started = 0
        for h, rec in list(a['trials'].items()):
            if rec.get('run') and self._reap(a, h, rec): reaped += 1
        if (a['control'] or {}).get('state') == 'control_failed':
            a['queue'] = [q for q in a['queue'] if q.get('control')]
        # 对照没完成前不启动普通候选（对照决定流水线是否可信）；预跑模式下只要对照已在跑/排队就放行
        hold = self._ctl_pending(a) and not (self.speculative and self._ctl_known(a))
        i = 0
        while i < len(a['queue']):
            q = a['queue'][i]
            if hold and not q['control']: i += 1; continue
            need = self.s.fidelity_np(self.fid(q['fidelity']))
            if self.free_cores(a) < need: break
            a['queue'].pop(i); self._start(a, q); started += 1
        self.save(a)
        running = sum(1 for t in a['trials'].values() if t.get('run'))
        return dict(running=running, queued=len(a['queue']), started=started, reaped=reaped)

    @staticmethod
    def _ctl_pending(a):
        return a['control'] is None or a['control'].get('state') != 'control_ok'

    @staticmethod
    def _ctl_known(a):
        return any(q.get('control') for q in a['queue']) or any(t.get('control') for t in a['trials'].values())

    def idle(self, a=None):
        a = a or self.load()
        return not a['queue'] and not any(t.get('run') for t in a['trials'].values())
