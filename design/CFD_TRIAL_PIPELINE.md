# 独立 CFD 试验闭环

这是可用的外部 generator / mesher / solver / measurement runner，不是已校准的真实分布器生成器，不保证几何、网格或物理正确。仓库不提供真实生成器或验收测量实现，用户必须接入自己的可执行程序。测试只运行 Node 模拟夹具，不需要 OpenFOAM，禁止用这些示例直接启动大型真实 CFD。

已接入 server.js 的 `opt_run_trial` 工具，不自动写经验库。新 study 必须固定 pipeline 合同；旧 study 无合同哈希时拒绝继续，需新建 study，不会自动迁移旧成绩。

## Agent 工具接入

`opt_study_create` 必须提供 `base_case` 和 `pipeline: {stages, acceptance}`。合同写入 Optuna 元数据的 SHA-256，之后修改合同必须新建 study。`opt_suggest_next` 分配独占目录并受 trial 总预算限制。

拿到 trial 后调用 `opt_run_trial({study_id, trial_id})`。仅当返回 `passed: true`，才可调用 `opt_record_result({study_id, trial_id, value, evidence_path, state:'COMPLETE'})`；失败记录 FAIL。记录入口通过独立 Node CLI 再核对合同、Optuna 参数、候选目录及证据，直接运行 Python 驱动也不能省略验收。

服务端暂采用独占资源策略：已有未结束求解作业或优化流水线时，拒绝启动另一条流水线。这不是分布式作业调度器；不要在流水线运行期间绕过它从其它终端另起重算。当前无跨服务重启自动续算，意外重启后保留已有目录作为失败诊断证据，不覆盖重跑。

## 接口与确切配置

```js
import { runCfdTrial, verifyTrialEvidence } from './cfd_trial.js';
const result = await runCfdTrial(config);
if (result.passed) {
  const evidence = await verifyTrialEvidence({
    resultPath: '/work/study/trial-001/trial-result.json',
    studyId: 'distributor-study', trialId: 'trial-001', value: result.value,
  });
}
```

以下为配置 schema 的 TypeScript 记法；实现是无第三方依赖的 Node ESM。所有字段必需，只有 min/max 是二选一或同时提供；各对象拒绝未知字段。建议 Node 20 或更高版本。

```ts
type Stage = {
  command: [string, ...string[]];
  timeoutMs: number;
};
type MetricRule = {
  name: string;
  role: 'fit' | 'holdout';
  min?: number;
  max?: number;
};
type Config = {
  baseCase: string;
  trialDir: string;
  studyId: string;
  trialId: string;
  params: Record<string, JSONValue>;
  stages: { generate: Stage; mesh: Stage; solve: Stage; verify: Stage };
  acceptance: {
    endTime: number;
    metrics: MetricRule[];
    objective: string;
    measurement: {
      windowStart: number;
      windowEnd: number;
      description: string;
      windowMetric: string;
      timingMetric: string;
    };
  };
};
type JSONValue = null | boolean | number | string | JSONValue[]
  | { [key: string]: JSONValue };
```

- 路径相对调用进程当前目录解析并归一化为绝对路径；命令的 cwd 固定为候选目录。命令中脚本路径请使用绝对路径，参数没有占位符替换或 shell 展开。
- studyId/trialId 必须为非空字符串；params 必须为 JSON 对象，数值必须有限。写成 trial-params.json，生成器自行读取，runner 不会假装已经生成真实几何。
- timeoutMs 必须为 1 到 2147483647 的整数；四个阶段均不可省略。严格顺序 generate → mesh → solve → verify，失败立即停止后续阶段。
- command 是可执行文件和参数组成的非空字符串数组，spawn 使用 shell:false；不支持管道、重定向或 shell 内建命令。Windows 请指定实际可执行文件，不使用 .cmd/.bat 包装器。
- 每个命令继承当前环境，并设置 CFD_TRIAL_DIR、CFD_PARAMS_PATH、CFD_METRICS_PATH；LC_ALL=C。命令 stdin 关闭。
- endTime 必须有限且大于 0。指标名唯一，匹配 `[A-Za-z][A-Za-z0-9_.-]*`；每项至少有一个有限 min/max，边界包含等号。必须同时包含 fit、holdout 两类；objective 必须是 fit 类的受阈值约束指标，不能用 holdout 作为优化目标，直接返回其数值，不改变符号。
- `0 <= windowStart < windowEnd <= endTime`。description 必须非空，应说明统计窗口、稳态判定、采样间隔/样本数和独立测量方法。windowMetric、timingMetric 必须为两个不同且在 metrics 中受约束的指标，例如 windowCoverage >= 0.99、sampleCount >= 100。runner 检查这些数值，不会自行证明测量脚本正确计算了窗口。

示例验收配置（仅表示接口，不是物理上已经校准的阈值）：

```json
{
  "endTime": 10,
  "objective": "uniformityError",
  "metrics": [
    { "name": "uniformityError", "min": 0, "max": 0.1, "role": "fit" },
    { "name": "holdoutError", "min": 0, "max": 0.15, "role": "holdout" },
    { "name": "windowCoverage", "min": 0.99, "max": 1, "role": "holdout" },
    { "name": "sampleCount", "min": 100, "role": "fit" }
  ],
  "measurement": {
    "windowStart": 5,
    "windowEnd": 10,
    "description": "统计 [5,10] 内样本；独立留出截面；覆盖率和有效样本数均达标",
    "windowMetric": "windowCoverage",
    "timingMetric": "sampleCount"
  }
}
```

## 执行与验收约束

候选目录必须不存在，拒绝旧目录而不是覆盖或恢复。模板与候选目录禁止相等、互为祖先后代，路径组成部分禁止 symlink/junction。只复制模板 system、constant、0（均必需），不复制根目录旧日志、时间目录或 postProcessing。复制内容、阶段产物和证据清单递归拒绝符号链接、硬链接、多重链接文件及非普通文件。复制后删除旧 constant/polyMesh，强制 mesh 阶段重建网格。

mesh 进程必须退出 0，stdout 或 stderr 必须含独立一行 `Mesh OK` / `Mesh OK.` / `Mesh OK!`，不得含 Failed mesh checks、Failed N mesh checks 或 FATAL。必须存在非空常规文件 constant/polyMesh/{points,faces,owner,neighbour,boundary}。这不是网格语义解析器；真实命令应执行网格生成及 checkMesh。

solve 必须退出 0，stdout 必须含独立的 `End` 行和 `Time = 数值` 行；最后一个 Time 必须有限且不小于 endTime。两路日志均禁止 FATAL、sigFpe、MPI_ABORT。不支持将 stderr 当作最终时间来源。

verify 是独立启动的外部脚本，只允许新增根目录 metrics.json；stdout/stderr 由 runner 写入专用日志。不得创建其他输出，或修改/删除已有文件，包括网格、配置、原始结果和历史日志。metrics.json 在 verify 前不能存在。solve 不得改变 mesh 阶段网格，所有后续阶段不得修改配置、params 或既有阶段日志。

metrics.json 必须是平面 JSON 对象，所有值必须是有限数字，例如：

```json
{ "uniformityError": 0.05, "holdoutError": 0.08, "windowCoverage": 1, "sampleCount": 150 }
```

不接受脚本自报 `passed: true`、score 或嵌套对象；额外数值字段允许但不参与判定。真正的得分只能来自 acceptance.objective 指定指标；所有阈值包括留出指标、窗口和时序质量同时通过后才产生有效 value。

日志直接写文件，不在内存缓存完整输出；返回每路最多最后 16384 字节的 tail。日志判定使用流式读取，单行超过 64 KiB 保守拒绝。Linux 超时向独立进程组发送 SIGKILL；正常结束也清理该进程组残留。Windows 超时使用 taskkill /PID /T /F 并尝试 child.kill；清理为尽力而为。阶段超时不包含目录复制、哈希和验收扫描时间。

## 结果与证据

runCfdTrial 在配置/目录预检不通过时 reject，不创建/覆盖结果。候选目录创建后阶段失败通常返回并保存失败结果；若结果路径被占用、权限失效等导致无法安全保存，则 reject。

trial-result.json 的主要字段：version=1、passed、studyId、trialId、params、value、configHash、templateInputs、inputArtifacts、meshArtifacts、preVerifyArtifacts、artifacts、stages，成功含 checks，失败含 error。失败 value 固定为 null，绝不能作为有效 score 使用。

configHash 为归一化配置的排序键规范 JSON 的 SHA-256。各 manifest 均为 `{ "目录内相对路径": "文件内容 SHA-256" }`，包含输入哈希、网格、日志、测量、配置及其余常规文件；最终 artifacts 不包含 trial-result.json 自身，避免自哈希循环。不允许清单路径引导读取目录外文件，读取时重新遍历目录并整体比对清单。模板输入哈希代表复制时快照，后续不依赖模板仍存在。输入经过 generate/mesh/solve 合法修改时，初始和最终哈希可以不同。

stages 按固定顺序记录 name、command、timeoutMs、status（passed/failed）、exitCode、signal、timedOut、stdout、stderr、stdoutTail、stderrTail；按需附 error、validationError 或 cleanupError。checks 是规则加 measured、passed 的数组。

verifyTrialEvidence 基础参数为 `{resultPath:string, studyId:string, trialId:string, value:number}`，另支持 `{studySpec, params, trialDir}` 比对锁定 study 合同与 Optuna 分配；成绩登记必须走后者。验证失败 reject；成功返回 `{passed:true, studyId, trialId, value, configHash}`。它不只信 passed：重新验证配置身份、params、有限 objective、当前完整文件哈希、四阶段顺序/命令/timeout/退出状态、网格与求解日志门禁、验收前后清单，以及所有阈值与目标值。JSON 证据文件最大 4 MiB。

信任边界：这是本机可信程序的执行与一致性审计工具，不是 OS 沙箱或密码学签名系统。外部程序具有当前用户权限，不能靠 shell:false 阻止恶意代码写目录外、伪造日志、瞬时修改后恢复或后台逃逸。哈希只能检测与保存清单不一致的改动；若攻击者同时重写整套结果、清单及日志，没有外部可信 configHash/签名就不能证明真实性。对不可信程序应使用容器/低权限用户/只读挂载，并在外部可信存储固定配置和结果摘要。runner 不把命令参数中位于目录外的可执行文件自动当作目录内 artifact。

## CLI 与轻量验证

```sh
node cfd_trial.js config.json
node --test test/cfd_trial.test.mjs
python -m unittest discover -s test -p test_opt_driver.py -v
```

Python 优化驱动需要 Optuna 及其 SQLite 后端依赖（SQLAlchemy、Alembic）。本地回归已用 Python 3.12 验证；没有自动部署到远端或启动真实 CFD。

CLI 成功退出 0；失败退出 1。参数 JSON 使用上面的完整 schema，四个 command 需指向实际存在的外部程序，不提供假真实生成器。测试自行创建临时模板并用 Node 子进程模拟四阶段，覆盖成功、各阶段短路、网格假成功、求解不足/FATAL、超时、旧目录、留出/窗口/时序拒绝、越权写入、证据篡改和链接污染。