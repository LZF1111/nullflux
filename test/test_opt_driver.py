import contextlib
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import shutil
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import opt_driver as driver
import optuna


class OptDriverTests(unittest.TestCase):
    def setUp(self):
        optuna.logging.set_verbosity(optuna.logging.ERROR)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.storages = []
        original_init = optuna.storages.RDBStorage.__init__

        def tracked_init(storage, *args, **kwargs):
            original_init(storage, *args, **kwargs)
            self.storages.append(storage)

        patcher = mock.patch.object(optuna.storages.RDBStorage, "__init__", tracked_init)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.close_storages)
        self.base = Path(self.temporary.name)
        self.spec = {
            "base_case": str(self.base / "base_case"),
            "pipeline": {"stages": {"generate": {"command": ["test"]}},
                         "acceptance": {"endTime": 1}},
            "search_space": [{"name": "speed", "type": "float", "low": 1.0, "high": 2.0}],
            "objective": {"direction": "minimize"}, "sampler": "RANDOM", "seed": 7,
            "pruner": "MEDIAN", "n_trials_budget": 2,
        }

    def close_storages(self):
        for storage in self.storages:
            storage.remove_session()
            storage.engine.dispose()

    def args(self, **kwargs):
        return SimpleNamespace(base_dir=str(self.base), study_id="safe-study", spec=json.dumps(self.spec),
                               **kwargs)

    def call(self, function, args=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            function(args or self.args())
        return json.loads(output.getvalue())

    def create(self):
        return self.call(driver.cmd_create)

    def study(self):
        return optuna.load_study(study_name="safe-study", storage=driver._storage_url(self.base / "safe-study"))

    def record_args(self, **overrides):
        values = dict(trial_id=0, value=1.5, state="COMPLETE", evidence=None)
        values.update(overrides)
        return self.args(**values)

    def evidence(self):
        evidence = self.base / "evidence.json"
        evidence.write_text("{}", encoding="utf-8")
        return str(evidence)

    def verified(self, **overrides):
        response = dict(passed=True, studyId="safe-study", trialId="0", value=1.5, configHash="a" * 64)
        response.update(overrides)
        return subprocess.CompletedProcess([], 0, json.dumps(response), "")

    def test_create_idempotent_and_hash(self):
        self.create()
        path = self.base / "safe-study" / "study.json"
        original = path.read_bytes()
        self.spec["created_at"] = 0
        self.create()
        self.assertEqual(original, path.read_bytes())
        self.assertEqual(self.study().user_attrs["contract_hash"], driver._contract_hash(json.loads(original)))
        self.spec["seed"] = 99
        with self.assertRaisesRegex(ValueError, "different configuration"):
            self.create()
        self.assertEqual(original, path.read_bytes())

    def test_real_pipeline_evidence_registration(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node is required for cross-language integration")
        template = Path(self.spec["base_case"])
        for directory in ("system", "constant", "0"):
            (template / directory).mkdir(parents=True)
            (template / directory / "input").write_text("baseline", encoding="utf-8")
        commands = {
            "generate": "require('node:fs').writeFileSync('geometry','generated')",
            "mesh": "const fs=require('node:fs');fs.mkdirSync('constant/polyMesh',{recursive:true});for(const name of ['points','faces','owner','neighbour','boundary'])fs.writeFileSync('constant/polyMesh/'+name,'mesh');console.log('Mesh OK.')",
            "solve": "console.log('Time = 10\\nEnd')",
            "verify": "require('node:fs').writeFileSync('metrics.json',JSON.stringify({loss:0.2,holdout:0.3,coverage:1,samples:100}))",
        }
        self.spec["pipeline"] = {
            "stages": {name: {"command": [node, "-e", code], "timeoutMs": 10000} for name, code in commands.items()},
            "acceptance": {"endTime": 10, "objective": "loss", "metrics": [
                {"name": "loss", "max": 1, "role": "fit"},
                {"name": "holdout", "max": 1, "role": "holdout"},
                {"name": "coverage", "min": 0.99, "role": "holdout"},
                {"name": "samples", "min": 10, "role": "fit"}],
                "measurement": {"windowStart": 5, "windowEnd": 10, "description": "fixture", "windowMetric": "coverage", "timingMetric": "samples"}},
        }
        self.create()
        suggestion = self.call(driver.cmd_suggest)
        config = dict(baseCase=str(template), trialDir=suggestion["trial_dir_suggested"], studyId="safe-study", trialId="0", params=suggestion["params"], **self.spec["pipeline"])
        config_file = self.base / "config.json"
        config_file.write_text(json.dumps(config), encoding="utf-8")
        subprocess.run([node, str(Path(driver.__file__).with_name("cfd_trial.js")), str(config_file)], check=True, capture_output=True, timeout=30)
        evidence = str(Path(config["trialDir"]) / "trial-result.json")
        output = self.call(driver.cmd_record, self.record_args(value=0.2, evidence=evidence))
        self.assertEqual(output["state"], "COMPLETE")
        self.assertEqual(output["n_done"], 1)
        self.assertEqual(self.study().best_value, 0.2)

    def test_invalid_specs(self):
        variants = [dict(base_case=""), dict(pipeline={}), dict(study_id="wrong"),
                    dict(require_cfd_evidence=False), dict(objective={"direction": "sideways"}),
                    dict(n_trials_budget=0), dict(search_space=[]),
                    dict(search_space=self.spec["search_space"] * 2),
                    dict(search_space=[dict(name="bad", type="float", low=0, high=float("inf"))]),
                    dict(search_space=[dict(name="bad", type="int", low=0.1, high=2)]),
                    dict(search_space=[dict(name="bad", type="float", low=0, high=2, log=True)]),
                    dict(search_space=[dict(name="bad", type="float", low=1, high=2, step=0)]),
                    dict(search_space=[dict(name="bad", type="cat", choices=[float("nan")])])]
        for changes in variants:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                driver._validate_spec(dict(self.spec, **changes), "safe-study")
        for identity in ("../escape", "a/b", "a\\b", "", "a b", "a\n"):
            with self.subTest(identity=identity), self.assertRaises(ValueError):
                driver._study_dir(self.base, identity)

    def test_spec_tampering_blocks_suggest_and_record(self):
        self.create()
        self.call(driver.cmd_suggest)
        path = self.base / "safe-study" / "study.json"
        spec = json.loads(path.read_text(encoding="utf-8"))
        spec["pipeline"]["acceptance"]["endTime"] = 9
        path.write_text(json.dumps(spec), encoding="utf-8")
        for function, args in [(driver.cmd_suggest, self.args()),
                               (driver.cmd_record, self.record_args(state="FAIL", value=None))]:
            with self.assertRaisesRegex(RuntimeError, "contract changed"):
                self.call(function, args)
        self.assertEqual(self.study().trials[0].state, optuna.trial.TrialState.RUNNING)

    def test_budget_and_directory_ownership(self):
        self.create()
        suggestion = self.call(driver.cmd_suggest)
        expected = self.base / "safe-study" / "trials" / "trial_0000"
        self.assertEqual(suggestion["trial_dir_suggested"], str(expected))
        self.assertFalse(expected.parent.exists())
        self.call(driver.cmd_suggest)
        with self.assertRaisesRegex(RuntimeError, "budget"):
            self.call(driver.cmd_suggest)
        self.assertEqual(len(self.study().trials), 2)

    def test_removed_spec_field_is_tampering(self):
        self.create()
        path = self.base / "safe-study" / "study.json"
        spec = json.loads(path.read_text(encoding="utf-8"))
        del spec["study_id"]
        path.write_text(json.dumps(spec), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "contract changed"):
            self.call(driver.cmd_suggest)

    def test_grid_last_trial_can_fail_and_exhaust(self):
        self.spec["sampler"] = "GRID"
        self.spec["search_space"][0]["grid"] = [1.5]
        self.create()
        self.assertEqual(self.call(driver.cmd_suggest)["params"], {"speed": 1.5})
        output = self.call(driver.cmd_record, self.record_args(state="FAIL", value=None))
        self.assertIsNone(output["value"])
        self.assertEqual(self.study().trials[0].state, optuna.trial.TrialState.FAIL)
        with self.assertRaisesRegex(RuntimeError, "GRID search exhausted"):
            self.call(driver.cmd_suggest)

    def test_grid_failed_suggestion_does_not_leave_running(self):
        self.spec["sampler"] = "GRID"
        self.spec["search_space"][0]["grid"] = [1.5]
        self.create()
        with mock.patch.object(driver, "_suggest_one", side_effect=ValueError("probe")):
            with self.assertRaisesRegex(ValueError, "probe"):
                self.call(driver.cmd_suggest)
        self.assertEqual(self.study().trials[0].state, optuna.trial.TrialState.FAIL)

    def test_linked_path_rejection_without_os_symlink_privilege(self):
        self.create()
        path = self.base / "safe-study" / "study.json"
        original = Path.is_symlink

        def linked(candidate):
            return candidate == path or original(candidate)

        with mock.patch.object(Path, "is_symlink", linked):
            with self.assertRaisesRegex(ValueError, "linked path"):
                self.call(driver.cmd_suggest)

    def test_failed_suggestion_is_not_running(self):
        self.create()
        with mock.patch.object(driver, "_suggest_one", side_effect=ValueError("probe")):
            with self.assertRaisesRegex(ValueError, "probe"):
                self.call(driver.cmd_suggest)
        self.assertEqual(self.study().trials[0].state, optuna.trial.TrialState.FAIL)

    def test_complete_requires_finite_value_and_evidence(self):
        self.create()
        self.call(driver.cmd_suggest)
        for overrides in ({}, {"value": None}, {"value": float("nan")}, {"value": float("inf")}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                self.call(driver.cmd_record, self.record_args(**overrides))
        self.assertEqual(self.study().trials[0].state, optuna.trial.TrialState.RUNNING)

    def test_fail_and_pruned_store_null_and_cannot_repeat(self):
        self.create()
        for number, state in enumerate(("FAIL", "PRUNED")):
            self.call(driver.cmd_suggest)
            output = self.call(driver.cmd_record, self.record_args(trial_id=number, state=state, value=None))
            self.assertIsNone(output["value"])
            self.assertIsNone(self.study().trials[number].value)
            with self.assertRaisesRegex(ValueError, "RUNNING"):
                self.call(driver.cmd_record, self.record_args(trial_id=number, state=state, value=None))
        logs = [json.loads(line) for line in (self.base / "safe-study" / "trials.jsonl").read_text().splitlines()]
        self.assertTrue(all(entry["value"] is None for entry in logs if entry["event"] == "tell"))

    def test_complete_verifier_arguments_attrs_and_integer_tell(self):
        self.create()
        suggestion = self.call(driver.cmd_suggest)
        evidence = self.evidence()
        with mock.patch.object(driver.subprocess, "run", return_value=self.verified()) as runner:
            output = self.call(driver.cmd_record, self.record_args(evidence=evidence))
        command = runner.call_args.args[0]
        options = dict(zip(command[2::2], command[3::2]))
        self.assertEqual(command[0], "node")
        self.assertEqual(options["--verify"], evidence)
        self.assertEqual(options["--study-id"], "safe-study")
        self.assertEqual(options["--trial-id"], "0")
        self.assertEqual(options["--value"], "1.5")
        self.assertEqual(options["--study-spec"], str(self.base / "safe-study" / "study.json"))
        self.assertEqual(options["--trial-dir"], suggestion["trial_dir_suggested"])
        self.assertEqual(json.loads(options["--params"]), suggestion["params"])
        self.assertEqual(runner.call_args.kwargs, dict(check=True, timeout=120, capture_output=True, text=True))
        self.assertEqual(output["verification"]["configHash"], "a" * 64)
        trial = self.study().trials[0]
        self.assertEqual(trial.state, optuna.trial.TrialState.COMPLETE)
        self.assertEqual(trial.user_attrs, dict(evidence=evidence, configHash="a" * 64))

    def test_verifier_failure_never_tells_even_for_fail(self):
        self.create()
        self.call(driver.cmd_suggest)
        evidence = self.evidence()
        for state in ("COMPLETE", "FAIL", "PRUNED"):
            for error in (subprocess.CalledProcessError(1, "node"), subprocess.TimeoutExpired("node", 120)):
                with self.subTest(state=state, error=error), mock.patch.object(driver.subprocess, "run", side_effect=error):
                    with self.assertRaises(type(error)):
                        self.call(driver.cmd_record, self.record_args(state=state, evidence=evidence))
                self.assertEqual(self.study().trials[0].state, optuna.trial.TrialState.RUNNING)

    def test_passed_alone_or_mismatched_response_rejected(self):
        self.create()
        self.call(driver.cmd_suggest)
        for response in ({"passed": True}, {"studyId": "other"}, {"trialId": "1"},
                         {"value": 4}, {"configHash": "invalid"}, {"passed": False}):
            completed = (subprocess.CompletedProcess([], 0, json.dumps(response), "")
                         if response == {"passed": True} else self.verified(**response))
            with self.subTest(response=response), mock.patch.object(driver.subprocess, "run", return_value=completed):
                with self.assertRaises(ValueError):
                    self.call(driver.cmd_record, self.record_args(evidence=self.evidence()))
            self.assertEqual(self.study().trials[0].state, optuna.trial.TrialState.RUNNING)

    def test_sampler_and_pruner_restored(self):
        for name in ("RANDOM", "TPE", "GRID"):
            with self.subTest(sampler=name):
                spec = copy.deepcopy(self.spec)
                spec["sampler"] = name
                spec["search_space"][0]["grid"] = [1.0, 2.0]
                args = self.args()
                args.study_id = name
                args.spec = json.dumps(spec)
                self.call(driver.cmd_create, args)
                study, loaded = driver._load_study(self.base / name, name)
                self.assertEqual(type(study.sampler), type(driver._sampler(loaded)))
                self.assertIsInstance(study.pruner, optuna.pruners.MedianPruner)
                if name == "GRID":
                    self.assertEqual(study.sampler._search_space, {"speed": [1.0, 2.0]})
                else:
                    expected = driver._sampler(loaded)
                    if name == "TPE":
                        study.sampler, expected = study.sampler._random_sampler, expected._random_sampler
                    self.assertEqual(study.sampler._rng.rng.randint(100000), expected._rng.rng.randint(100000))

    def test_legacy_rejected(self):
        sd = self.base / "safe-study"
        sd.mkdir()
        (sd / "study.json").write_text(json.dumps(self.spec), encoding="utf-8")
        optuna.create_study(study_name="safe-study", storage=driver._storage_url(sd))
        for function, args in [(driver.cmd_suggest, self.args()), (driver.cmd_create, self.args()),
                               (driver.cmd_record, self.record_args(state="FAIL", value=None))]:
            with self.assertRaisesRegex(RuntimeError, "migrate to a new study"):
                self.call(function, args)

    def test_linked_spec_rejected(self):
        self.create()
        sd = self.base / "safe-study"
        outside = self.base / "outside.json"
        outside.write_text("{}", encoding="utf-8")
        try:
            (sd / "linked").symlink_to(outside)
        except OSError:
            self.skipTest("symlink creation unavailable on this Windows account")
        (sd / "study.json").unlink()
        (sd / "linked").rename(sd / "study.json")
        with self.assertRaisesRegex(ValueError, "linked path"):
            self.call(driver.cmd_suggest)

    def test_direct_cli_cannot_bypass(self):
        self.create()
        self.call(driver.cmd_suggest)
        completed = subprocess.run([sys.executable, str(Path(driver.__file__)), "record",
                                    "--study_id", "safe-study", "--base_dir", str(self.base),
                                    "--trial_id", "0", "--value", "1.5"],
                                   check=False, capture_output=True, text=True, timeout=120)
        self.assertEqual(completed.returncode, 1)
        self.assertIn("--evidence", json.loads(completed.stdout)["error"])
        self.assertEqual(self.study().trials[0].state, optuna.trial.TrialState.RUNNING)


if __name__ == "__main__":
    unittest.main()