# NullFlux

开源的多相流 CFD 智能体工作台：用大模型驱动 OpenFOAM / MFIX / LBM / DEM 的建模、求解、监控与后处理。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) ![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

## 功能

- **对话驱动仿真**：描述目标或上传论文，智能体读文献、生成几何与网格、写字典、启动求解、读日志、出图。
- **后台长时求解**：求解作业独立于网页运行，服务重启后自动接管；作业结束或异常时唤醒智能体继续。
- **断线自动恢复**：模型接口出错时自动重试，恢复后从中断处继续。
- **复现审批**：论文参数锁定，几何与边界条件的简化需登记为偏离并经用户批准。
- **启动前体检**：网格、边界、核数、时间步等常见问题在启动前检查。
- **监控与后处理**：作业面板、残差曲线、场切片、3D 预览、字典语法高亮。
- **经验沉淀**：验证通过的做法存为技能卡，供后续任务复用。
- **任意 OpenAI 兼容模型**：云端 API 或本地 vLLM / Ollama。

## 安装

需要 Node.js 18+。求解器（OpenFOAM、MFIX 等）装在同一台机器上即可。

```bash
curl -fsSL https://raw.githubusercontent.com/LZF1111/nullflux/main/install.sh | bash
cd ~/nullflux && ./start.sh
```

或从源码：

```bash
git clone --depth 1 https://github.com/LZF1111/nullflux.git
cd nullflux && npm install && npm start
```

Windows：下载后双击 `start.bat`。

浏览器打开 <http://127.0.0.1:5174/app>，在「设置」里填写模型接口的 Base URL、模型名和 API Key（也可写在 `.env`，参考 `.env.example`）。

```bash
./start.sh --port 5300   # 换端口
./start.sh --host 0.0.0.0       # 局域网访问（启用访问口令，见启动日志）
WORKSPACE_DIR=/data/cases ./start.sh   # 指定工作目录
```

## 目录结构

```
server.js      服务入口：HTTP / WebSocket、智能体循环、工具定义与执行
*.js           独立模块：恢复、复现审批、试算、体检、监控、技能库、配置、通知等
*.py           文档读取、网格检查、场后处理、优化驱动
public/        前端（原生 JS，无构建步骤）
agent-skills/  各求解器的建模技能包
skills/        经验规则库
gateway/       多用户网关（可选）
test/   测试
```

## 参与开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。欢迎 Issue 和 Pull Request。

合作联系：<lizifeng@ipe.ac.cn>

## 许可

[Apache License 2.0](LICENSE)。`public/vendor/` 下的 three.js、KaTeX、marked 保留各自的 MIT 许可。
