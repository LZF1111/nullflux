# OpenFOAM 高频报错模式与修法

运行由用户本机执行；本表帮助你在配置阶段规避，以及读到 log 报错时快速定位修法。

## 缺文件 / case 不完整

- **`Cannot find file "system/controlDict|fvSchemes|fvSolution|blockMeshDict"`**
  - 因：case 目录不完整，或 cwd 不在 case 根目录。
  - 修：补齐三大目录必需字典；确认在含 `system/controlDict` 的目录里运行。

- **`Cannot open file .../polyMesh/points`（或 boundary）**
  - 因：还没跑 `blockMesh`/`snappyHexMesh` 就调求解器。
  - 修：先生成网格（blockMesh → checkMesh），再跑求解器。

## 字典关键字 / 求解器不匹配

- **`keyword ... is undefined` / `entry ... not found`**
  - 因：模板与求解器版本不匹配；fvSchemes/fvSolution 缺必填项；v2306 keyword 改名。
  - 修：以官方同版本 tutorial 字典为骨架逐字段对齐；`foamDictionary` 校验单个条目。

- **`snappyHexMeshDict ... From dictionary::readEntry ... FOAM exiting`**
  - 因：v2306 起 `addLayersControls` 少一个 int/scalar 字段就退出。
  - 修：**不要手写**，抄 motorBike/其它带 layers 的 tutorial 的 addLayersControls 整块，只改数值。

## 边界条件问题

- **`... boundary type ... not found` / unknown patchField**
  - 因：BC 名拼错（如 `nutkWallFunction` 写成 `nutWallFunction`）；需要的库未 `libs` 链入；求解器不支持该 BC。
  - 修：核对正确拼写（见 boundary-conditions.md）；`controlDict` 末尾 `libs ("...");`。

- **`... patch ... not defined` / patch 名不匹配**
  - 因：`0/` 里 patch 名 ≠ `polyMesh/boundary` 里的名；blockMesh 重生成后 0/ 未同步。
  - 修：用 `foamDictionary constant/polyMesh/boundary` 列真实 patch 名，逐字对齐每个场的 boundaryField。

## 网格质量

- **`checkMesh` 报 `negative volume` / `Mesh has ... incorrectly oriented faces`**
  - 因：snappy 抠空了区域；极薄 sliver cell；STL 法向反了。
  - 修：检查 STL 法向朝外与封闭性；调 snappy 的 refinement/locationInMesh；降层数或膨胀比。

- **`High skewness` / `non-orthogonality > 70`**
  - 修：`fvSchemes` 的 `snGradSchemes` 用 `limited 0.5`；`fvSolution` 加
    `nNonOrthogonalCorrectors 1~2`；改善网格。

## 求解发散 / 不收敛

- **残差不降 / `bounding k,omega` 频繁 / 压力求解 `solution singularity`**
  - 因：初场太差；松弛因子太大；离散格式太激进；BC 不物理；量纲写错。
  - 修：
    - 降松弛（p 0.3、U 0.5、湍流 0.5）先稳住再逐步放开；或用 `consistent yes`(SIMPLEC)。
    - `div(phi,U)` 从 `linear` 退到 `linearUpwind` 或 `upwind`。
    - `potentialFoam` 打初场；出口用 `inletOutlet` 防回流。
    - 逐个核对量纲（k/epsilon/omega/nu），这是最隐蔽的崩溃源。

- **`Maximum number of iterations exceeded`（线性求解器）**
  - 修：`fvSolution` 放宽 `tolerance`；`smoother` 换 `GaussSeidel`；`preconditioner` 换 `DIC`/`DILU`。

## 多相专属

- **界面涂抹严重 / alpha 越界**
  - 修：`div(phi,alpha)` 用 `vanLeer`；`interFoam` 用 `cAlpha 1`；`MULESCorr yes`；减小 Courant。

- **setFields 后 alpha 仍 uniform**
  - 因：`defaultFieldValues` 覆盖了 regions，或 region bbox 没匹配到 cell。
  - 修：检查 setFieldsDict 的 `boxToCell`/`cylinderToCell` bbox 在网格域内；确认 regions 在 default 之后。

## 并行

- **`Cannot find file ... processorN`**
  - 因：没 `decomposePar` 就 `mpirun`；或核数与 decomposeParDict 不符。
  - 修：先 `decomposePar`，`numberOfSubdomains` 与 `mpirun -np N` 一致；结束 `reconstructPar`。

## 通用定位技巧

- 报错先看最后 30 行的 `--> FOAM FATAL ERROR` 与 `From ...::...` 那几行，定位是哪个字典哪个条目。
- `foamDictionary <file> -keyword <key>` 单点查值，比 read 整个大场文件省 token（setFields 后场文件可能上百万行）。
- 改配置遵循「小步 + 每改必验」：改一处 → 重跑 blockMesh/checkMesh 或 `-postProcess` → 看是否消错。
