#!/usr/bin/env python3
"""NullFlux v6 — Optuna ask-tell 优化驱动
被 server.js 通过 child_process 调用；I/O 全走 stdin/stdout JSON。

子命令：
  create   --study_id S --base_dir D --spec '<json>'
  suggest  --study_id S --base_dir D
  record   --study_id S --base_dir D --trial_id N --value V --state STATE
  status   --study_id S --base_dir D
  render   --study_id S --base_dir D --kind history|importance|parallel|slice --out PATH
  list     --base_dir D

存储布局：
  <base_dir>/<study_id>/study.json         # 我们写的元数据（search_space, base_case, objective）
  <base_dir>/<study_id>/optuna.db          # Optuna SQLite 存所有 trial
  <base_dir>/<study_id>/trials.jsonl       # 我们写的可读 trial log（append-only）
"""

import argparse, hashlib, json, math, os, re, subprocess, sys, time
from contextlib import contextmanager
from pathlib import Path

def _eprint(msg):
    print(msg, file=sys.stderr, flush=True)

def _study_dir(base_dir, study_id):
    if not isinstance(study_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", study_id):
        raise ValueError("Invalid study_id: expected [A-Za-z0-9_-]+")
    base = Path(base_dir).resolve()
    p = base / study_id
    _safe_path(p, base)
    return p

def _safe_path(path, root):
    path = Path(path).absolute()
    if not path.is_relative_to(root):
        raise ValueError("Path escapes study directory")
    for component in [path, *path.parents]:
        if component.is_symlink() or getattr(component, "is_junction", lambda: False)():
            raise ValueError(f"Unsafe linked path: {component}")
        if component == root:
            break
    if not path.resolve().is_relative_to(root):
        raise ValueError("Path escapes study directory")
    return path

def _canonical(spec):
    return json.dumps({key: value for key, value in spec.items() if key != "created_at"},
                      sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)

def _contract_hash(spec):
    return hashlib.sha256(_canonical(spec).encode("utf-8")).hexdigest()

def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)

def _validate_spec(spec, study_id):
    if not isinstance(spec, dict):
        raise ValueError("spec must be an object")
    if spec.get("study_id", study_id) != study_id:
        raise ValueError("spec study_id does not match requested study_id")
    spec = dict(spec, study_id=study_id)
    if spec.get("require_cfd_evidence", True) is not True:
        raise ValueError("CFD evidence cannot be disabled")
    spec["require_cfd_evidence"] = True
    if not isinstance(spec.get("base_case"), str) or not spec["base_case"].strip() or "\0" in spec["base_case"]:
        raise ValueError("base_case is required")
    pipeline = spec.get("pipeline")
    if not isinstance(pipeline, dict) or any(
        not isinstance(pipeline.get(key), dict) or not pipeline[key]
        for key in ("stages", "acceptance")
    ):
        raise ValueError("pipeline requires nonempty stages and acceptance objects")
    objective = spec.get("objective", {})
    if not isinstance(objective, dict) or objective.get("direction", "minimize") not in ("minimize", "maximize"):
        raise ValueError("objective.direction must be minimize or maximize")
    budget = spec.get("n_trials_budget")
    if budget is not None and (type(budget) is not int or budget <= 0):
        raise ValueError("n_trials_budget must be a positive integer")
    space = spec.get("search_space")
    if not isinstance(space, list) or not 1 <= len(space) <= 128:
        raise ValueError("search_space must contain 1..128 parameters")
    names = set()
    for param in space:
        if not isinstance(param, dict):
            raise ValueError("parameter must be an object")
        name = param.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", name) or name in names:
            raise ValueError("parameter names must be legal and unique")
        names.add(name)
        kind = param.get("type")
        if kind == "cat":
            choices = param.get("choices")
            if not isinstance(choices, list) or not 1 <= len(choices) <= 1024:
                raise ValueError("categorical choices must contain 1..1024 values")
            if any(not (value is None or type(value) in (str, bool) or _finite(value)) for value in choices):
                raise ValueError("categorical choices must be finite JSON scalars")
            if len({json.dumps(value, sort_keys=True) for value in choices}) != len(choices):
                raise ValueError("categorical choices must be unique")
        elif kind in ("float", "int"):
            low, high = param.get("low"), param.get("high")
            if not _finite(low) or not _finite(high) or low > high:
                raise ValueError("parameter bounds must be finite and ordered")
            if kind == "int" and (type(low) is not int or type(high) is not int):
                raise ValueError("int parameter bounds must be integers")
            logarithmic = param.get("log", False)
            if type(logarithmic) is not bool or (logarithmic and low <= 0):
                raise ValueError("invalid logarithmic parameter")
            step = param.get("step", 1 if kind == "int" else None)
            if step is not None and (not _finite(step) or step <= 0 or (kind == "int" and type(step) is not int)):
                raise ValueError("step must be finite, positive and match parameter type")
            if logarithmic and step is not None and (kind == "float" or step != 1):
                raise ValueError("log parameters do not support this step")
        else:
            raise ValueError("unknown parameter type")
        if "grid" in param:
            grid = param["grid"]
            if kind == "cat" or not isinstance(grid, list) or not 1 <= len(grid) <= 1024:
                raise ValueError("numeric grid must contain 1..1024 values")
            if any(not _finite(value) or not low <= value <= high or
                   (kind == "int" and type(value) is not int) or
                   (step is not None and not math.isclose((value - low) / step, round((value - low) / step), abs_tol=1e-8))
                   for value in grid) or len(set(grid)) != len(grid):
                raise ValueError("grid values must be unique and inside the parameter distribution")
    _canonical(spec)
    return spec

@contextmanager
def _study_lock(sd):
    lock = _safe_path(sd / ".driver.lock", sd)
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        yield
    finally:
        os.close(descriptor)
        lock.unlink()

def _log(sd, entry):
    with _safe_path(sd / "trials.jsonl", sd).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(dict(entry, ts=time.time()), ensure_ascii=False, allow_nan=False) + "\n")

def _storage_url(study_dir):
    _safe_path(study_dir / "optuna.db", study_dir)
    return f"sqlite:///{(study_dir / 'optuna.db').as_posix()}"

def _load_spec(study_dir):
    f = _safe_path(study_dir / "study.json", study_dir)
    if not f.exists():
        raise RuntimeError(f"study.json not found in {study_dir}")
    return json.loads(f.read_text(encoding="utf-8"))

def _sampler(spec):
    import optuna
    name = spec.get("sampler", "TPE")
    if isinstance(name, str) and name.upper() == "GRID":
        space = {}
        for param in spec["search_space"]:
            values = param.get("choices") if param["type"] == "cat" else param.get("grid")
            if not values:
                raise ValueError(f"GRID requires choices or grid for {param['name']}")
            space[param["name"]] = values
        return optuna.samplers.GridSampler(space, seed=spec.get("seed"))
    return _make_sampler(name, seed=spec.get("seed"))

def _load_study(sd, study_id):
    import optuna
    raw_spec = _load_spec(sd)
    disk_hash = _contract_hash(raw_spec)
    spec = _validate_spec(raw_spec, study_id)
    study = optuna.load_study(study_name=study_id, storage=_storage_url(sd),
                              sampler=_sampler(spec), pruner=_make_pruner(spec.get("pruner")))
    stored = study.user_attrs.get("contract_hash")
    if not stored:
        raise RuntimeError("Legacy study has no contract_hash; migrate to a new study")
    if stored != disk_hash:
        raise RuntimeError("study.json contract changed; create a new study")
    return study, spec

def _make_sampler(name, seed=None):
    import optuna
    name = (name or "TPE").upper()
    if name == "TPE":   return optuna.samplers.TPESampler(seed=seed)
    if name == "GP":    return optuna.samplers.GPSampler(seed=seed)
    if name == "CMA":   return optuna.samplers.CmaEsSampler(seed=seed)
    if name == "RANDOM":return optuna.samplers.RandomSampler(seed=seed)
    if name == "GRID":
        # Grid 需要 search_space 字典；外部 caller 必须把 spec 里的 choices/网格点准备好
        return None  # 由 cmd_create 处理
    raise ValueError(f"unknown sampler: {name}")

def _make_pruner(name):
    import optuna
    if not name: return optuna.pruners.NopPruner()
    n = name.upper()
    if n == "MEDIAN":     return optuna.pruners.MedianPruner()
    if n == "HYPERBAND":  return optuna.pruners.HyperbandPruner()
    if n == "NOP": return optuna.pruners.NopPruner()
    raise ValueError(f"unknown pruner: {name}")

def _suggest_one(trial, p):
    name = p["name"]
    t = p["type"]
    if t == "float":
        return trial.suggest_float(name, float(p["low"]), float(p["high"]),
                                   log=bool(p.get("log", False)),
                                   step=p.get("step"))
    if t == "int":
        return trial.suggest_int(name, int(p["low"]), int(p["high"]),
                                 log=bool(p.get("log", False)),
                                 step=int(p.get("step", 1)))
    if t == "cat":
        return trial.suggest_categorical(name, p["choices"])
    raise ValueError(f"unknown param type: {t}")

# ----------------------------- commands -----------------------------

def cmd_create(args):
    import optuna
    sd = _study_dir(args.base_dir, args.study_id)
    spec = _validate_spec(json.loads(args.spec), args.study_id)
    spec.setdefault("created_at", time.time())
    direction = spec.get("objective", {}).get("direction", "minimize")
    sampler_name = spec.get("sampler", "TPE")
    sampler = _sampler(spec)
    pruner = _make_pruner(spec.get("pruner"))
    storage = _storage_url(sd)
    sd.mkdir(parents=True, exist_ok=True)
    with _study_lock(sd):
        spec_path = _safe_path(sd / "study.json", sd)
        if spec_path.exists():
            study, existing = _load_study(sd, args.study_id)
            if _contract_hash(existing) != _contract_hash(spec):
                raise ValueError("Existing study has a different configuration; create a new study")
        else:
            if (sd / "optuna.db").exists():
                raise RuntimeError("Existing database without contract spec; migrate to a new study")
            study = optuna.create_study(study_name=args.study_id, storage=storage,
                                       sampler=sampler, pruner=pruner, direction=direction)
            study.set_user_attr("contract_hash", _contract_hash(spec))
            spec_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
            _safe_path(sd / "trials.jsonl", sd).touch(exist_ok=True)

    print(json.dumps({
        "ok": True,
        "study_id": args.study_id,
        "study_dir": str(sd),
        "storage": storage,
        "direction": direction,
        "sampler": sampler_name,
        "n_params": len(spec["search_space"]),
    }, ensure_ascii=False))

def cmd_suggest(args):
    import optuna
    sd = _study_dir(args.base_dir, args.study_id)
    with _study_lock(sd):
        study, spec = _load_study(sd, args.study_id)
        budget = spec.get("n_trials_budget")
        if budget is not None and len(study.get_trials(deepcopy=False)) >= budget:
            raise RuntimeError("Trial budget exhausted")
        if isinstance(study.sampler, optuna.samplers.GridSampler) and study.sampler.is_exhausted(study):
            raise RuntimeError("GRID search exhausted")
        trial = study.ask()
        try:
            params = {param["name"]: _suggest_one(trial, param) for param in spec["search_space"]}
            trial_dir = _safe_path(sd / "trials" / f"trial_{trial.number:04d}", sd)
            out = {"ok": True, "study_id": args.study_id, "trial_id": trial.number,
                   "trial_number": trial.number, "params": params, "trial_dir_suggested": str(trial_dir)}
            _log(sd, {"event": "ask", "trial_id": trial.number, "params": params})
        except BaseException:
            _tell(study, trial.number, None, optuna.trial.TrialState.FAIL)
            raise
    print(json.dumps(out, ensure_ascii=False))

def _tell(study, number, value, state):
    import optuna
    try:
        study.tell(number, value, state=state)
    except RuntimeError:
        if not isinstance(study.sampler, optuna.samplers.GridSampler) or study.trials[number].state != state:
            raise

def _verify_evidence(args, sd, params):
    evidence = str(Path(args.evidence).resolve(strict=True))
    expected = _safe_path(sd / "trials" / f"trial_{args.trial_id:04d}", sd)
    command = ["node", str(Path(__file__).resolve().with_name("cfd_trial.js")),
               "--verify", evidence, "--study-id", args.study_id,
               "--trial-id", str(args.trial_id), "--value", str(args.value),
               "--study-spec", str(sd / "study.json"),
               "--params", json.dumps(params, sort_keys=True, allow_nan=False),
               "--trial-dir", str(expected)]
    completed = subprocess.run(command, check=True, timeout=120, capture_output=True, text=True)
    verification = json.loads(completed.stdout)
    if (not isinstance(verification, dict) or verification.get("passed") is not True or
        verification.get("studyId") != args.study_id or verification.get("trialId") != str(args.trial_id) or
        not _finite(verification.get("value")) or verification["value"] != args.value or
        not isinstance(verification.get("configHash"), str) or
        not re.fullmatch(r"[0-9a-f]{64}", verification["configHash"])):
        raise ValueError("Invalid verifier response: identity, value and configHash required")
    return evidence, verification

def cmd_record(args):
    import optuna
    sd = _study_dir(args.base_dir, args.study_id)
    state = (args.state or "COMPLETE").upper()
    state_map = {
        "COMPLETE": optuna.trial.TrialState.COMPLETE,
        "PRUNED":   optuna.trial.TrialState.PRUNED,
        "FAIL":     optuna.trial.TrialState.FAIL,
    }
    if state not in state_map:
        raise ValueError(f"unknown state: {state}")

    if args.value is not None and not _finite(args.value):
        raise ValueError("value must be finite")
    if state == "COMPLETE" and (args.value is None or not getattr(args, "evidence", None)):
        raise ValueError("COMPLETE requires finite --value and --evidence")
    if getattr(args, "evidence", None) and args.value is None:
        raise ValueError("Verifying evidence requires finite --value")
    with _study_lock(sd):
        study, spec = _load_study(sd, args.study_id)
        trial = next((trial for trial in study.get_trials(deepcopy=False) if trial.number == args.trial_id), None)
        if trial is None or trial.state != optuna.trial.TrialState.RUNNING:
            raise ValueError("Only an existing RUNNING trial can be recorded")
        evidence, verification = None, None
        if getattr(args, "evidence", None):
            evidence, verification = _verify_evidence(args, sd, trial.params)
        if _contract_hash(_load_spec(sd)) != study.user_attrs["contract_hash"]:
            raise RuntimeError("study.json contract changed during verification")
        live_trial = optuna.trial.Trial(study, trial._trial_id)
        if evidence:
            live_trial.set_user_attr("evidence", evidence)
            live_trial.set_user_attr("configHash", verification["configHash"])
        value = args.value if state == "COMPLETE" else None
        _tell(study, trial.number, value, state_map[state])
        _log(sd, {"event": "tell", "trial_id": args.trial_id, "value": value, "state": state,
                  "evidence": evidence, "configHash": verification["configHash"] if verification else None})

    out = {
        "ok": True,
        "trial_id": args.trial_id,
        "state": state,
        "value": value,
        "verification": verification,
        "n_done": len([t for t in study.get_trials(deepcopy=False) if t.state == optuna.trial.TrialState.COMPLETE]),
    }
    try:
        bt = study.best_trial
        out["best"] = {"trial_id": bt.number, "value": bt.value, "params": bt.params}
    except Exception:
        out["best"] = None
    print(json.dumps(out, ensure_ascii=False))

def cmd_status(args):
    import optuna
    sd = _study_dir(args.base_dir, args.study_id)
    study, spec = _load_study(sd, args.study_id)
    trials = study.get_trials(deepcopy=False)
    done = [t for t in trials if t.state == optuna.trial.TrialState.COMPLETE]
    pruned = [t for t in trials if t.state == optuna.trial.TrialState.PRUNED]
    failed = [t for t in trials if t.state == optuna.trial.TrialState.FAIL]
    running = [t for t in trials if t.state == optuna.trial.TrialState.RUNNING]

    history = [{"trial_id": t.number, "value": t.value, "params": t.params,
                "state": t.state.name} for t in trials]

    best = None
    try:
        bt = study.best_trial
        best = {"trial_id": bt.number, "value": bt.value, "params": bt.params}
    except Exception:
        pass

    # 收敛曲线：累计 best
    curve = []
    cur_best = None
    direction = spec.get("objective", {}).get("direction", "minimize")
    for t in done:
        v = t.value
        if cur_best is None: cur_best = v
        else:
            if direction == "minimize": cur_best = min(cur_best, v)
            else:                       cur_best = max(cur_best, v)
        curve.append({"trial_id": t.number, "value": v, "running_best": cur_best})

    # 参数重要性（>=10 done 时算）
    importance = None
    if len(done) >= 10:
        try:
            importance = optuna.importance.get_param_importances(study)
            importance = {k: float(v) for k, v in importance.items()}
        except Exception as e:
            importance = {"_error": str(e)}

    print(json.dumps({
        "ok": True,
        "study_id": args.study_id,
        "direction": direction,
        "sampler": spec.get("sampler"),
        "n_trials_total": len(trials),
        "n_done": len(done),
        "n_pruned": len(pruned),
        "n_failed": len(failed),
        "n_running": len(running),
        "budget": spec.get("n_trials_budget"),
        "best": best,
        "history": history,
        "convergence": curve,
        "importance": importance,
    }, ensure_ascii=False))

def cmd_render(args):
    import optuna
    sd = _study_dir(args.base_dir, args.study_id)
    storage = _storage_url(sd)
    study = optuna.load_study(study_name=args.study_id, storage=storage)
    kind = args.kind
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        from optuna.visualization.matplotlib import (
            plot_optimization_history, plot_param_importances,
            plot_parallel_coordinate, plot_slice,
        )
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        if kind == "history":
            ax = plot_optimization_history(study)
        elif kind == "importance":
            ax = plot_param_importances(study)
        elif kind == "parallel":
            ax = plot_parallel_coordinate(study)
        elif kind == "slice":
            ax = plot_slice(study)
        else:
            raise ValueError(f"unknown kind: {kind}")
        fig = ax.figure if hasattr(ax, "figure") else plt.gcf()
        fig.set_size_inches(10, 6)
        fig.tight_layout()
        fig.savefig(out_path, dpi=120)
        plt.close(fig)
        print(json.dumps({"ok": True, "kind": kind, "path": str(out_path)}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))

def cmd_list(args):
    base = Path(args.base_dir)
    if not base.exists():
        print(json.dumps({"ok": True, "studies": []}, ensure_ascii=False)); return
    studies = []
    for d in sorted(base.iterdir()):
        if not d.is_dir(): continue
        sj = d / "study.json"
        if not sj.exists(): continue
        try:
            spec = json.loads(sj.read_text(encoding="utf-8"))
            studies.append({
                "study_id": d.name,
                "sampler": spec.get("sampler"),
                "direction": spec.get("objective", {}).get("direction"),
                "n_params": len(spec.get("search_space", [])),
                "budget": spec.get("n_trials_budget"),
                "created_at": spec.get("created_at"),
            })
        except Exception:
            pass
    print(json.dumps({"ok": True, "studies": studies}, ensure_ascii=False))

# ----------------------------- entry -----------------------------

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("create")
    p.add_argument("--study_id", required=True)
    p.add_argument("--base_dir", required=True)
    p.add_argument("--spec", required=True, help="JSON spec string")
    p.set_defaults(func=cmd_create)

    p = sub.add_parser("suggest")
    p.add_argument("--study_id", required=True)
    p.add_argument("--base_dir", required=True)
    p.set_defaults(func=cmd_suggest)

    p = sub.add_parser("record")
    p.add_argument("--study_id", required=True)
    p.add_argument("--base_dir", required=True)
    p.add_argument("--trial_id", type=int, required=True)
    p.add_argument("--value", type=float, default=None)
    p.add_argument("--state", default="COMPLETE")
    p.add_argument("--evidence", help="CFD evidence result JSON, required for COMPLETE")
    p.set_defaults(func=cmd_record)

    p = sub.add_parser("status")
    p.add_argument("--study_id", required=True)
    p.add_argument("--base_dir", required=True)
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("render")
    p.add_argument("--study_id", required=True)
    p.add_argument("--base_dir", required=True)
    p.add_argument("--kind", required=True, choices=["history","importance","parallel","slice"])
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_render)

    p = sub.add_parser("list")
    p.add_argument("--base_dir", required=True)
    p.set_defaults(func=cmd_list)

    args = ap.parse_args()
    try:
        args.func(args)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "type": type(e).__name__}, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    main()
