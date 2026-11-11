# 自定义模型编译脚手架 + 论文算法植入

本技能只生成**编译脚手架与源码骨架**；`wmake` 的实际编译由用户本机 OpenFOAM 执行。

## 论文 → OpenFOAM 植入流程

### 三遍核对铁律（落地前必走）
任何来自论文的 BC / IC / 数值算法 / 物理常数 / 几何尺寸 / 时间步长 / 求解器选项：

1. **第 1 遍 全文扫读**：逐项抽取「边界条件 / 算法 / 常数」清单。
2. **第 2 遍 关键页核对**：定位含数值的具体页（Methods / Numerical Setup / Table / Fig caption），
   把原页当图核对，防 OCR 错位、上下标丢失、单位脱落。
3. **第 3 遍 量纲与合理性**：
   - 单位一致？（cm/s vs m/s、mm vs m、K vs °C、bar vs Pa）
   - 量纲对？（k=m²/s²、ε=m²/s³、ω=1/s、ν=m²/s，弄反必崩）
   - 数量级合理？（Re 是 1e5 还是 1e7？气泡 d_b 是 mm 还是 μm？）

**任一遍有歧义 → 停下来问用户**，给 2-3 个编号选项，绝不猜值。

### 植入清单（核对通过后输出，让用户逐块确认）
按 7 大块组织：A 几何/计算域、B 网格/数值离散、C 物理/求解器选择、D 边界条件（每 patch 每场独立列）、
E 初始条件、F 物性/常数、G 监测与对标。每项附来源页码 + 公式/表号。全部 OK 才动手写代码。

## 实现方式选择（给用户菜单）
1. **新增模型**（推荐）：与原模型并列，靠 runTimeSelection 选用，不改 OpenFOAM 源码树。
2. 直接修改已有模型（侵入，不推荐）。
3. `fvOptions` codedSource 内联注入（快速验证，无需编译库）。
4. `codedFixedValue`/`codedMixed` BC（只改边界，最轻量）。

放置目录建议在**工作区** `models/<类别>/Foo/`，不动 OpenFOAM 安装树（避免重编整个库）。

## 自定义库目录结构

```
models/dragModels/Foo/
├── Foo.H            ← 类声明
├── Foo.C            ← 实现 + runTimeSelection 注册
└── Make/
    ├── files        ← 源文件列表 + 目标库名
    └── options      ← include 路径 + 链接库
```

## Make/files

```make
Foo.C

LIB = $(FOAM_USER_LIBBIN)/libFooModels
```

- 目标写 `$(FOAM_USER_LIBBIN)/lib<Name>`（编到用户库目录，不污染系统）。
- 编可执行程序（求解器）时改成 `EXE = $(FOAM_USER_APPBIN)/<name>`。

## Make/options

```make
EXE_INC = \
    -I$(LIB_SRC)/finiteVolume/lnInclude \
    -I$(LIB_SRC)/meshTools/lnInclude \
    -I$(LIB_SRC)/transportModels/lnInclude \
    -I$(LIB_SRC)/TurbulenceModels/turbulenceModels/lnInclude \
    -I$(LIB_SRC)/TurbulenceModels/incompressible/lnInclude

LIB_LIBS = \
    -lfiniteVolume \
    -lmeshTools
```

- `EXE_INC`：编译期头文件搜索路径，按你继承/引用的类补 `-I$(LIB_SRC)/.../lnInclude`。
- `LIB_LIBS`：链接期依赖库，缺库会 `undefined reference`（不是编译错，是链接错）。

## runTimeSelection 注册（新增模型的关键宏）

在 `Foo.C` 里：

```c++
#include "Foo.H"
#include "addToRunTimeSelectionTable.H"

namespace Foam
{
    defineTypeNameAndDebug(Foo, 0);
    addToRunTimeSelectionTable(baseModelClass, Foo, dictionary);
}
```

- `defineTypeNameAndDebug(Foo, 0)` — 定义类型名（TypeName "Foo"）。
- `addToRunTimeSelectionTable(基类, Foo, dictionary)` — 让 `constant/*Properties` 里写
  `model Foo;` 时能被工厂选到。基类名（如 `dragModel`）与选择构造子类型（`dictionary`）要与基类声明一致。
- `.H` 里必须有 `TypeName("Foo");` 和对应构造函数声明，重写基类的纯虚函数（如 drag 的 `K()`/`CdRe()`）。

## 编译命令（用户本机执行）

```bash
# 在 models/dragModels/Foo/ 目录下
wclean          # 清理旧编译产物（可选）
wmake libso     # 编译动态库；求解器程序用 wmake（不加 libso）
```

编译失败只看最关键的 `error:` / `undefined reference` 那 5-10 行：
- `error: ... was not declared` → 缺 `-I.../lnInclude` 或漏 `#include`。
- `undefined reference to ...` → `Make/options` 的 `LIB_LIBS` 缺链接库。
- 编译过了，在 `constant/phaseProperties`（或对应字典）把 `dragModel` 改成 `Foo`，
  并在求解器 `controlDict` 的 `libs ("libFooModels.so");` 里链入自定义库。

## 反漂移协议（植入时防越改越飞）

典型病理：核对时是对的，跑起来报小错→改 ν→再报→改 BC→再报→越改离论文越远。
对策：**建参数锁文件**（把 P2 清单的每个数值+来源固化成 `case/PARAMS.lock`），每次改动前对照锁文件；
若要偏离锁值必须显式记录原因。报错优先查 `reference/error-patterns.md` 对症下药，不要盲目改物性。
