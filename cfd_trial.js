import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STAGES = ['generate', 'mesh', 'solve', 'verify'];
const TAIL_BYTES = 16384;
// 3D 多组分算例并行分解后有 2.6 万个文件，trial-result.json 里两份 sha256 清单就到 5.9 MB；4 MB 曾把通过的对照判成证据无效
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MESH_FILES = ['points', 'faces', 'owner', 'neighbour', 'boundary'];
const RESULT = 'trial-result.json';

function insist(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value, allowed, label) {
  insist(object(value), `${label}: expected object`);
  insist(Object.keys(value).every(key => allowed.includes(key)), `${label}: unknown field`);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  insist(value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value), 'Non-JSON configuration value');
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validateConfig(input) {
  keys(input, ['baseCase', 'trialDir', 'studyId', 'trialId', 'params', 'stages', 'acceptance'], 'config');
  const config = JSON.parse(canonical(input));
  for (const field of ['baseCase', 'trialDir', 'studyId', 'trialId']) {
    insist(typeof config[field] === 'string' && config[field].trim().length > 0, `Invalid ${field}`);
  }
  insist(object(config.params), 'params must be a JSON object');
  config.baseCase = path.resolve(config.baseCase);
  config.trialDir = path.resolve(config.trialDir);
  keys(config.stages, STAGES, 'stages');
  for (const name of STAGES) {
    const stage = config.stages[name];
    keys(stage, ['command', 'timeoutMs'], `stages.${name}`);
    insist(Array.isArray(stage.command) && stage.command.length > 0 && stage.command.every(arg => typeof arg === 'string' && !arg.includes('\0')) && stage.command[0].length > 0, `${name}: command must be a nonempty string array`);
    insist(Number.isSafeInteger(stage.timeoutMs) && stage.timeoutMs > 0 && stage.timeoutMs <= 2147483647, `${name}: finite positive timeoutMs required (maximum 2147483647)`);
  }
  const acceptance = config.acceptance;
  keys(acceptance, ['endTime', 'metrics', 'objective', 'measurement'], 'acceptance');
  insist(finite(acceptance.endTime) && acceptance.endTime > 0, 'acceptance.endTime must be finite and positive');
  insist(Array.isArray(acceptance.metrics) && acceptance.metrics.length > 0, 'acceptance.metrics required');
  const names = new Set();
  for (const metric of acceptance.metrics) {
    keys(metric, ['name', 'min', 'max', 'role'], 'metric');
    insist(typeof metric.name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(metric.name) && !names.has(metric.name), 'Invalid or duplicate metric name');
    names.add(metric.name);
    insist(metric.role === 'fit' || metric.role === 'holdout', 'Metric role must be fit or holdout');
    insist(Object.hasOwn(metric, 'min') || Object.hasOwn(metric, 'max'), 'Metric requires min or max');
    for (const bound of ['min', 'max']) insist(!Object.hasOwn(metric, bound) || finite(metric[bound]), `Metric ${bound} must be finite`);
    insist(!(Object.hasOwn(metric, 'min') && Object.hasOwn(metric, 'max')) || metric.min <= metric.max, 'Inverted metric bounds');
  }
  insist(['fit', 'holdout'].every(role => acceptance.metrics.some(metric => metric.role === role)), 'Both fit and holdout metrics required');
  insist(names.has(acceptance.objective), 'objective must name a constrained metric');
  insist(acceptance.metrics.find(metric => metric.name === acceptance.objective).role === 'fit', 'objective must use a fit metric, never holdout');
  const measurement = acceptance.measurement;
  keys(measurement, ['windowStart', 'windowEnd', 'description', 'windowMetric', 'timingMetric'], 'acceptance.measurement');
  insist(finite(measurement.windowStart) && finite(measurement.windowEnd) && measurement.windowStart >= 0 && measurement.windowEnd > measurement.windowStart && measurement.windowEnd <= acceptance.endTime, 'Invalid measurement window');
  insist(typeof measurement.description === 'string' && measurement.description.trim().length > 0, 'Measurement method and timing description required');
  insist(names.has(measurement.windowMetric) && names.has(measurement.timingMetric) && measurement.windowMetric !== measurement.timingMetric, 'Distinct constrained windowMetric and timingMetric required');
  return config;
}

async function noSymlinkComponents(target) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      insist(!(await fs.lstat(current)).isSymbolicLink(), `Symlink path forbidden: ${current}`);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function hashFile(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

async function inventory(root, excluded = new Set()) {
  await noSymlinkComponents(root);
  insist((await fs.lstat(root)).isDirectory(), 'Artifact root must be a directory');
  const files = Object.create(null);
  async function walk(directory, relativeDirectory) {
    for (const entry of (await fs.readdir(directory)).sort()) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
      const filename = path.join(directory, entry);
      const stat = await fs.lstat(filename);
      insist(!stat.isSymbolicLink(), `Symlink artifact forbidden: ${relative}`);
      if (stat.isDirectory()) {
        insist(!excluded.has(relative), `Reserved artifact must be a file: ${relative}`);
        await walk(filename, relative);
      } else {
        insist(stat.isFile() && stat.nlink === 1, `Nonregular or hardlinked artifact forbidden: ${relative}`);
        if (!excluded.has(relative)) files[relative] = await hashFile(filename);
      }
    }
  }
  await walk(root, '');
  return files;
}

function withoutTemplateMesh(files) {
  return Object.fromEntries(Object.entries(files).filter(([filename]) => !filename.startsWith('constant/polyMesh/')));
}

function equal(actual, expected, label) {
  insist(canonical(actual) === canonical(expected), `${label}: evidence changed`);
}

function subsetUnchanged(before, after, label) {
  for (const [filename, digest] of Object.entries(before)) insist(after[filename] === digest, `${label}: changed ${filename}`);
}

async function readJson(filename) {
  const stat = await fs.lstat(filename);
  insist(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= MAX_JSON_BYTES, `Invalid JSON artifact: ${filename}`);
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function writeJson(filename, value) {
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

async function tail(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function killTree(child) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return;
  }
  await new Promise(resolve => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { killer.kill(); resolve(); }, 5000);
    const finish = () => { clearTimeout(timer); resolve(); };
    killer.once('error', finish);
    killer.once('exit', finish);
  });
  try { child.kill('SIGKILL'); } catch { /* Windows 清理只能尽力而为。 */ }
}

async function executeStage(root, name, spec) {
  const stdout = `logs/${name}.stdout.log`;
  const stderr = `logs/${name}.stderr.log`;
  const output = await fs.open(path.join(root, stdout), 'wx');
  let errors;
  const record = { name, command: spec.command, timeoutMs: spec.timeoutMs, status: 'failed', exitCode: null, signal: null, timedOut: false, stdout, stderr };
  try {
    errors = await fs.open(path.join(root, stderr), 'wx');
    const child = spawn(spec.command[0], spec.command.slice(1), {
      cwd: root,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', CFD_TRIAL_DIR: root, CFD_PARAMS_PATH: path.join(root, 'trial-params.json'), CFD_METRICS_PATH: path.join(root, 'metrics.json') },
      stdio: ['ignore', output.fd, errors.fd],
    });
    let cleanup = Promise.resolve();
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        record.timedOut = true;
        cleanup = killTree(child).catch(error => { record.cleanupError = error.message; });
      }, spec.timeoutMs);
      child.once('error', error => { record.error = error.message; clearTimeout(timer); resolve(); });
      child.once('exit', (code, signal) => { record.exitCode = code; record.signal = signal; clearTimeout(timer); resolve(); });
    });
    await cleanup;
    if (process.platform !== 'win32') await killTree(child);
    if (!record.timedOut && !record.error && record.exitCode === 0 && record.signal === null) record.status = 'passed';
  } finally {
    await output.close();
    await errors?.close();
  }
  record.stdoutTail = await tail(path.join(root, stdout));
  record.stderrTail = await tail(path.join(root, stderr));
  return record;
}

async function inspectLog(filename) {
  let pending = '';
  const summary = { meshOK: false, meshFailed: false, fatal: false, ended: false, finalTime: null };
  function line(text) {
    if (/^\s*Mesh OK[.!]?\s*$/.test(text)) summary.meshOK = true;
    if (/Failed(?:\s+\d+)?\s+mesh\s+checks/i.test(text)) summary.meshFailed = true;
    // 区分大小写：崩溃栈是 Foam::sigFpe::sigHandler；启动横幅 "trapFpe: ... (FOAM_SIGFPE)" 不是错误
    if (/\bFATAL\b|sigFpe|MPI_ABORT/.test(text)) summary.fatal = true;
    if (/^\s*End\s*$/.test(text)) summary.ended = true;
    const match = /^\s*Time\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*$/.exec(text);
    if (match) summary.finalTime = Number(match[1]);
  }
  for await (const chunk of createReadStream(filename, { encoding: 'utf8' })) {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      insist(newline <= 65536, 'Log line exceeds 64 KiB');
      line(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    insist(pending.length <= 65536, 'Log line exceeds 64 KiB');
  }
  if (pending) line(pending);
  return summary;
}

async function validateStage(root, record, config) {
  insist(record.status === 'passed' && record.exitCode === 0 && record.signal === null && record.timedOut === false && !record.error, `${record.name}: command failed or timed out`);
  const summaries = await Promise.all([record.stdout, record.stderr].map(filename => inspectLog(path.join(root, filename))));
  if (record.name === 'mesh') {
    insist(summaries.some(summary => summary.meshOK) && !summaries.some(summary => summary.meshFailed || summary.fatal), 'mesh: Mesh OK required; failed mesh checks / FATAL forbidden');
    for (const filename of MESH_FILES) {
      const stat = await fs.lstat(path.join(root, 'constant', 'polyMesh', filename));
      insist(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, `mesh: missing/nonregular/empty ${filename}`);
    }
  }
  if (record.name === 'solve') {
    insist(!summaries.some(summary => summary.fatal), 'solve: FATAL / sigFpe / MPI_ABORT');
    insist(summaries[0].ended && finite(summaries[0].finalTime) && summaries[0].finalTime >= config.acceptance.endTime, 'solve: End and sufficient final Time required in stdout');
  }
}

function evaluateMetrics(metrics, acceptance) {
  insist(object(metrics) && Object.values(metrics).every(finite), 'metrics.json must contain only finite numeric measurements');
  const checks = acceptance.metrics.map(rule => {
    const measured = metrics[rule.name];
    const passed = Object.hasOwn(metrics, rule.name) && finite(measured) && (!Object.hasOwn(rule, 'min') || measured >= rule.min) && (!Object.hasOwn(rule, 'max') || measured <= rule.max);
    return { ...rule, measured: measured ?? null, passed };
  });
  insist(checks.every(check => check.passed), `Acceptance failed: ${checks.filter(check => !check.passed).map(check => check.name).join(', ')}`);
  return { value: metrics[acceptance.objective], checks };
}

function meshManifest(manifest) {
  return Object.fromEntries(Object.entries(manifest).filter(([filename]) => filename.startsWith('constant/polyMesh/')));
}

export async function runCfdTrial(input) {
  const config = validateConfig(input);
  const { baseCase, trialDir } = config;
  await noSymlinkComponents(baseCase);
  await noSymlinkComponents(trialDir);
  insist(!inside(baseCase, trialDir) && !inside(trialDir, baseCase), 'Template and trial must not overlap (ancestor/descendant forbidden)');
  insist((await fs.lstat(baseCase)).isDirectory(), 'baseCase must be a directory');
  const templateInputs = {};
  for (const directory of ['system', 'constant', '0']) {
    const files = await inventory(path.join(baseCase, directory));
    for (const [filename, digest] of Object.entries(files)) templateInputs[`${directory}/${filename}`] = digest;
  }
  await fs.mkdir(path.dirname(trialDir), { recursive: true });
  await noSymlinkComponents(trialDir);
  await fs.mkdir(trialDir);
  const result = {
    version: 1, passed: false, studyId: config.studyId, trialId: config.trialId,
    params: config.params, value: null, configHash: hash(canonical(config)),
    templateInputs, inputArtifacts: {}, meshArtifacts: {}, preVerifyArtifacts: {}, artifacts: {}, stages: [],
  };
  try {
    for (const directory of ['system', 'constant', '0']) {
      await fs.cp(path.join(baseCase, directory), path.join(trialDir, directory), { recursive: true, errorOnExist: true, force: false });
    }
    subsetUnchanged(templateInputs, await inventory(trialDir), 'Copied template');
    await fs.rm(path.join(trialDir, 'constant', 'polyMesh'), { recursive: true, force: true });
    await writeJson(path.join(trialDir, 'trial-config.json'), config);
    await writeJson(path.join(trialDir, 'trial-params.json'), config.params);
    result.inputArtifacts = await inventory(trialDir);
    await fs.mkdir(path.join(trialDir, 'logs'));
    const locked = Object.fromEntries(['trial-config.json', 'trial-params.json'].map(filename => [filename, result.inputArtifacts[filename]]));
    for (const name of STAGES) {
      const before = await inventory(trialDir);
      subsetUnchanged(locked, before, 'Locked inputs');
      if (name === 'verify') {
        insist(!Object.hasOwn(before, 'metrics.json'), 'metrics.json must be created only by verify');
        result.preVerifyArtifacts = before;
      }
      const record = await executeStage(trialDir, name, config.stages[name]);
      result.stages.push(record);
      try {
        const after = await inventory(trialDir);
        subsetUnchanged(locked, after, 'Locked inputs');
        const priorLogs = Object.fromEntries(Object.entries(before).filter(([filename]) => filename.startsWith('logs/')));
        subsetUnchanged(priorLogs, after, 'Prior stage logs');
        if (name === 'verify') {
          const permitted = new Set(['metrics.json', record.stdout, record.stderr]);
          equal(Object.fromEntries(Object.entries(after).filter(([filename]) => !permitted.has(filename))), before, 'Verify may only write metrics.json');
        }
        if (name === 'solve' || name === 'verify') equal(meshManifest(after), result.meshArtifacts, 'Mesh');
        await validateStage(trialDir, record, config);
        if (name === 'mesh') result.meshArtifacts = meshManifest(after);
      } catch (error) {
        record.status = 'failed';
        record.validationError = error.message;
        throw error;
      }
    }
    const evaluation = evaluateMetrics(await readJson(path.join(trialDir, 'metrics.json')), config.acceptance);
    result.checks = evaluation.checks;
    result.value = evaluation.value;
    result.passed = true;
  } catch (error) {
    result.error = error.message;
    result.passed = false;
    result.value = null;
  }
  try {
    result.artifacts = await inventory(trialDir, new Set([RESULT]));
  } catch (error) {
    result.passed = false;
    result.value = null;
    result.error = error.message;
  }
  await noSymlinkComponents(trialDir);
  await writeJson(path.join(trialDir, RESULT), result);
  return result;
}

export async function verifyTrialEvidence({ resultPath, studyId, trialId, value, studySpec, params, trialDir }) {
  insist(typeof resultPath === 'string' && finite(value), 'resultPath and finite expected value required');
  const absolute = path.resolve(resultPath);
  insist(path.basename(absolute) === RESULT, `Expected ${RESULT}`);
  await noSymlinkComponents(absolute);
  const root = path.dirname(absolute);
  const result = await readJson(absolute);
  insist(result.version === 1 && result.passed === true, 'Trial is not a successful version-1 result');
  insist(typeof studyId === 'string' && typeof trialId === 'string' && result.studyId === studyId && result.trialId === trialId, 'Trial identity mismatch');
  insist(finite(result.value) && result.value === value, 'Trial value mismatch');
  const config = validateConfig(await readJson(path.join(root, 'trial-config.json')));
  if (studySpec) {
    const spec = await readJson(path.resolve(studySpec));
    insist(spec.study_id === studyId && object(spec.pipeline), 'Study contract required');
    insist(config.baseCase === path.resolve(spec.base_case), 'Baseline contract mismatch');
    equal(config.stages, spec.pipeline.stages, 'Stage contract');
    equal(config.acceptance, spec.pipeline.acceptance, 'Acceptance contract');
    equal(config.params, params, 'Suggested parameters');
    insist(root === path.resolve(trialDir), 'Allocated trial directory mismatch');
  }
  insist(config.trialDir === root && config.studyId === studyId && config.trialId === trialId, 'Config identity/path mismatch');
  equal(config.params, result.params, 'Params');
  equal(await readJson(path.join(root, 'trial-params.json')), config.params, 'Params file');
  insist(hash(canonical(config)) === result.configHash, 'Config hash mismatch');
  const artifacts = await inventory(root, new Set([RESULT]));
  equal(artifacts, result.artifacts, 'Artifacts');
  insist(object(result.inputArtifacts) && object(result.templateInputs) && object(result.preVerifyArtifacts) && object(result.meshArtifacts), 'Missing evidence manifests');
  for (const directory of ['system', 'constant', '0']) insist(Object.keys(result.inputArtifacts).some(filename => filename.startsWith(`${directory}/`)), `Missing ${directory} input evidence`);
  // 模板自带的 constant/polyMesh 在生成前按设计被删掉（网格由 mesh 阶段重建，单独有 meshArtifacts 证据），不在输入证据里比
  subsetUnchanged(withoutTemplateMesh(result.templateInputs), result.inputArtifacts, 'Template input evidence');
  for (const filename of ['trial-config.json', 'trial-params.json']) {
    insist(result.inputArtifacts[filename] === artifacts[filename], `Changed input ${filename}`);
  }
  equal(meshManifest(artifacts), result.meshArtifacts, 'Mesh evidence');
  insist(Array.isArray(result.stages) && result.stages.length === STAGES.length, 'All four stages required');
  for (const [index, name] of STAGES.entries()) {
    const record = result.stages[index];
    insist(record.name === name && record.stdout === `logs/${name}.stdout.log` && record.stderr === `logs/${name}.stderr.log`, 'Stage order/log path mismatch');
    equal(record.command, config.stages[name].command, 'Stage command');
    insist(record.timeoutMs === config.stages[name].timeoutMs, 'Stage timeout mismatch');
    await validateStage(root, record, config);
  }
  const verificationOutputs = new Set(['metrics.json', 'logs/verify.stdout.log', 'logs/verify.stderr.log']);
  insist(!Object.keys(result.preVerifyArtifacts).some(filename => verificationOutputs.has(filename)), 'Verification outputs existed before verification');
  equal(Object.fromEntries(Object.entries(artifacts).filter(([filename]) => !verificationOutputs.has(filename))), result.preVerifyArtifacts, 'Pre-verification evidence');
  const evaluation = evaluateMetrics(await readJson(path.join(root, 'metrics.json')), config.acceptance);
  insist(evaluation.value === value, 'Recomputed objective mismatch');
  equal(evaluation.checks, result.checks, 'Acceptance checks');
  return { passed: true, studyId, trialId, value: evaluation.value, configHash: result.configHash };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--verify') {
      const options = Object.fromEntries(Array.from({ length: (process.argv.length - 4) / 2 }, (_, index) => [process.argv[4 + index * 2], process.argv[5 + index * 2]]));
      const result = await verifyTrialEvidence({ resultPath: process.argv[3], studyId: options['--study-id'], trialId: options['--trial-id'], value: Number(options['--value']), studySpec: options['--study-spec'], params: JSON.parse(options['--params'] || '{}'), trialDir: options['--trial-dir'] });
      console.log(JSON.stringify(result));
    } else {
    insist(process.argv.length === 3, 'Usage: node cfd_trial.js config.json');
    const result = await runCfdTrial(await readJson(path.resolve(process.argv[2])));
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}