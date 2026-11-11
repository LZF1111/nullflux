# 官方源码背板机制 (BACKPLANE) — 所有仿真 skill 通用

> 目标：让智能体在**写算法代码 / 生成算例文件**时，始终照官方源代码包为参照，
> 而不是凭记忆杜撰 API、字段名、宏、接口。

## 为什么不把整个源码树塞进 skill

官方源码体量巨大且更新频繁：OpenFOAM ≈ 1–2 GB、MFiX ≈ 数百 MB、Palabos/OpenLB ≈ 数百 MB、
LAMMPS src+examples+potentials ≈ 214 MB。把它们**原样打进 skill** 会：
- 让 skill 包大到无法在多数智能体平台挂载/上传；
- 版本一旦漂移就过期，反而误导。

因此本套 skill 采用 **"指针 + 按需获取 + 精选实拷"** 的三层背板：

### 第 1 层 · SOURCE_MAP（指针，已随 skill 提供）
每个 skill 的 `backplane/SOURCE_MAP.md` 是一张**权威索引表**：针对每一类生成任务
（如"写 dragModel"/"写 fix"/"写 collision kernel"），明确指出应参照官方源码里的**哪个文件、哪个类、
哪个函数、哪个 tutorial/example**。智能体据此去背板源码树里 `read_file` / `grep` 精确定位参考实现。

### 第 2 层 · 按需获取（脚本，用户一次性执行）
`backplane/fetch_sources.*` 脚本把**钉死版本**的官方源码拉到 `backplane/vendor/`。
支持两种模式：
- **git 稀疏/浅克隆**（有网时）：只拉 tutorials/examples/关键 src 子树，省空间。
- **指向已装本地路径**（离线时）：把本机已安装的官方目录（如 `$FOAM_TUTORIALS`、LAMMPS 安装、
  MFiX 安装）软链/登记进 `vendor/`，零下载。

### 第 3 层 · 精选实拷（已随 skill 提供的真实官方样例）
体量小但高价值的官方参考文件（真实 example/tutorial 的输入卡、最小求解器骨架）直接**实体拷贝**
进 `backplane/vendor/…`，即使无网无安装也有"活样例"兜底。LAMMPS skill 已内置真实官方 example 输入卡。

## 智能体使用背板的强制流程

写任何**算法代码/算例字典**前：

1. **查 SOURCE_MAP**：确定本任务对应的官方参考文件路径与类/函数名。
2. **定位参考实现**：在 `backplane/vendor/`（或用户登记的本地安装路径）里
   `grep_search`/`read_file` 打开该参考文件，读其**类继承、注册宏、必填字段、函数签名**。
3. **照抄骨架再改数**：以参考实现为骨架生成新文件；字段名/宏/接口**逐字对齐**官方，只改物理数值与算法核心。
4. **在 ALGORITHM.md 标注**：把本次参照的官方源码路径写进"官方源码背板依据"，可回溯。

若 `vendor/` 为空（用户未跑 fetch 也无本地安装）：
- 智能体应**提示用户运行 `backplane/fetch_sources.*` 或在设置里登记本机官方安装路径**；
- 在缺背板情况下仍可生成文件，但必须在 MANIFEST.md 顶部标注
  `⚠ 未接入官方源码背板，字段/接口需用户比对官方文档核对`，不得假装已核对。

## vendor 目录约定

```
backplane/
├── SOURCE_MAP.md            ← 指针索引（随 skill）
├── fetch_sources.sh / .ps1  ← 获取脚本（随 skill）
└── vendor/                  ← 官方源码落地处（用户获取 / 精选实拷）
    └── <framework>/...
```

`vendor/` 默认加进 `.gitignore`（除少量精选实拷样例），避免把大源码树提交进 skill 仓库。
