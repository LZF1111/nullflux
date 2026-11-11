# 参与开发

## 从源码运行

```bash
git clone https://github.com/LZF1111/nullflux.git nullflux
cd nullflux
npm install
node server.js --port 5174
```

前端是 `public/` 下的原生 JS 和 CSS，没有构建步骤：改完刷新浏览器即可。改了后端要重启 `node server.js`；后台求解作业由独立进程运行，重启服务不会杀掉它们，重启后会自动重新接管。

模型接口在网页「设置」里配置，保存在 `settings.json`（不入库）。开发时可以用 `test/_mock_llm.py` 起一个假的 OpenAI 兼容接口。

## 代码地图

| 位置 | 内容 |
|---|---|
| `server.js` 开头 | 设置、`DEFAULT_SETTINGS`、端口参数 |
| `server.js` 里的 `const TOOLS = [` | 所有工具的 JSON Schema 定义（给模型看的名字、说明和参数） |
| `const TOOL_GROUPS` / `ALWAYS_TOOLS` / `PLAN_BLOCKED` / `toolsForMode` | 工具分组、开关与 plan 模式下禁用的工具 |
| `async function execTool(name, args, session, ws)` | 工具执行的大 `switch`：每个 `case '<工具名>'` 是一个工具的实现 |
| `async function callLLM` | 调模型（流式），处理 tool_calls |
| `function buildSystemPrompt` | 拼系统提示（基础规则、领域模式、复现闸门、经验） |
| `async function runAgent` | 智能体主循环：调模型 → 执行工具 → 回填结果，含步数预算、用户中途插话、自动续跑 |
| `function spawnTrackedRun` / `foamRunSolverAsync` | 后台求解作业的启动、登记、日志跟踪 |
| `app.get('/api/monitor'` 等 `app.*` 路由 | HTTP 接口；WebSocket 消息在 `wss.on('connection'` 里 |
| `public/app.js` | 主界面：对话、工具卡片、任务列表、作业面板 |
| `public/features.js` / `settings.js` / `post.js` / `viewer.js` | 命令面板与快捷键、设置页、后处理页、3D 预览 |
| 根目录其它 `*.js` | 可单测的独立模块，见 README 的目录结构 |

## 加一个工具

1. 在 `TOOLS` 数组里加定义：

```js
{ type: 'function', function: { name: 'my_tool', description: '一句话说清做什么、什么时候用', parameters: { type: 'object', properties: { case_path: { type: 'string' } }, required: ['case_path'] } } },
```

2. 在 `execTool` 的 `switch` 里加实现，返回给模型看的字符串：

```js
case 'my_tool': {
  const cd = safePath(args.case_path);
  return `结果：...`;
}
```

3. 只读工具在 plan 模式下自动可用；会写文件、跑命令的工具加进 `PLAN_BLOCKED`。
4. 逻辑复杂的话放进独立模块（例如 `my_tool.js`），在 `server.js` 里 import，并在 `test/` 里加单测。

求解器建模知识优先写进 `agent-skills/<求解器>/SKILL.md`，而不是塞进系统提示。

## 测试

```bash
npm test
```

运行 `test/*.test.mjs`（Node 自带的 `node:test`，无需额外依赖）。`test/e2e_*.mjs` 是端到端测试，需要可用的模型接口或 `_mock_llm.py`，按需单独运行：`node --test test/e2e_question.mjs`。

## 提交

- 一个 PR 做一件事，附上测试或手动验证步骤。
- 代码和注释风格跟周围保持一致（中文注释、2 空格缩进）。
- 不要提交 `settings.json`、`.env`、`tasks/`、日志、论文 PDF 或算例结果。
- 涉及仿真行为的改动，请说明在哪个算例上验证过。

合作联系：lizifeng@ipe.ac.cn
