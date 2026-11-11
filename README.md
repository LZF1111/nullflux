# CFDriver

面向多相流 CFD 的智能体工作台：用大模型驱动 OpenFOAM / MFIX / LBM / DEM 的建模、求解、监控与后处理，重点是**可信的论文复现**和**无人值守的长时间计算**。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) ![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

项目主页：<https://lzf1111.github.io/nullflux/>

## 它能做什么

- **对话驱动仿真**：描述目标或上传论文，智能体读论文、建几何与网格、写字典、启动求解、看日志、出图。
- **复现可信度闸门**：论文参数锁定（`params_lock.json`），任何几何/边界条件简化都要登记为偏离（PENDING → 用户在卡片上批准）；KPI 统计窗与停留时间检查，没过检查不能宣布完成。
- **长时计算托管**：后台求解作业不随网页断开而中断；作业结束、发散或停滞时自动唤醒智能体续跑；LLM 接口断线后按退避自动恢复。
- **启动前体检**：网格质量、patch、核数超订、时间步等启动前检查。
- **监控与后处理**：残差曲线、作业面板、场切片与 3D 预览（three.js）、OpenFOAM 字典高亮。
- **经验沉淀**：验证通过的做法存成技能卡（`skills/`），报错模式自动学习，供后续任务复用。
- **多用户网关**（可选）：`gateway/` 把访客会话放进 bubblewrap 沙箱。

## 安装

需要 **Node.js 18+**。求解器（OpenFOAM、MFIX 等）装在同一台机器上即可，CFDriver 会自动查找；只想试用对话和后处理可以先不装。

**一行安装（Linux / macOS / WSL）**

```bash
curl -fsSL https://raw.githubusercontent.com/LZF1111/nullflux/main/install.sh | bash
cd ~/cfdriver && ./start.sh
```

**从源码**

```bash
git clone --depth 1 https://github.com/LZF1111/nullflux.git cfdriver
cd cfdriver
npm install
npm start
```

**Windows**：克隆或下载 ZIP 后双击 `start.bat`。

浏览器打开 <http://127.0.0.1:5174/app>，在「设置」里填模型接口：任意 OpenAI 兼容接口（OpenAI、DeepSeek、通义、智谱、vLLM、Ollama…）的 Base URL、模型名和 API Key。也可以写在 `.env` 里（参考 `.env.example`）。

常用参数：

```bash
./start.sh --port 5300     # 换端口
./start.sh --host 0.0.0.0  # 对局域网开放（会启用访问令牌，见启动日志）
WORKSPACE_DIR=/data/cases ./start.sh   # 指定智能体可操作的工作目录
```

## 现状与限制

这是一个在研项目，下面是截至 2026-11 的真实情况：

- **已在用**：OpenFOAM 多相流算例（双流体、反应流、搅拌槽 MRF）的建模、长时求解托管、监控和后处理；MFIX、LBM、LIGGGHTS/LAMMPS 有基础支持。
- **论文复现尚未完整跑通**：Lu 2016 中试 MTO 三维反应器正在复现，冷态 20 s + 热态 100 s 按原始设置测得约需 3 个月墙钟（时间步受 Ur-Courant 限制在 2e-5 s 量级，网格约为原文 2 倍）；放宽 maxCo、粗化网格等提速方案正在对照测试，需经偏离审批后才会用于正式计算。
- **智能体本身的薄弱处**：长任务里常见的卡顿来自 LLM 接口断线或欠费、等待用户审批、模型写出缩进错误的 Python；已有自动恢复，但仍需人工照看。
- **依赖模型能力**：效果与所用模型强相关；弱模型容易在网格和边界条件上出错，复现闸门会拦下但不会替它修好。
- 界面和提示以中文为主。
- 本仓库早期发布过加密封装的版本，已全部下线，现在仓库里就是完整源码。

## 目录结构

```
server.js     后端入口：HTTP/WebSocket、智能体循环、全部工具定义与执行
agent_core.js 智能体循环的公共逻辑
agent_recovery.js    LLM 断线后的自动恢复
orchestration.js     物理核数、求解排队、子智能体定义、工作区共享笔记（纯逻辑）
fidelity.js   论文复现闸门（参数锁定、KPI 可信度）
deviations.js        偏离登记（PENDING / APPROVED / REJECTED …）
cfd_trial.js         求解试算与证据核验
foam_prelaunch.js    启动前体检
foam_postproc.js     OpenFOAM 后处理统计
monitor.js           作业监控与告警
external_runs.js     接管手动启动的求解器
capabilities.js      求解器识别
skills.js evolve.js  技能卡与自进化
api_config.js 模型接口配置
access_auth.js       局域网访问令牌
notify.js     手机通知（webhook）
*.py          文档读取、网格检查、场后处理、优化驱动等辅助脚本
public/       前端（原生 JS，无构建步骤）
agent-skills/        各求解器的建模技能包（SKILL.md + 模板）
rsi/          研究自动化框架（分布器、鼓泡塔、放大等研究的配置与脚本）
bench/        智能体对照测试：任务、预先写定的判定协议、评分脚本
mto_results/  Lu 2016 MTO 复现的报告与对比图（不含论文原图）
vibtray/      振动托盘 DEM 的 GPU 原型（Taichi）与 LIGGGHTS 输入
design/       设计文档：复现验收合同、独立试算流水线
gateway/      多用户网关与沙箱
test/  单元测试与端到端测试
```

## 参与开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。欢迎提 Issue 和 Pull Request。

## 合作与联系

欢迎高校、研究所和企业在多相流反应器模拟、论文复现、工艺放大与优化等方向合作，也欢迎共同开发：

**李子锋 Zifeng Li**，中国科学院过程工程研究所 · <lizifeng@ipe.ac.cn>

## 许可

[Apache License 2.0](LICENSE)，版权声明见 [NOTICE](NOTICE)。

`public/vendor/` 下随附的第三方前端库保留各自许可：three.js（MIT）、KaTeX（MIT）、marked（MIT）。`agent-skills/*/backplane/fetch_sources.*` 会按需下载 OpenFOAM / Palabos / LAMMPS 源码供智能体查阅，这些源码适用其各自的 GPL/AGPL 许可，不随本仓库分发。
