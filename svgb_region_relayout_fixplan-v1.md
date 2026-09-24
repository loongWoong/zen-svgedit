# 固定区域内多元素相对位置布局 · 修改方案 v1

> 前置文档：`svgb_region_relayout_rules-v1.md`（规则设计：L0–L7、5 条结构性缺陷、验收指标）
> 本文档回答"**具体改哪里、改成什么、怎么证明改对了**"，全部锚定到 `file:line`。
> 被测样本：`ontology-palantir.beautified.beautified.svg`（sha256 `6c1d3f0c…`）。
> 本文档**不改任何代码**。

---

## 0. 一句话方案

**先只做两件事：给位移加上限（§3.1）、给结构破坏加硬门（§3.2）。** 这两件事能把 §2 实验里**三个被接受的 op 全部否掉** —— 代价是本样本分数从 38.75 退回 30.35，收益是图不再被改坏。其余（区域层、附着跟随、节奏/均衡）按 §5 的顺序分步做，每步都能独立验证。

这是一个需要你拍板的取舍，所以我把它量化摆在最前面：

| | 现状 | 只做 §3.1 + §3.2 | 做完 §5 全部 |
|:--|:--|:--|:--|
| 本样本分数 | 30.35 → **38.75** | 30.35 → **30.35**（三个 op 全被否） | 30.35 → **30.35**（几何修对了但评分看不见，见 §6.1） |
| 平台栈左边缘极差 | **211.83 → 266.1** | **211.83（不动）** | 211.83 → **≈0** |
| 卡片 3 箭头错位 | **21.5 / 42.01 → 36 / 72** | 不变 | → **0 / 0** |
| 出界元素数 | **0 → 4** | 不变 | → **0** |
| 退化路径数 | **0 → 3** | 不变 | → **0** |

**"分数退 8.4 分"不是退步，是把假增益还回去。** 这 8.4 分里 5.4 分来自把两条 1942/1957px 的装饰样条压成一条直线（§2.3）。

---

## 1. 四条根因已定位到代码行

| 根因 | 位置 | 代码事实 |
|:--|:--|:--|
| **D1 过度修正** | `src/06_geometry.js:1641` `separation()` 的 `base()`（`:1643-1648`） | 位移 = **完全分开两个盒子**，不是"消除重叠所需的量"：`R.right(a) − b.x + 10`。实测校验：`svg_75` 右边缘 `1482.8`、装饰环 `svg_27` 左边缘 `1278` → `1482.8 − 1278 + 10 = 214.8` —— **与台账里的 214px 完全吻合**。且 `MULS = [1, 1.6, 2.4]`（`:1650`）还会再放大到 2.4 倍（最高 515px） |
| **D2 连接体不跟随** | `src/06_geometry.js:1882` `applyTranslate()` | `:1902` 只让**节点标签**跟随：`if (item.labels && item.labels.length) …`。**没有任何分支处理连接体（`<path>`/`<line>`）**。而 `case 'spacing'`（`:1015`）`case 'overlap'`（`:909`）都只传 `n.elem` / `mover.elem` → 方块走了，箭头留在原地 |
| **D3 无容器契约** | 全仓库**不存在**该约束 | `Geo.plan` 只检查"不越画布"（`:1007` 出画布保护、`:1662` `after.x < 0` 判断），**没有"不越出所属区域"这一层**。所以卡片 4 的两条 bar 可以整条跑到卡片 3 上 |
| **D5 打分门看不见结构破坏** | `src/07_patch.js:70` `Validator.checkOp(a0, a1)` | 只读 `a1.score` 与 `a0/a1.metrics`（`:72-77`）。而 `metrics` 只有 7 个维度（`04_analyzer.js` 的 `METRIC_KEYS`），**不含**出界、导引离散、连接体错位、路径退化 → 这些破坏对被接受的 op 完全不可见 |

另外定位到一处**尚未在 §2 实验中体现但会写错坐标**的缺陷：

* `src/06_geometry.js:1931-1933` `applyResize()` 的**非图元（`<g>`）分支**：
  ```js
  const old = getA(g, 'transform', '');
  setA(g, 'transform', `translate(${r2(x)},${r2(y)}) scale(${nf(w/Math.max(1,node.geomBox.w),4)},…)` + (old ? ' ' + old : ''));
  ```
  它写入**绝对** `translate(x,y)`，却把**旧的 transform 原样拼在后面**。对已有 `translate(1605 748)` 的组，结果绝对位移是 `(x + sx·1605, y + sy·748)` —— 旧平移被**再叠加一次**。本样本里 `g#svg_80`（`matrix(1.22729 0 0 1.19623 1733.88 371.197)`）与 `g#svg_118`（`translate(0 0) matrix(1 0 0 1 1778.47 748)`）**恰好都带这种特征**。→ 已列入 §3.4，但**标注为"静态阅读发现、需要定向复现确认"**，不作为已证实结论。

---

## 2. 待证明的目标：修改后应当发生什么

用 §1 已验证的归因实验作为**验收测试**（`.svgbuild/palantir_attr.cjs`）。当前实测：

| 被接受的 op | Δ分 | 破坏的结构量（实测） |
|:--|--:|:--|
| `spacing:distribute_weighted#10` | +0.8 | 卡片 3 箭头错位 **21.5 → 36**、**42.01 → 72** |
| `overlap:move_apart#4` | +1.2 | 为 **7.8px** 重叠位移 **214px** / **180px** / 45px |
| `edge_crossing:orthogonal_reroute#5` | +5.4 | `svg_3`(1942px)、`svg_4`(1957px) → `(0,540,1920,0)`；`svg_22`/`svg_77`/`svg_117` → 零尺寸 |

**修改后的期望**：这三个批次**全部被否**（`rej` 从 11 升至 14，`acc` 从 3 降至 0），最终 `after == before == 30.35`，且
`guideSpreadMax ≤ 211.83`、`attachedGapError ≤ 42.01`、`containViolations == 0`、`edgeDegeneracy == 0`、`decorativeDestroyed == 0`。

**这就是本方案的可证伪判据**，不需要主观评价。

---

## 3. 核心修改（止血集）

### 3.1 `d_max`：位移幅度上限 —— 改 `src/06_geometry.js:1641` `separation()`

**现状**：`base()` 只产出"完全分开"的位移，没有任何"只消除重叠"的候选。

**改法**：在 `cands` 里**先**加入"部分位移"候选，再保留原有的完全分开候选，最后仍按 `dist.min` 排序取最小 —— 这样最小候选天然变成"刚好分开 + margin"。

```js
/* 新增：以「恰好消除该轴重叠 + margin」为位移的部分候选。
 * 旧实现只有「完全分开」一种候选，于是 7.8px 的重叠被换算成 214.8px 的位移
 * （实测：R.right(svg_75)=1482.8 − svg_27.x=1278 + 10 = 214.8）。 */
const overlapOn = (axis, dir) => axis === 'x'
  ? (dir > 0 ? R.right(a.geomBox) - b.geomBox.x : R.right(b.geomBox) - a.geomBox.x)
  : (dir > 0 ? R.bottom(a.geomBox) - b.geomBox.y : R.bottom(b.geomBox) - a.geomBox.y);
```

并统一加**硬上限**（在 `separation()` 返回前）：

```js
const dMax = Math.max(1.5 * (p.depth || 0), 0.06 * Math.min(ir.canvas.w, ir.canvas.h));
```
本样本：`max(1.5×7.8, 0.06×1080) = max(11.7, 64.8) = 64.8` → **214px 候选被过滤，`separation()` 返回 `null`**，`case 'overlap'`（`:904`）自然走进"无可推开方向"的 `skipped` 分支。**不会硬推。**

> **作用域必须收窄（重要）**：`d_max` 只施加给 **`overlap` / `spacing` 这类"局部修正"策略**。
> **绝不能加给 `misalignment:snap_*`** —— 对齐吸附天然需要大位移（把离散 200px 的一列吸到同一导引上，
> 单元素位移就是 200px），加 `d_max` 会把整个对齐能力一起挡掉。
> 本样本里 `distribute_weighted` 把方块移了 30～70px 量级，**光靠 `d_max` 挡不住它**，它由 §3.2 的附着硬门挡住。

### 3.2 结构硬门 —— 新增 `src/06b_struct.js`，接进 `src/07_patch.js:70`

这是**最关键的一条**。新增一个纯读的结构快照模块：

```js
/* src/06b_struct.js —— 结构不变量快照（只读，不产生 op）
 * 为什么必须独立成模块：Validator.checkOp 现在只拿到 Analyzer 的输出，
 * 而 Analyzer 的 7 个维度里没有"结构有没有被弄坏"。 */
const Struct = {
  snapshot(ir) { return {
    containViolations,   /* 超出归属区域的元素数 */
    containPx,           /* 总溢出像素 */
    guideSpreadMax,      /* 各导引组坐标极差的最大值 */
    attachedGapError,    /* 连接体端点与其锚点形状边/中心的偏移之和 */
    edgeDegeneracy,      /* 外接框面积为 0 或共线的 path 数 */
    decorativeDestroyed  /* decorative 元素被改写/删除的数量 */
  }; }
};
```

`07_patch.js` 的接线点（`_tryUnits` 内 `:150-165` 一带，`Validator.checkOp(baseAn, a2)` 调用处 `:163` 前后）：

```js
const s0 = Struct.snapshot(ir0);          /* 本批之前的结构 */
…
const s1 = Struct.snapshot(ir2);          /* 本批之后的结构 */
const c  = Validator.checkOp(baseAn, a2, s0, s1);
```

`Validator.checkOp` 扩成四参，在现有 `gain <= MIN_GAIN_OP` 判断之后追加：

```js
/* ★ 结构硬门：任一不变量劣化 → 一票否决（不参与打分） */
for (const k of STRUCT_KEYS) if (s1[k] > s0[k] + EPS[k]) reasons.push(`结构劣化：${CN[k]} ${s0[k]} → ${s1[k]}`);
```

`STRUCT_KEYS = ['containViolations','containPx','guideSpreadMax','attachedGapError','edgeDegeneracy','decorativeDestroyed']`，
`EPS` 给浮点余量（`containPx: 0.5`，其余 `0`）。

**为什么这比加打分项正确**：打分项会被其它维度的增益抵消（现状正是如此：`edgeRouting` +5.4 抵消了全部结构损失）；硬门是一票否决。

### 3.3 `decorative` 豁免 —— 改 `src/04_analyzer.js` 的 `collision()` / `occlusion()`

`fill="none"`（或 `normColor(fill) === ''`）的**同心装饰环**、`opacity ≤ 0.3` 的**装饰样条**，不应作为实体障碍：

* 从 `raw.collision.pairs` 的候选里排除 `decorative` 的一方 —— 否则卫星落在 112px 装饰环上会被当成缺陷（正是 214px 位移的起因）；
* 从 `edge_crossing` 的候选边里排除 `decorative` 路径 —— 否则 1942/1957px 的装饰样条会被"重路由"成直线。

判据集中放在一个 helper（`Analyzer.decorativeOf(n)`），并在 `03_ir.js` 里就把 `n.decorative` 标好，避免两处各判一次。

### 3.4 `applyResize` 的组分支 —— 改 `src/06_geometry.js:1931-1933`

把写入"绝对 `translate(x,y)` + 旧 transform"改成写入**相对位移**，避免旧平移被二次叠加：

```js
} else {
  const old = getA(g, 'transform', '');
  /* 旧实现写 translate(x,y) 并把 old 拼在后面 → 旧平移被再叠加一次。
   * 非图元（<g>）无法用 x/y 表达绝对位置，只能给相对的 (dx,dy)。 */
  const dx = r2(x - node.geomBox.x), dy = r2(y - node.geomBox.y);
  setA(g, 'transform', `translate(${dx},${dy})` + (old ? ' ' + old : ''));
}
```
> ⚠️ **状态：静态阅读发现，尚未定向复现。** 落此项前先用一个最小用例（`<g transform="translate(100 100)"><rect/></g>` 做一次 resize，断言矩形绝对位置 == 目标）证明旧代码确实错、新代码确实对。**不要把"读出来像 bug"当成"已证实是 bug"。**

### 3.5 L4 附着跟随 —— 改 `src/06_geometry.js:1882` `applyTranslate()`

在 `:1902` 的标签跟随之后补连接体跟随：

```js
/* 连接体跟随：端点锚在该形状上的 path，其端点（及其相邻控制点）同步位移。
 * applyTranslate 的签名要加一个可选的 att（附着表），由 plan() 从 Struct 传入。 */
```

* 端点锚定判据：`path` 的首/末点落在形状外框的 `τ_a = 6px` 邻域内（本样本 Card 3 的 `svg_94/99/104` 首点正好在 `svg_91/96/101` 的底边上）。
* 另一端锚在别的形状上时，**两端各自重锚**（`svg_94` 上端随方块、下端留在地座上 → 变成斜线，这才是正确的"复用"表达）。
* 曲线：端点位移时把**相邻控制点同量位移**，保持曲率形状。
* 复用既有的 `applyPath(edge, pts)`（`:1937`）写入，不新写序列化代码。
* **前置确认（实现时第一件事）**：`ir.edges[]` 的端点/控制点字段名（`applyPath` 在 `:1038` 被 `e` 调用，`e.describe` 存在，但 `pts` 的来源需要读一遍 `IR.build`）。

> 这一项**必须与移动同时提交**，不能事后补偿 —— 所以它进的是"移动 op 的实现"，不是一条独立策略。它同时提供 `attachedGapError` 给 §3.2 的硬门。

---

## 4. 门槛问题：几何修对了，谁来接受它？

`Validator.MIN_GAIN_OP = 0`（`07_patch.js:52`）且判据是 `gain <= MIN_GAIN_OP` → **要求严格增益**。这意味着：

* **纯结构改善（`gain == 0`）的 op 永远进不来** —— L5 区域均衡、L6 径向规整、以及 §3.5 的附着修正都可能只值 0 分（本样本 `spacing`/`style` 恒为 0）。
* 所以必须显式决定"结构改善如何获得接受权"。

**推荐做法（阶段一）**：把 `checkOp` 的判据从"必须有增益"放宽为"**不欠账 且（有增益 或 有结构改善）**"：

```js
const gainOk   = gain > this.MIN_GAIN_OP;
const structOk = STRUCT_KEYS.some(k => s1[k] < s0[k] - EPS[k]);
if (!gainOk && !structOk) reasons.push(`该批既无增益也无结构改善（${a0.score} → ${a1.score}）`);
```

**为什么这是安全的**：它**不可能降低任何样例的分数** —— 接受条件里仍然要求 `gain >= 0`（`MIN_GAIN_OP = 0` 意味着"不欠账"），且结构硬门一票否决。因此现有 36 样例的零回归性质**在构造上保持**，可以用现有 `cmp_sweep.cjs` 直接证明。

**不推荐的做法（阶段二之前）**：把结构量直接写进 `WEIGHTS` / `METRIC_KEYS`。那会给全部 36 样例的分数重新定标，且必须先有分布数据（即规则设计 §5 的 6 个指标在多样本上的基线）。这正是 F6 第二段该做的事。

---

## 5. 分步实施计划

| 步 | 内容 | 触及文件 | 依赖 | 验收（可证伪） |
|:--|:--|:--|:--|:--|
| **S1** | `d_max` 幅度上限（§3.1） | `06_geometry.js`（`separation`、`spacing`；**不含 `snap_*` 族**） | — | 重跑 §2 实验：`move_apart#4` 被否；全量 36 样例 `meanAfter` 不降 |
| **S2** | `src/06b_struct.js` + `checkOp` 四参 + `decorative` 豁免（§3.2、§3.3） | 新增文件、`04_analyzer.js`、`07_patch.js`、`ui.html`（注册 → **段数 15→16**）、`README.md`（段数/产物尺寸） | S1 | 重跑 §2 实验：`orthogonal_reroute#5` 与 `distribute_weighted#10` 被否；本样本 `acc 3 → 0`、`after == 30.35` |
| **S3** | 门槛放宽为"增益或结构改善"（§4） | `07_patch.js` | S2 | 全量 36 样例：`meanAfter` 逐位不降、`sumDelta` 不降；本样本仍 `30.35` |
| **S4** | 附着跟随（§3.5） | `06_geometry.js`（`applyTranslate`、`plan` 的 `claim` 调用点） | S2 | Card 3 箭头错位：**不再恶化**；若 L4 规则同时生效则 → `0/0` |
| **S5** | `applyResize` 组分支（§3.4） | `06_geometry.js:1931` | 先做最小复现 | 最小用例断言通过；本样本 `g#svg_80`/`g#svg_118` 的矩阵不再被二次叠加 |
| **S6** | 区域层修复（`invariant:false`、重复区域、跨卡片区域、`inkDensity=1.0` 退化） | `03b_region.js`、`04_analyzer.js`（`regionMetrics`） | — | `RegionGraph` 在 37 样例上 `invariant:true`；本样本无重复包围盒、无跨卡片区域；`worstRegion` 不再是 `inkDensity 1.0` |
| **S7** | L3 节奏 / L5 均衡 / L6 径向 + 阈值定标 | `06_geometry.js`、`04_analyzer.js`（新 issue 类型，走 6 处注册契约） | S3、S6 | 新指标（`contentOccupancy`、`radialAngleCv`、`gapCv`）改善；全量扫描零回归 |

**关键路径**：**S1 → S2 → S3 就是完整的最小止血集**，且每一步都有可证伪的验收判据。S6 是 S7 的前置（在坏区域上做均衡规则会在错误区域生效）。S4、S5 互相独立，可并行。

**S2 的注册成本要提前知道**：新增 `src/06b_struct.js` 会改变 `build.py` 的段数（15 → **16**），所以必须同步 `ui.html` 的 `<script src>` 与 `README.md:130` 的"15 段 / 行数 / 字节数"，并重跑 `python build.py` + `--check` + `--verify`。这是仓库既有约定，不是可选项。

---

## 6. 诚实边界

1. **这套修改不会提高任何样例的分数**（本样本甚至会把 38.75 退回 30.35）。原因是 `spacing` 与 `style` 在幻灯片域恒为 0，评分视野覆盖不到本次要修的东西。**价值是"不再把图改坏"**，以及为 F6 第二段定标积累指标。如果期望是"美化后分数更高"，那需要先做定标（F6 第二段），那是另一条线。
2. **`d_max` 的 `0.06 × 容器短边` 是我的设计值，未定标。** 本样本 1080 短边给出 64.8px 上限，恰好挡住 214px；但这个系数应当在全量样例上扫一遍，确认不会误杀正常的局部修正（**注意其作用域必须排除 `snap_*` 族，见 §3.1**）。
3. **§3.4 的 `applyResize` 组分支只是"读出来像 bug"**，尚未定向复现。落地前必须先用最小用例证实。
4. **`attachedGapError` 的度量本身尚未实现**，`ir.edges[]` 的端点字段名需要先读 `IR.build` 确认（§3.5 已标为"实现时第一件事"）。
5. **`decorative` 判据的副作用未验证**：排除装饰样条后，`edgeRouting` 在若干样例上可能因为"不再重路由"而丢掉一批增益，需要重扫 36 样例看 `meanAfter`（预期不降，但未验证）。
6. **区域层（S6）的修复范围我还没读代码**，只从行为侧证明它现在是坏的（`invariant:false`、重复包围盒、跨卡片区域）。`03b_region.js` 的具体成因需要实现时先读一遍再定改法 —— 我在规则设计里把它列为"第 0 步"，在这里列为 S6，是因为 S1–S3 不依赖它。
7. **本方案不处理"语义生成"类诉求**：用户建议里的"增加半透明底色边框""改成循环回路图"属于视觉/语义设计，不是"调整相对位置"，超出本方案边界（规则设计 §6 已逐条标注）。
8. **未验证**：本方案全部结论建立在一个样本上（外加全量 36 样例的零回归判据）。"区域均衡阈值 0.45 / 2.5 / 1.25"与"径向阈值 25% / 0.12"都是设计值，缺少多样本支撑。

---

## 7. 复现与验证命令

```powershell
$env:NODE_PATH=".svgbuild\node_modules"

# 本方案的目标实验（修改前后各跑一次，对比这三个 op 是否被否）
node .svgbuild\palantir_attr.cjs        # 写 .svgbuild/attr.json

# 零回归判据（必须用独立 worktree 取基线）
node tests\sweep_rule.cjs > .svgbuild\sweep_after.json
node .svgbuild\cmp_sweep.cjs .svgbuild\baseline_h0.json .svgbuild\sweep_after.json

# 构建自检（S2 之后段数应为 16）
python build.py --check
python build.py --verify

# 其他既有回归
node tests\smoke_svgb.cjs ; node tests\edit_e2e.cjs ; node tests\edit_cancel.cjs
node tests\contain_audit.cjs real-01 ; node tests\validate_occlusion.cjs real-01
```

> 判据提醒：这些测试**即使失败也返回退出码 0**，必须解析输出；
> 本机 PowerShell 的 `>` / `*>` 写 **UTF-16LE**（`.svgbuild/cmp_sweep.cjs`、`.svgbuild/fails.cjs` 已按 BOM 嗅探处理）。
