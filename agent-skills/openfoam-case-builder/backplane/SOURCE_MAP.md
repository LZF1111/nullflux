# OpenFOAM 官方源码背板索引 (SOURCE_MAP) — 双版本

> 写任何算例/自定义模型前，先来这张表定位官方参考实现，在 `vendor/` 里 `read_file` 打开真实源码，
> 照其类结构/宏/字典写。**本 skill 已内置两套完整官方源码**，禁止凭记忆猜 API。

## 0. 已内置的官方源码（就在本 skill 里，非指针）

| 版本 | vendor 路径 | 分支线 | 求解器风格 | 大小 |
| --- | --- | --- | --- | --- |
| **Foundation OpenFOAM-10** | `vendor/OpenFOAM-10/` | Foundation (.org) | 经典独立求解器 `simpleFoam`/`pimpleFoam`/`interFoam` | ~158 MB |
| **ESI OpenFOAM-v2306** | `vendor/OpenFOAM-v2306/` | ESI/OpenCFD (.com)，与 **v2406 同系** | 同为经典独立求解器 | ~156 MB |

两套都含 `applications/solvers/`（求解器源码）、`src/`（库源码）、`tutorials/`（官方算例）。
> v2306 与 v2406 属同一 ESI 分支线，字典与求解器约定一致 → 生成 v2406 算例时以 `OpenFOAM-v2306/` 为准即可。

## ★ 版本差异对照表（生成前必看，选错字典必报错）

| 主题 | Foundation OpenFOAM-10 | ESI OpenFOAM-v2306 / v2406 |
| --- | --- | --- |
| 湍流库源码根 | `src/MomentumTransportModels/` | `src/TurbulenceModels/` |
| kOmegaSST 源码 | `src/MomentumTransportModels/momentumTransportModels/RAS/kOmegaSST/kOmegaSST.C` | `src/TurbulenceModels/turbulenceModels/RAS/kOmegaSST/kOmegaSST.C` |
| 湍流选择字典 | `constant/momentumTransport` | `constant/turbulenceProperties` |
| 粘度/输运字典 | `constant/physicalProperties`（含 `viscosityModel`） | `constant/transportProperties`（含 `transportModel`） |
| RAS 模型键 | `RAS { model kOmegaSST; }` | `RAS { RASModel kOmegaSST; }` |
| 源项框架 | `src/fvModels/` + `src/fvConstraints/`（`constant/fvModels`/`constant/fvConstraints`） | `src/fvOptions/`（`system/fvOptions` 或 `constant/fvOptions`） |
| 边界条件库 | `src/finiteVolume/fields/fvPatchFields/derived/` | 同左（路径一致，条目基本相同） |

> **默认策略**：用户不指定版本时先问“基金会版(10) 还是 ESI 版(v2406)?”，默认 ESI v2306/v2406。
> 生成后在 MANIFEST.md 顶部写明 `目标版本: OpenFOAM-vXXXX`，并保证所有字典键与该版本一致。

## 一、算例字典 → 官方教程参照（两版都在 `vendor/<版本>/tutorials/`）

| 你要生成 | 参照官方教程（相对 tutorials/） | 关键点 |
| --- | --- | --- |
| 稳态外流绕物 + snappy | `incompressible/simpleFoam/motorBike` | snappyHexMeshDict/addLayersControls 黄金模板 |
| 内流通道 RANS | `incompressible/simpleFoam/pitzDaily` | 最小 RANS 骨架 |
| 瞬态不可压 | `incompressible/pimpleFoam/RAS/...` | PIMPLE nOuterCorrectors/nCorrectors |
| 两相 VOF 自由界面 | `multiphase/interFoam/laminar/damBreak/damBreak` | alpha.water + setFieldsDict + p_rgh |
| 自然对流传热 | OF-10: `heatTransfer/buoyantFoam/...`；ESI: `heatTransfer/buoyantSimpleFoam/hotRoom` | p_rgh/T/alphat |
| 共轭传热 | `heatTransfer/chtMultiRegionFoam/...` | 多区域 regionProperties |
| 反应/燃烧 | `combustion/reactingFoam/...` | thermophysicalProperties/chemistry |
| 搅拌釜 MRF 稳态 | OF-10 有 `incompressible/simpleFoam/mixerVessel2DMRF` | MRFProperties + cellZone |

> 找具体教程：在 `vendor/<版本>/tutorials/` 下按上表路径 `read_file` 打开，**整套拷贝**其
> `system/`+`constant/`+`0.orig/` 作骨架，再改几何/物性。两版教程目录名可能略有出入，以实际 vendor 树为准。

## 二、自定义算法源码 → 官方 src 参照

| 你要写 | Foundation OpenFOAM-10 参照 | ESI v2306/v2406 参照 | 关键接口 |
| --- | --- | --- | --- |
| RAS 湍流模型 | `src/MomentumTransportModels/momentumTransportModels/RAS/kOmegaSST/` | `src/TurbulenceModels/turbulenceModels/RAS/kOmegaSST/` | 继承 `eddyViscosity<...>`，重写 `correct()`；`defineTypeNameAndDebug`+`addToRunTimeSelectionTable` |
| 边界条件 patchField | `src/finiteVolume/fields/fvPatchFields/derived/`（挑最像的，如 `codedFixedValue`/`fixedValue`） | 同左（路径一致） | 继承 `fixedValueFvPatchField<T>`，重写 `updateCoeffs()`；`makePatchTypeField` 宏 |
| 动量/标量源项 | `src/fvModels/derived/`（如 `meanVelocityForce`） | `src/fvOptions/sources/general/{codedSource,semiImplicitSource}/` | `addSup()`/`constrain()`；OF-10 走 fvModels，ESI 走 fvOptions |
| 自定义求解器主程序 | 整份拷 `applications/solvers/incompressible/simpleFoam/` 作骨架 | 同左 | `createFields.H` + `UEqn.H`/`pEqn.H` 方程装配 |
| 输运/物性模型 | `src/physicalProperties/`（viscosityModel） | `src/transportModels/`（transportModel，如 `Newtonian`/`CrossPowerLaw`） | 按基类重写 |
| 多相曳力等相间力 | `.../interfacialModels/dragModels/SchillerNaumann/` | 同名子树 | 继承 `dragModel`，重写 `CdRe()` |

## 三、编译脚手架参照（wmake）

- `Make/files` / `Make/options`：**直接看你参照的那个模型目录下的同名文件**（最可靠，逐字对齐）。
- 库目标：`LIB = $(FOAM_USER_LIBBIN)/lib<Name>`；程序目标：`EXE = $(FOAM_USER_APPBIN)/<name>`。
- `EXE_INC` 里的 `-I$(LIB_SRC)/.../lnInclude`：照参照模型 options 抄，缺一个就编不过。
- 两版 wmake 都在 `vendor/<版本>/wmake/`。

## 四、注册宏速查（照官方源码逐字对齐）

```cpp
// 模型类 (runTimeSelection):
defineTypeNameAndDebug(Foo, 0);
addToRunTimeSelectionTable(baseClass, Foo, dictionary);

// 边界条件:
makePatchTypeField(fvPatchScalarField, FooFvPatchScalarField);
```

## 五、验证生成结果对不对（拿官方源码/教程对照）

1. 字典键：打开 `vendor/<版本>` 里对应求解器的 `createFields.H` 或模型 `read()`，确认键名/类型在该版本存在。
2. BC 类型名：在 `src/finiteVolume/fields/fvPatchFields/` 下 grep 你用的 `type`，确认拼写与该版本一致。
3. 教程回归：与同物理的官方 tutorial 逐文件比对结构，缺项即补。

> 若 `vendor/` 被清空：在 ALGORITHM.md/MANIFEST.md 顶部标注 `⚠ 未接入官方源码背板`，
> 提示用户运行 `fetch_sources.*` 重新拉取，字典/公式回退到 `reference/` 与教材。
