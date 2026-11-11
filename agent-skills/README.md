# CFD & MD 算例配置技能包 (Agent Skills)

可移植的 **Agent Skill** 包，让任意主流智能体（Claude / GitHub Copilot / Cursor / Cline /
Codex 等支持 Skill 挂载的 agent）具备**生成仿真算例配置文件与算法源码**的领域能力。

从 CFDriver（OpenFOAM/MFiX/LBM 仿真 agent）与 MDriver（LAMMPS 分子动力学 agent）的实战经验拆解而来。
核心特点：**每个 skill 内置对应软件的官方源码作为"算法背板"**——智能体生成字典/代码前先对齐真实官方源码，
杜绝凭记忆杜撰 API。skill 只产出完整代码文件，实际求解交给用户本机的求解器执行。

## 技能清单

| 技能 | 领域 | 官方源码背板 | 状态 |
| --- | --- | --- | --- |
| `openfoam-case-builder/` | OpenFOAM CFD 算例 + 自定义模型编译 | **双版本内置**：`OpenFOAM-10`(基金会) + `OpenFOAM-v2306`(ESI, 与 v2406 同系) | ✅ 完整 |
| `lammps-md-case-builder/` | LAMMPS 分子动力学 in./data. | **内置** `lammps-official`(src+doc) | ✅ 完整 |
| `mfix-case-builder/` | MFiX 气固多相 (TFM/DEM/PIC) | SOURCE_MAP 指针 + fetch 脚本（源码未内置） | ⚠ 背板未拉取 |
| `lbm-case-builder/` | 格子玻尔兹曼 (Palabos/自研) | Palabos 已拉取到 vendor | ⚠ 暂缓 |
| `_shared/` | 共享层：输出契约 + 背板机制 | — | ✅ |

> OpenFOAM 与 LAMMPS 是核心，官方源码已真实打包在各自 `backplane/vendor/` 下。

## 每个 skill 的标准结构

```
<skill-name>/
├── SKILL.md              ← 主文件：YAML frontmatter(name/description) + 交付契约 + 核心纪律 + 工作流
├── reference/            ← 渐进式披露的领域细节（按需 read_file）
├── templates/            ← 可拷贝的算例骨架
│   └── overviews/        ← 三份总览模板 MANIFEST/ALGORITHM/TUNING
└── backplane/            ← 官方源码背板
    ├── SOURCE_MAP.md     ← 生成任务 → 官方源文件/类的精确索引（"用什么求解器/怎么配置/算法参照"）
    ├── fetch_sources.sh  ← 拉取/更新/软链官方源码
    ├── fetch_sources.ps1
    └── vendor/           ← 内置的官方源码（OpenFOAM 双版本 / LAMMPS src+doc / Palabos）
```

## 交付契约（所有 skill 强制）

见 `_shared/OUTPUT_CONTRACT.md`。每个算例交付时必须包含：
1. **整体算例文件**：跑一个算例所需的全部文件，一个不缺。
2. **三份总览**：
   - `MANIFEST.md` — 文件总览（清单 + 目录树 + 运行顺序）
   - `ALGORITHM.md` — 算法总览（控制方程 + 公式→代码映射 + 官方源码依据）
   - `TUNING.md` — 可能问题及调优方向（稳定性风险 + 自查清单）

## 官方源码背板机制

见 `_shared/BACKPLANE.md`。三层设计：
1. **SOURCE_MAP.md** — 把每个生成任务映射到官方源码的精确文件/类/函数（用哪个求解器、怎么配置、算法参照哪里）。
2. **fetch_sources.sh/.ps1** — `status`/`clone`/`link` 三模式拉取或软链官方源码到 `vendor/`。
3. **vendor/** — 内置的真实官方源码。写字典/算法前先 `read_file` 打开对齐，禁止猜 API。

## 如何挂载

| 智能体 | 挂载方式 |
| --- | --- |
| Claude (Code / Desktop / API) | 放进 `~/.claude/skills/<name>/` 或项目 `.claude/skills/`，或经 Skills API 上传 zip |
| GitHub Copilot (VS Code) | 复制到工作区，正文即领域指令；或转为 instructions 引用 |
| Cursor / Cline / Codex | 把 `SKILL.md` 作为 rules/instructions 引入，reference/ 与 backplane/ 随项目提供 |
| 通用（任意读文件的 agent） | 让 agent `read_file` 读 `SKILL.md`，按指引再读 reference/ 与 backplane/SOURCE_MAP.md |

各技能互相独立，可单独拷贝分发（含各自的官方源码背板）。
