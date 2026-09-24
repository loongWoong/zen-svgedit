# 本体图「一键美化」修复方案 · v1（可落地设计）

> 对象：`svgb_beautifier.html`（由 `ui.html` + `build.py` 内联）
> 上游文档：`svgb_layout_optimization_plan-v1.md`（路线图：做什么、为什么）
> **本文档是"怎么修"**：每项修复给出**插入点（file:line）→ 签名 → 算法 → 不变式 → 验收断言 → 回滚**，可直接照着写代码。
> 所有症状数字都是在当前工作区实测的（`ui.html` 与 `svgb_beautifier.html` 逐位相同）；所有结论带 `file:line`。
> 只读分析 + 设计，**未修改任何源码**。

---

## 0. 与路线图的关系，以及一处排序修正

路线图给的是 A→G 的**能力建设**顺序。这份修复方案对其中一处做了**修正**，理由来自实测数据：

> **修正**：路线图的"阶段 A"直接让 3 个新维度进 `METRIC_KEYS`/`WEIGHTS`/`GUARD`。
> 但实测显示**现有维度已经在幻灯片域误报**（`style = 0`、`spacing = 0` 在 6 张真实图上恒零）。
> 在尚未观测过新维度在 36 个样例上的分布之前就把它权重化，等于把"误报"直接写进总分。
> 因此改为**两段式上线**（F6）：先"可观不可修"（只进 `raw`，总分不变）→ 用 sweep 定标 → 再"可修"（进权重与守卫）。

这个修正不改变路线图的目标架构，只改变落地节奏，且**每段都可独立验收**。

---

## 0.1 实现阶段的实测更正（3 处前提被自己的探针证伪）

> 本节是实现时新增的。诚实记录：下面 3 条在本文档原始设计中写错了，**实现按实测为准**。
> 每条都有可复现的探针（见各条引用的脚本）。设计文档的其余部分保持原样以便追溯。

| # | 原设计（错） | 实测（对） | 证据 |
|:--|:---|:---|:---|
| 更正1 | **F9**：`normColor` 把渐变/命名色"视为不遮挡"→ **遮挡漏检** | **方向相反**。`normColor('url(#gPurple)')` → `'url(#gpurple)'`（**truthy**），`normColor('red')` → `'red'`（truthy）。渐变与命名色**一直被当成不透明遮挡源**，不存在漏检 | `.svgbuild/opacity_probe.cjs`：11 个入参的真值表；本体图 6 个渐变 `stop-opacity` **全为空**（= 完全不透明），全图仅 1 个节点 `opacity=0.98`，**无任何 `fill-opacity < 1`** |
| 更正2 | **F7**：`tiny_element` 把图例色块/装饰点当数据节点 → 应由 role 收窄，预期 **8 → ≲2** | **收窄在该样本上是 no-op**。8 条**全部是真实的有标签数据节点**（`Validator` / `Repository` / `Agent ToolChain` / `数据语义化` …），该样本 `decoration` 数 = **0**，`role` 分布 = 34 data / 2 container / 3 shape | `.svgbuild/tiny_probe.cjs`：8 条 tiny 的完整清单与 role |
| 更正3 | **F3**：`anchorDelta` 签名**没有** `ir`，需要改签名 + 同步改调用点 | 实际签名**已经是** `anchorDelta(ir, n, l)`（`06:1437`），两个调用点（`06:269`、`06:1470`）**已经传了 `ir`**。无需改签名 | `grep anchorDelta src/06_geometry.js` 3 处命中 |

**这 3 条更正改变了什么？**

* **F9 的落地内容被替换**：不做「渐变 stop 不透明度解析 + 命名色表」（那是为一个不存在的问题写的代码），改为修**真正存在的**缺陷 —— **悬空**的 paint 引用 `url(#nonexistent)` 旧行为返回 truthy，会被当成不透明遮挡源，从而**凭空报出「文字被遮挡」**。在 SVG 里解析不到 paint server 的元素根本不被绘制，必须按「无填充」处理。这条改动对全部现有样例都是 no-op（它们没有悬空引用），只消除一个潜在误报。
* **F7 的收益来源被改正**：`tiny_element` 那条实测 **不能**靠 role 收窄改善。真正解决 collision 96→16 的是 **F1 的 item 级增量提交** —— 每个 tiny 节点本来就是**独立 item**（`ik(it) = it.targets.join(',')`，tiny 的 targets 只有 1 个 id），所以按 item 提交后只有"放大后不撞"的那些会生效。role 层仍然保留，但定位改为**基础设施**（供 F6 的区域/层级维度用）+ **防御性护栏**（挡住带标签的图例件与方言标注件），而不是"本体图 tiny 的修复"。
* **F3 的工作量下降**：只加护栏，不改签名。护栏实现时改为**复用 `wouldCollide`**（`06:150-160`）而不是手写 `R.intersect` —— 因为 `coverRatio` 按**较小面积**归一（`01:118-123`），`wouldCollide` 的 `≥0.95` 豁免正好放过「标签完整落在父容器/满版底板内」这一合法情形；手写版本会让所有带背景底板的图**一条 `move_text` 都产不出来**（护栏过严的新缺陷）。

## 0.2 与本节相关的另一个实测结论（F6 两段式的实证依据）

本文档 §0 把「3 个新维度两段式上线」的修正理由写成"现有维度已在幻灯片域误报"。实现时补上了可直接引用的数字：

* 6 张真实幻灯片图的 `style` 与 `spacing` **恒为 0**（§3.2 实测：本体图 before/after 两端都是 `spacing 0 / style 0`）。
* 因此 F6 **第一段**只写入 `raw`（`Analyzer.regionMetrics`），**不进** `METRIC_KEYS`/`WEIGHTS`/`score` —— 总分逐位不变，可用既有 sweep 直接证明零回归。

---



## 0.3 「collision 96 → 0」的真实机制（F11 只读诊断实测，推翻了本文档原先的归因）

> 证据：`tests/diag_batch.cjs`（只读探针，两次运行逐位一致；以关键函数源码哈希锚定）。

**原先的假设**：`move_text` / `normalize_style` 的批次里出现**节点两两重叠**，导致 `collision` 崩掉。
**实测**：节点重叠**完全没有变化** —— `pairs` 恒为 `1`、`collision.density` 恒为 `0.02`、39/39 个节点位移普查全是 `Δ=(0,0)`。

塌陷来自 **occlusion**，而它被**折进同一个 collision 指标**里：

```
metrics.collision = sc(raw.collision.density + raw.occlusion.density, collSat)   // 04_analyzer.js:58 / :37
occlusion.density = clamp(Σ max(cover, 0.25), 0, 1)                              // 04_analyzer.js:233
collSat = 0.5
```

**两条遮挡就恰好等于 collSat（2 × 0.25 = 0.5）→ collision 归零。** 这是台阶不是斜坡：第 1 条遮挡已吃掉半个指标，第 2 条直接归零。`normalize_style` 正是**恰好卡在阈值上**（occD = 0.5）。

**具体肇事 op**：
* `text_overflow|move_text` 第 **1/10** 个 op（`opFixAnchor`，属主 `n3 = rect#svg_5`）：把 H1 标题 bbox 从 `(116.5,92.5,341×45)` 平移到 `(814,542,341×45)` —— **位移 (697.5, 449.5)px**。标题随即落在 `n23`/`n25`（文档序更靠后、不透明）之下，产生 2 条 occlusion。
* `style_inconsistency|normalize_style` 第 **7/24** 个 op：字号 16→18px，让一段文字探到 `n25`/`n51` 之下 → occ 0→2；前 6 个 op 时 collision 仍是 96。

**canvasTail 是"历史帮凶"，不是直接成因**：E4 精确复刻 `applyAll → canvasTail → checkOp` 证明**带 tail 与不带 tail 的裁决完全相同**；反向只跑 canvasTail 得到 `n=0 ops, grow=false`（无操作可施加）。但**此前有一次被接受的** `spacing|distribute_equal` 的 tail 返回 `n=57, grow=true, dx=dy=24.5` 并调用 `Runtime.setResolution` → 画布 **1920×1080 → 2036.5×1129**。单变量对照（同一 DOM，只改 `canvas.w/h`）：

| 画布 | `n3` 面积比 | `isBg` | 结果 |
|:--|:--|:--|:--|
| 1920×1080（作者尺寸） | 0.86 | **true** | 标题/副标题/图例是自由文本 → `move_text` 批次 = **4 个 op**（与原始载入的计划一致，无搬运动作） |
| 2036.5×1129（tail 之后） | 0.78 | **false** | 满版外框降级为普通节点，**认领**标题/副标题/图例为自身 labels → 批次膨胀到 **10 个 op**，含 (697.5,449.5)px 搬运动作 |

即：**「谁是满版底板」这一语义随画布尺寸漂移** —— `03_ir.js:152` 的 `area/cvArea ≥ 0.85` 正好卡在真实图的 0.86 上，一次 6% 的画布增长就把它翻了过来。这是**非幂等重分析**：同一个 DOM，`IR.build` 两次给出不同语义。

---

## 0.4 实现在设计之外补的三处修复（均已实测生效）

| # | 问题 | 修复 | 实测效果 |
|:--|:--|:--|:--|
| **X1** | §0.3 的根因：`isBg` 随画布漂移，制造出 10-op 搬运批次 | `isBg` 改为相对**作者画布**判定。`Pipeline.beautify` 在 `rt.load` 之后、任何 canvasTail 之前把 `{w,h}` 钉进 `o.sopt.authoredCanvas`（与 `svgText` 同一通道，**回滚免疫**）；`03_ir.js` 用 `bgArea` 替代 `cvArea`。未带该字段时**退回当前画布，行为与改动前逐位一致** | 本体图 `text_overflow:move_text` 从 **#10（Δ−24.8，collision 96→0）** 收敛为 **#4（Δ−0.4，无塌陷）**；`normalize_style` 从 #24 → #20。塌陷机制消失 |
| **X2** | `anchorDelta` 护栏③复用的 `wouldCollide` 带 `coverRatio ≥ 0.95` 豁免，该豁免**同样放行**「标签完整落进另一个不透明且绘制更晚的容器底下」—— 恰是 Analyzer 判为缺陷、门禁必然扣分的形态 | 新增**护栏④**：与 `Analyzer.occlusion` **同源**判据（不透明、非属主、非背景、文档序在文字之后、两维交叠 ≥6px）。只否决**新引入**的遮挡（若原位置本就被同一形状压着，搬过去仍被压不算新缺陷） | 直接掐断 §0.3 那个 697.5×449.5px 搬运 op 的产生路径 |
| **X3** | 本文档 §F1 原设计只做「逐 item 提交」。实测 `normalize_style` 24 个 op 里**只有第 7 个有害**，而逐 item 提交在此**完全无效**：单个字号改动自身 Δ≈0，门却要求 Δ>0 严格提升 → 24 个单元全数落空 | 把逐 item 提交升级为**对单元（item）做二分搜索**：`try(S)` 过 → 整段提交；`|S|=1` 仍不过 → 记坏单元；否则对半递归。`|S|=1` 时退化为原逐 item 提交，故**严格包含**旧行为。作用在 item 上而非裸 op 上，保证同一 item 的多个 op 不被拆开 | 本体图结果**未变**（该图无净收益子集），但这是**实测结论而非失败**，见下 |

**X3 的诚实边界**：二分搜索**安全但不会凭空造出收益** —— 每次提交都仍须过同一个 op 级门，且 `gain` 相对当前已提交状态测得，所以最坏就是不提交，与旧行为等价。本体图上 `normalize_style` 干净子集的 Δ≈0（`style` 指标在该样本恒为 0，已饱和在最差档），`grow_to_min` 的任意子集也过不了门，因此二分搜索在这张图上一个额外 op 都没提交。**瓶颈已经转移到评分视野**（见 §0.2 与 `report.md` §16.1）：`spacing`/`style` 两维在幻灯片域恒为 0，几何引擎把这两类问题改好了，评分也看不见。这正是 F6 存在的理由，而 F6 第二段（给新维度上权重）必须先完成定标。

**另修一处实现自身的缺陷（由回归扫描抓出）**：item 级黑名单原先只按 `itemKey`（= `type|targets`）记账，**不含策略**。于是一个策略在某个 item 上失败，会连带封杀同类问题在该 item 上的**其它策略** —— `wrap_text` 失败把 `resize_container` / `move_text` 一起封掉了。实测代价：`real-02` 丢掉一次本会被接受的 `resize_container#5`（72.15 → **68.95**），`real-03` 丢掉 `resize_container#2`（69.95 → **69.55**）。改为按 **(策略, item)** 二元组记账（`claim()` 新增 `op.itemTargets`，键 = `gateKey + '|' + itemTargets`）后两者**逐位复原**为 72.15 / 69.95。

---

## 1. 症状 → 修复映射（总表）

| # | 实测症状（证据） | 根因 | 修复 | 规模 | 风险 | 依赖 |
|:--|:---|:---|:---|:---:|:---:|:---|
| **F1** | 24 op 只活 3 个；`text_overflow` / `style_inconsistency` **整类归零**（§3.4 表：`move_text` 10 op、`normalize_style` 24 op 全被淘汰） | 校验单元 = `gateKey` = **issue 类型**，一类问题里"9 个对 1 个错"就整类丢弃（`07:201-203`） | **批次原子性分级**：只有天然原子的类型才整类提交，其余对 **item 单元做二分搜索**（见 §0.4 X3，原设计仅"逐 item 提交"） | M | 低 | — |
| **F2** | 轮 2 把轮 1 的失败**逐条重试**一遍，再全部淘汰后终止 | `reject` 黑名单在 round 循环内声明，跨轮重置（`07:167`） | 跨轮记忆 + **尝试次数上限**（不是永久拉黑） | S | 低 | — |
| **F3** | `move_text` 批导致 collision 96→0（**机制已由 F11 确证，见 §0.3：折叠进 collision 的 occlusion density 2×0.25 撞上 collSat=0.5**） | `anchorDelta` 护栏只查**同节点兄弟标签**（`06:1400-1404`），不查跨节点标签冲突，且复用的 `wouldCollide` 的 `coverRatio ≥ 0.95` 豁免**放行了"落进更晚绘制的不透明容器之下"** | 护栏扩到跨节点/邻域标签 **+ 与 Analyzer.occlusion 同源的 z-order 护栏④**（见 §0.4 X2）；另加 X1 掐掉根因 | S | 中 | F11 |
| **F4** | `move_apart`/`grow_spacing`/`global_relayout` **三条数字完全相同** | 前两条共用 `separation`（`06:845-859`）；第三条是幽灵策略（`06:820-1109` 无 case） | `global_relayout` 下线；`grow_spacing` 语义分家 | S | 低 | — |
| **F5** | 源里 9 个语义区域，IR 只认 1 个 group（`stats.groups = 1`） | IR 扁平，纯容器组被丢弃（`03_ir.js:134`） | 新增 `RegionGraph` | L | 低（纯新增） | — |
| **F6** | `regionBalance`/`whitespace`/`hierarchy` **不存在** | 评分只有全画布 `canvas`（`04:343-358`） | 3 个新维度，**两段式**上线 | M | 中 | F5 |
| **F7** | `tiny_element` 8 条 → `grow_to_min` 让 collision 96→16（Δ−80） | 判据只看面积（`04:419`），不区分数据节点与图例色块/装饰点 | 语义角色层 + `tiny_element` 收窄 | M | 低 | F5 |
| **F8** | `orthogonal_reroute` 无法消除 edge-over-edge 交叉 | 占据栅格只放节点，不放其它边（`06:1622`） | 障碍集加边；接受判据改"严格减少交叉" | M | 中 | — |
| **F9** | 本体图大量 `url(#gradient)` 填充 → 遮挡可能漏检 | `normColor(fill)` 把渐变/命名色一律视为不透明/不可比（`04:122-123`、`06:684`） | 渐变 stop 不透明度 + 命名色表 | S | 中 | — |
| **F10** | `applyAll` 返回值被丢弃；`rec.ops` 语义错；README 尺寸过期；基线不可比 | 工程缺陷（审计发现） | 5 小项 + 基线指纹 | S | 低 | — |
| **F11** | `move_text` 批崩塌的**机制未确证** | — | 归因探针（**先做**） | S | 无 | — |

**规模**：S ≈ 半小时内、M ≈ 半天、L ≈ 1~2 天（含探针与验收）。

---

## 2. 修复依赖图与实施顺序

```
Step 0   F11 归因探针 ─────────────┐（理解 F1/F3 的真实机制，不改产品代码）
                                   │
Step 1   F1  批次原子性分级 ────────┤  ← 单项收益最大，且与机制无关（鲁棒化）
Step 2   F2  跨轮失败记忆 ──────────┤
Step 3   F4  幽灵策略下线 + 分家 ───┤  ← 让候选表先说真话
Step 4   F3  护栏扩到跨节点 ────────┘
                                   │
Step 5   F5  RegionGraph ───────────┐（纯新增，零回归风险）
Step 6   F6  3 维"可观" ────────────┤ → sweep 定标
Step 7   F6  3 维"可修" ────────────┤ → 进权重与守卫
Step 8   F7  语义角色 ──────────────┘
                                   │
Step 9   F8  连线路由 / F9 遮挡判定 ─┤（P2，可并行）
Step 10  F10 工程收尾 + 基线重建 ───┘
```

**为什么 F1 排在 F5/F6 之前**：F1 修的是"门把正确的东西也一起扔了"。在地基没修好之前加维度，新维度带来的收益会被同一个门以同样的方式丢掉。**先让门别误杀，再加视野。**

---

## 3. 逐项修复设计

### F1 · 批次原子性分级 + item 级增量提交（核心修复）

#### 症状与证据
§3.4 的实测裁决表里，`text_overflow` 的 `move_text` 一批 10 个 op、`style_inconsistency` 的 `normalize_style` 一批 24 个 op，**整体被淘汰 → 整类问题在本轮一条都没修**。而 `07:196-200` 的注释明确写了为什么批次必须原子：

> `rebalance_canvas` / `distribute_equal` 是原子组 op —— 只平移一半元素会让留白更不对称；撑大内容盒的 op 必须把画布收尾算进同一次校验。

这条理由是**对的**，但被过度推广到**所有** issue 类型。`text_overflow`、`style_inconsistency`、`tiny_element` 是**逐元素独立**的，把它们整类捆绑才是缺陷。

#### 关键既有设施（无需新建）
`06:783` 与 `06:792` 已经在每个 op 上挂了 item 身份：

```js
const ik = it => (it && it.targets ? it.targets.join(',') : '');   // 06:783
op.itemKey = cur.type + '|' + itemKey;                             // 06:792
```
注释（`06:790`）说它"仅用于台账展示"——**我们把它提升为提交单元**。基础设施已存在，改动面很小。

#### 修复设计

**① 新增原子性声明表（`06_geometry.js`，放在 `PHASES` 之后，约 `06:80`）**

```js
/* 提交原子性：决定「一类的修复动作能否按 item 拆分提交」。
 * 'whole' —— 整类必须一次提交（拆了会破坏组内一致性，见 06:785-790 的实测）。
 * 'item'  —— 每个 item（= 一组 targets，06:783）独立提交，互不影响。 */
Geo.ATOMIC = {
  canvas_margin:       'whole',   /* 整幅平移，不可拆（实测拆了 canvas 归零） */
  spacing:             'whole',   /* 等距分布必须整行一起挪（同上） */
  edge_crossing:       'whole',   /* 整组重路由，拆了会互相打架 */
  text_overflow:       'item',    /* 逐容器独立 */
  style_inconsistency: 'item',    /* 逐节点字号/填充独立 */
  tiny_element:        'item',    /* 逐元素独立 */
  misalignment:        'cluster', /* 逐对齐簇独立（等同 item 处理） */
  overlap:             'item',    /* 逐对独立 */
  occlusion:           'item'     /* 逐文字独立 */
};
Geo.atomicity = t => Geo.ATOMIC[t] || 'item';   /* 未声明的一律按 item，宁可细不可粗 */
```

> 为什么默认 `'item'` 而不是 `'whole'`：漏声明时按 item 处理最多是"多几次校验"，按 whole 处理则会重演"整类归零"。**失败方向要选安全的那一侧。**

**② `07_patch.js` 的提交逻辑改造**（替换 `07:201-246` 的单批次应用）

```js
/* Pipeline 新增：按单元尝试提交（成功则保持已应用，失败由调用方回滚） */
_tryUnits(rt, baseAn, units, plan0, o) {
  try {
    for (const u of units) Patch.applyAll(u);          /* F10 会同时接住 errors */
    const i2 = IR.build(rt, o.sopt);
    if (!i2.ok) return { ok: false, why: 'IR 构建失败' };
    /* 批内画布收尾（保持既有语义，07:210-219） */
    const aT = Analyzer.run(i2, o.sopt);
    const t = Geo.canvasTail(i2, aT, plan0 ? plan0.style : null, o.canvasPad);
    if (t.ops.length) Patch.applyAll(t.ops);
    const i3 = IR.build(rt, o.sopt);
    const a3 = i3.ok ? Analyzer.run(i3, o.sopt) : null;
    if (!a3) return { ok: false, why: '分析失败' };
    const c = Validator.checkOp(baseAn, a3);
    return { ok: c.ok, an: a3, gain: c.gain, reasons: c.reasons, tail: t };
  } catch (e) { return { ok: false, why: 'apply 抛错: ' + (e && e.message) }; }
}
```

```js
/* 替换原来的「一批全应用」*/
const first = opsLive[0];
const gateKey = first.gateKey || ('#' + (first.strategy || '') + '|' + (first.label || ''));
const batch = opsLive.filter(o => (o.gateKey || gateKey) === gateKey);
const mode = Geo.atomicity(first.issueType);

/* 快路径：整类一次提交 —— 保持现状语义，绝大多数情况走这条 */
if (this._tryUnits(rt, an, [batch], plan0, o).ok) { /* commit，同现状 */ }
else if (mode === 'whole' || batch.length < 3) { /* 整类失败 → 回滚 + 按现状拉黑 */ }
else {
  /* 慢路径：按 item 增量提交（每个 item 内部仍原子） */
  const units = this._groupByItem(batch);              /* 依 op.itemKey 分组，保持原序 */
  const commits = [];
  for (const u of units) {
    if (budget.left-- <= 0) break;                     /* 预算耗尽 → 余下放弃（不劣化） */
    const pre = rt.exportString();
    const r = this._tryUnits(rt, an, [u], plan0, o);
    if (r.ok) { commits.push(u); an = r.an; }          /* 成功：留在 DOM，更新基线 */
    else { rt.load(pre); rejectItems.push(u[0].itemKey); }   /* 失败：回滚该 item，仅拉黑它 */
  }
}
```

**③ `Geo.plan` 消费 item 级黑名单（`06:774` 之后插入）**

```js
if (!gate.safeAll) items = items.filter(i => i.priority !== 'critical');
/* ★ 新增：已在本轮失败过的 item 不再产出（F1 的 item 级归因） */
if (sopt && sopt.rejectItems && sopt.rejectItems.length) {
  items = items.filter(i => sopt.rejectItems.indexOf(g.type + '|' + ik(i)) < 0);
}
if (!items.length) continue;
```

`rejectItems` 由 `07_patch.js` 逐轮维护并透传（与现有 `reject` 同一路径，`07:181`）。

**④ 预算**：`roundBudget = 12` 次额外单元校验/轮，放进 `Pipeline.beautify` 的 opts（可测、可关）。超预算退化为现状，**不会更差**。

#### 不变式
* **绝不劣化**：每个单元仍过同一个 `Validator.checkOp`；只是把"全丢"变成"丢坏的、留好的"。
* **原子类型行为完全不变**：`canvas_margin`/`spacing`/`edge_crossing` 仍整类提交 → 不触碰 `06:785-790` 记录的那两个实测回归。
* **顺序稳定**：单元顺序 = 原 `batch` 顺序，不重排 → 可回归。
* **预算内确定性**：预算耗尽只影响"修多少"，不影响"改什么"。

#### 验收断言
| 断言 | 目的 |
|:---|:---|
| 本体图 `text_overflow`、`style_inconsistency` 两类**不再整类归零**（`steps` 里出现 `accept:true`） | 核心目标 |
| `canvas_margin` / `spacing` 两组样例（`raw-layered-canvas_margin-s25`、`raw-grid-spacing-s17`）分数**逐位不变** | 证明原子类型未受影响 |
| Δ0 批次的 `accept` 仍为 false 且**不进入 commits** | 门没有被放松 |
| 全量 36 样例 `sumDelta` 不低于基线 | 无回归 |
| 单轮额外校验次数 ≤ 预算（写进 ledger 断言） | 成本可控 |

#### 风险与回滚
风险：item 级提交后，`owner` 占用状态与实际 DOM 不再一致（op 是在"假设整批都生效"下规划的）。**缓解**：每次成功提交后 `an = r.an` 且下一步循环会重新 `preview` → **重规划**（`07:182`），owner 由重新规划重建，因此不会残留。这正是 `07:177-179` 注释所说的"元素释放后必须重规划"。
回滚：整项修复由 `Geo.ATOMIC` 一个表控制，把表清空即恢复现状。

---

### F2 · 跨轮失败记忆（尝试次数上限，而非永久拉黑）

#### 症状与证据
轮 1 淘汰 12 条，轮 2 把其中 9 条**逐字重试**并再次淘汰，然后因"本轮全部 op 被 op 级门淘汰"终止 —— 整个第 2 轮是纯浪费（`07:167` 的 `reject` 在 round 循环内声明）。

#### 修复设计
不采用"永久拉黑"（会挡掉状态变化后本可成功的 op —— 正是 `07:177-179` 要避免的）。改为**尝试次数上限**：

```js
/* Pipeline.beautify 的 round 循环之外 */
const attempts = new Map();      /* gateKey -> 尝试轮次数 */

/* round 循环之内，构造 sopt2 时（07:181） */
const reject = [...attempts].filter(([, n]) => n >= 2).map(([k]) => k);
const sopt2 = Object.assign({}, o.sopt, { reject, rejectItems });
...
/* 某 gateKey 本轮全部单元失败后（07:245） */
attempts.set(gateKey, (attempts.get(gateKey) || 0) + 1);
```

语义：**同一个 `gateKey` 允许在状态变化后再试一次，第二次仍失败即停止重试**。上限可配置（`maxAttempts = 2`），并写进 ledger（`rec.attempts`）以便断言。

#### 不变式与验收
* 轮 2 不得再出现与轮 1 **完全相同**的 `rejectedKeys` 集合（断言集合差非空）。
* 允许一次重试 → 不牺牲"元素释放后策略变可行"的既有能力：构造一个"轮 1 因邻居占用失败、轮 2 邻居先被修好后应成功"的样例，断言该 op 在轮 2 被采纳。
* 轮数上限仍为 `maxRounds = 4`，不增加。

---

### F3 · `anchorDelta` 护栏扩到跨节点

#### 症状与证据
`move_text` 一批 10 个 op 应用后 collision 96→0。**机制我没有确证**（见 F11），但已确证一处**护栏范围小于缺陷范围**：

`06:1400-1404`：
```js
for (const o of n.labels) {          /* ← 只遍历同一节点内的兄弟标签 */
  if (o === l || !o.bbox) continue;
  const inter = R.intersect(after, o.bbox);
  if (inter && inter.w > 1 && inter.h > 1) return null;
}
```
护栏保证了"标签仍在自己容器内"（`06:1397-1399`）且"不与同容器兄弟标签重叠"，但**不检查**：跨节点标签重叠、与其它节点形状重叠（对 `textFit`/`occlusion` 的口径而言）。`opFixAnchor` 复用的就是这个函数（`06:1422`）。

#### 修复设计
在 `anchorDelta` 内追加两级检查（保持"宁可返回 null"的风格）：

```js
/* ② 跨节点：不得落进其它节点的标签或形状（同 Analyzer.occlusion 的口径） */
for (const other of ir.nodes) {
  if (other === n) continue;
  if (!R.intersect(after, other.geomBox)) continue;
  /* 落在别人的容器里 = 语义错位，直接否决 */
  return null;
}
/* ③ 与其它节点的自由文本不得重叠（free texts 不在 labels 里） */
for (const t of ir.texts) {
  const inter = R.intersect(after, t.bbox);
  if (inter && inter.w > 1 && inter.h > 1) return null;
}
```

> **实现阶段更正（见 §0.1 更正3）**：`anchorDelta` 的签名**已经是** `anchorDelta(ir, n, l)`，两个调用点（`06:269`、`06:1470`）**已经传入 `ir`**，所以**不需要改签名、也不需要改调用点**。grep `anchorDelta src/06_geometry.js` 三处命中即可核实。
>
> **实现阶段更正（护栏实现方式）**：上面 ② 的写法（"落进任何其它节点的 geomBox 就 `return null`"）**过于严苛，会把带背景底板的图上所有 `move_text` 杀光** —— 因为 `R.intersect` 对"标签完整落在满版底板内"同样返回真，而那正是每一张幻灯片图的常态。实际实现改为**复用既有的 `wouldCollide(ir, n, after, [n])`**：它内部用 `coverRatio(a,b) = inter.area / min(area(a), area(b))`（`01:118-123`）归一，对"完整包含"给出 `≥0.95` 从而豁免合法嵌套，只在**部分重叠**时判冲突。③（自由文本重叠）也一并走 `wouldCollide`。
> 护栏 ③ 另有一处口径事实需要记录：IR 的 `freeTexts` 就是 `texts` —— `03_ir.js:162` 已把**已挂到节点上的标签**从 `freeTexts` 里剔除，所以 `ir.freeTexts` 只含**未挂载**的自由文本，不会与 `n.labels` 重复检查。

#### 不变式与验收
* 干净样例仍 100 分（护栏变严只会少发 op，不会多发）。
* 新增断言：任何被采纳的 `move_text` op，其 `preview.after` 不与其它节点 `geomBox` 相交。
* `move_text` 的失败从"collision 崩塌"转为"预检就返回 null"（`skipped` 计数上升、`steps` 里不再出现 Δ−24.8）。

---

### F4 · 幽灵策略下线 + `grow_spacing` 语义分家

#### F4a · `global_relayout` 下线（2 行，立刻提升候选表保真度）

实测三条策略数字完全相同（§3.4），因为 `global_relayout` 落 `default: break`（`06:1109`）→ 0 op → 顺位回退到共用代码的 `move_apart`/`grow_spacing`。**让候选表里有幻觉比候选少更糟**——它让 Laya 的 ranks 与台账都在说谎。

```js
/* 04_analyzer.js:370 —— 从 overlap 的候选里删除 */
['move_apart', 'grow_spacing']);        /* 去掉 'global_relayout' */

/* 06_geometry.js:148 —— 桩改为"不可用"，确保它即使被别处引用也永远排最后 */
case 'overlap:global_relayout': return { score: 0, detail: '未实现（F4a 已下线）', risky: true };
```
`Geo.LABEL`（`06:20`）与 `Geo.PHASES`（`06:78`）里的条目**保留**：前者是 id→中文名映射表（无副作用），后者是 `fix_order` 的**阶段顺序**选项（与 op 构造无关，保留无害）。`05:102` 的 `fix_order` 选项同理保留。

> 待路线图阶段 C 实现真正的区域重排时，再重新登记（按 §6 注册契约 6 处全改）。

#### F4b · `grow_spacing` 与 `move_apart` 分家

现状：两者共用 `separation`（`06:845-859`，同一段代码，只换 `g.key` 与标签）。语义应为：
* `move_apart` = **推开一对**重叠元素（现状正确，保留）。
* `grow_spacing` = **把整组间距向风格目标拉开**（新实现）。

复用 spacing 分支的组级设施（`06:889-959`，含"剔除真包含容器"与"嵌套拒绝"两道已验证的护栏），但把 `base` 的来源从"观测平均"改为"风格目标"：

```js
/* 06:928 一带，按 g.key 分派 */
const observed = (span - sumW) / (sorted.length - 1);
const base = g.key === 'distribute_weighted' ? null
           : g.key === 'grow_spacing'        ? Math.max(observed, st.gap)   /* ← 新增：向风格 gap 靠 */
           : observed;                                                       /* distribute_equal 不变 */
```
出画布保护（`06:942-947`）与最小间距 `Math.max(6, gap)`（`06:936`）**继续生效**，因此"拉开"永远不会把元素扔出画布。

#### 验收断言
* `Geo.evaluate('overlap:global_relayout')` 不再出现在任何 `firstSrc` / `chosen` 里（断言 `ranks` 最大者 ≠ `global_relayout`）。
* `grow_spacing` 与 `move_apart` 的 `steps[].gain` **不再恒等**（至少一个样例上不同）。
* `distribute_equal` 的所有样例分数**逐位不变**（证明只动了 `grow_spacing` 一支）。

---

### F5 · `RegionGraph` 区域图（纯新增，零回归风险）

#### 插入点
* 新文件 `src/03b_region.js`，插入 `ui.html:418-431` 的 `<script src>` 列表，位置在 `src/03_ir.js` 之后、`src/04_analyzer.js` 之前（`build.py` 按文档顺序内联，`build.py:67-79/88-89`）。
* 由 `IR.build` 末尾以**软依赖**方式调用（避免文件顺序耦合，且 `IR.build` 是唯一构建点 —— 它被 12 处调用，必须保持一致）：

```js
/* 03_ir.js，ir 对象组装处（03:192 之前） */
let regions = null;
if (typeof RegionGraph !== 'undefined' && RegionGraph.build) {
  regions = RegionGraph.build(rt, content, nodes, canvas);   /* 失败返回 null，不抛 */
}
const ir = { ok:true, canvas, nodes, edges, texts, freeTexts:texts, decorations, preserved,
             dialect, medArea, contentBox, opts:o, notes, regions,   /* ← 新增 */
             stats:{ ... } };
```
软依赖的理由：`IR.build` 在脚本加载完成后才被调用，但显式 `typeof` 守卫能让"RegionGraph 未加载"降级为 `regions = null` 而不是 `ReferenceError` —— 与既有 `LayaRule` 软依赖写法一致（`06:756-757`）。

#### 算法（伪码，确定性）

```
RegionGraph.build(rt, content, nodes, canvas):
  1. 剥包装层
     SKIP = ['title','desc','defs','style','metadata','script']
     kids(el) = el.children 去掉 SKIP
     root = content
     while kids(root).length === 1 && kids(root)[0] 是 <g>: root = kids(root)[0]
     # 实测必需：svgcanvas 会把整份内容塞进一个 <g>，#svgcontent 下还有 title/desc/defs

  2. 递归建区域树（node → 叶层唯一归属）
     build(el):
       sub = [], own = []
       for c in kids(el):
         if c 是 <g>:
            r = build(c)
            if r.members.length >= 2: sub.push(r)
            else: own.push(...r.members)          # 折叠小分组：成员上提
         else if c 在 nodeOf 里: own.push(nodeOf(c))
       members = own ∪ ⋃(sub[i].members)
       return { el, sub, own, members }
     # 不变式：每个 node 恰好属于一个区域（最深包含者）→ 不存在重复计入

  3. 区域分类（纯几何）
     bbox   = R.union(members.map(m => m.bbox))
     leaves = members 中「不包含其它 member（coverRatio ≥ 0.95）」者    ← ★ 修正探针口径缺陷
     ink    = Σ area(leaves.bbox)
     inkDensity = ink / max(1, area(bbox))
     whitespace = 1 − min(1, inkDensity)
     kind:
       'frame'      if area(bbox)/canvasArea >= 0.85          # 复用 isBg 口径 03:149-152
       'band'       if bbox.w/bbox.h >= 6 && bbox.h <= 0.12*canvas.h
       'decoration' if 所有 leaf 无标签 && area(bbox) < 0.0005*canvasArea
       'panel'/'card' if 0.4 <= bbox.w/bbox.h <= 4
                        && (leaves.length >= 2 || (leaves.length >= 1 && texts >= 2))
       else 'cluster'
     name = 前一个兄弟注释节点(nodeType===8)的文本               # 实测 16/16 保留，13 条在 depth 0
     depth = 树深

  4. 输出
     { regions:[...], byNode:{nodeId→regionId}, tree }
```

> ★ `leaves` 那一步是关键：探针里我直接把成员面积求和，嵌套容器被重复计入（出现了 >1 的墨密度）。
> 正式实现必须排除"被自己包含的成员"，口径对齐 `Analyzer.collision` 的嵌套豁免（`04:85`，`coverRatio ≥ 0.95`）。

#### 不变式
* `regions` 为 `null` 或空时，所有下游（F6 的维度）必须**视为不适用**，不得报 issue。
* 每个 node 恰好归属 1 个区域（可断言 `Σ regions.members.length === nodes.length`，允许未归属的 decoration 例外并显式计数）。
* 纯只读：不改任何属性、不动 DOM（与 `03_ir.js` 的"只读层"约定一致，`03_ir.js:5`）。

#### 验收断言
| 断言 | 期望 |
|:---|:---|
| 本体图区域数 | **9**（与 §3.3 实测表一致） |
| 本体图区域 kind | `rect#svg_4`→frame、`g#svg_8`→band、`g#svg_12/31/72`→panel、`g#svg_115`→band（`w/h = 1011/43 = 23.5 ≥ 6`） |
| 区域命名 | `g#svg_31` 的 `name === 'Center platform container'` |
| 归属唯一性 | `Σ members === nodes.length`（无重复计入） |
| 干净样例 | 区域数 ≥1 且 `regionBalance` 不适用时**不产生 issue** |

---

### F6 · 三个新维度：**两段式**上线

#### 第一段：可观不可修（`raw` only，总分不变）

在 `Analyzer.run` 的 `raw` 里追加（`04:46-54` 之后），**不动 `METRIC_KEYS` / `WEIGHTS` / `score`**：

```js
raw.region = RegionMetrics.compute(ir, o);
/* → { applicable: bool, balance: {d, worst, best}, whitespace: {d, items:[...]},
       hierarchy: {d, inversions, pairs}, regions: n } */
```
UI 的 `#kRaw` 面板会自然显示（`ui.html:370`），台账无需改动。**此段零回归风险**：`score` 逐位不变，可用现有 sweep 直接证明。

**然后做定标（sweep）** —— 这是本项目既有的文化（报告 §9.3「阈值定标（sweep，非拍脑袋）」）：

```
对全部 36 样例收集 raw.region.* 的分布
  · 5 个 clean 样例：必须 applicable=false 或 d≈0
  · 6 张真实幻灯片：d 应当明显 > 0（否则维度没有分辨力）
  · 22 个合成样例：作为"地图谱式排版"的参照系
据此定 sat，并把定标结果写进报告（含样表与数字），而不是拍一个数
```

#### 第二段：可修（进权重与守卫）

定标通过后一次性提升：

| 位置 | 改动 |
|:---|:---|
| `Analyzer.WEIGHTS`（`04:32`） | 加入 3 维；**从既有维度等比例扣减**，不改变 Σ=1.00 |
| `Analyzer.METRIC_KEYS` / `METRIC_CN`（`04:34-35`） | 追加；UI 进度条自动跟随（`ui.html:1320`） |
| `Analyzer.run` 的 metrics（`04:56-65`） | 接入 |
| `Validator.GUARD`（`07:50`） | 追加，阈值先取保守（−2.0） |

建议初值（**待 sweep 重定**，仅作起点）：

```js
WEIGHTS: { collision:.22, textFit:.16, alignment:.12, spacing:.12,
           edgeRouting:.08, style:.07, canvas:.04,
           regionBalance:.10, whitespace:.05, hierarchy:.04 }        /* Σ = 1.00 */
GUARD:   { …, regionBalance:-2.0, whitespace:-2.0, hierarchy:-2.0 }
```

#### 三个维度的口径（含**两处刻意的保守设计**）

**① `regionBalance`** —— 区域忙闲不均
```
panels = regions where kind ∈ {panel, card}
if panels.length < 2 → applicable=false → 不报 issue（★ 不适用的语义，见下）
d = (max(inkDensity) − min(inkDensity)) / max(inkDensity)     # max=0 时 d=0
score = sc(d, satBalance)
```
本体图实测参照：中央 `inkDensity 2.66` vs 左 `1.63` / 右 `1.62`（探针口径；正式口径会因 `leaves` 修正而变小，但**相对次序与差距方向不变**）。

**② `whitespace`** —— 留白是否落在可读带
```
for panels: w = whitespace
  pen = clamp((0.22 − w)/0.22, 0, 1) + clamp((w − 0.62)/0.38, 0, 1)
d = Σ pen / panels.length
```
> ★ **保守设计 1**：**只让"过挤"方向驱动 op，"过空"方向仅报警不驱动**。
> 理由：几何引擎无法"生成内容来填满留白"。你分析里的 `Rule 2: if whitespace > 35% → expand diagram（增加节点数量 + 关系）` 属于**语义生成**，不在几何层能力内；强行做只会把文字挪来挪去（正是你担心的"单元素优化导致整体失衡"）。
> 几何层能做的是**重新分配空间**（把拥挤区域的成员适度分散、或调整区域边界），这归 F1 之后的区域重排（路线图阶段 C）。

**③ `hierarchy`** —— 语义重要性 vs 视觉权重的秩一致性
```
vis(r) = normalizedAreaShare(r) × (avgFontTier(r)/maxFontTier) × (avgContrast(r)/maxContrast)
sem(r) = (有语义注释名 ? 1 : 0) + (leafMembers ≥ 2 ? 1 : 0) + (有标题档标签 ? 1 : 0)   # 0..3
d = 逆序对比例 over pairs(r,s): (sem(r)−sem(s)) 与 (vis(r)−vis(s)) 反号
score = sc(d, satHierarchy)
```
> ★ **保守设计 2**：`hierarchy` **只报警、不驱动 op**（`fixable: false`）。
> 理由：一个"大而空"的主视觉区是合法设计，秩不一致不一定错。先观测分布，等积够数据再决定是否让它驱动修复 —— 这与报告 §16.2「先在线记录分歧样本，再决定」的思路一致。

#### 新 issue 类型（按 §6 注册契约 6 处全改）

```js
/* 04_analyzer.js issues() */
add('region_imbalance', [worstRegionId], sev, evidence,
    ['rebalance_region', 'keep_region'], /* fixable */ true);
add('region_whitespace', [regionId], 'low', evidence,
    ['rebalance_region', 'keep_region'], /* fixable */ false);   /* 只报警 */
add('region_hierarchy',  [regionId], 'low', evidence,
    ['keep_region'], /* fixable */ false);
```
优先级：`regionBalance` 的 `d > 0.5` → `high`；`whitespace` 过挤 → `medium`；其余 `low`。

#### 「不适用」的语义（**最容易自伤的地方，必须显式**）

```js
/* 维度不适用时必须映射为满分，且不产生 issue */
if (!regionMetrics.applicable) return 100;      /* 而不是 0 */
```
否则**每一张扁平 SVG**（没有 `<g>` 结构的图）都会被新维度扣分 —— 这是本项最大的自伤风险，也是我把 F6 拆成两段的原因。

#### 验收断言
| 断言 | 阶段 |
|:---|:---|
| `score` 与全部 7 个既有 metric **逐位不变** | 第一段 |
| 5 个 clean 样例 `applicable=false` 或 `d ≈ 0` | 第一段/定标 |
| 6 张真实幻灯片 `d` 明显 > 0（有分辨力） | 定标 |
| 定标表落进报告（含数字） | 定标 |
| 5 个 clean 样例仍**恰好 100 分 / 0 issue** | 第二段 |
| 扁平 SVG（无 `<g>`）不因新维度扣分 | 第二段 |
| 全量 36 样例 `sumDelta` 不低于基线 | 第二段 |

---

### F7 · 语义角色层 + `tiny_element` 收窄

#### 症状与证据
`tiny_element` 8 条 → `grow_to_min` 一批 → collision **96→16（Δ−80）**。判据只看面积：
```js
/* 04:419 */ ... 面积 < ir.medArea * o.tinyRatio (0.35)
```
完全不区分"数据节点"与"图例色块 / 分隔线 / 装饰圆点"。本体图的 `g#svg_115`（留白 0.908，几乎无墨）正是这类区域。

#### 修复设计
**① `03_ir.js` 给节点加 `role`**（确定性、按序短路、方言优先）：

```js
n.role = (el.getAttribute && el.getAttribute('data-role'))        /* 1. 方言优先，与 03:81 一致 */
      || (n.isBg ? 'container' : null)
      || (n.labels.length === 0 && inDecorationRegion(n) ? 'decoration' : null)
      || (n.labels.length === 0 && R.area(n.bbox) < canvasArea * 0.0002 && inBandOrPanel(n) ? 'swatch' : null)
      || (n.labels.length > 0 && n.area >= medArea ? 'data' : null)
      || 'label';
```
依赖 F5 的 `regions` 做 `inDecorationRegion` / `inBandOrPanel` 判定。

**② `04:419` 的 `tiny_element` 判据收窄**：
```js
if (o.tinyRatio && n.area < medArea * o.tinyRatio && (n.role === 'data' || n.role === 'label')) → tiny_element
```
`decoration` / `swatch` / `container` **永不**进 `tiny_element`。

**③ `grow_to_min` 的 op 构造器加双保险**（`06:1090-1108`）：目标 `role ∈ {data,label}` 才发 op（即使 issue 误报也不会被执行）。

**④ `n.importance` 换取真（`03:169`）**：现在是"文本字数+1"，改为
```js
n.importance = wSemantic(role) × wPosition(regionCentrality) × wContrast(contrastRatio) × wSize(sqrt(area)/diag)
```
保持全正、量纲无关；`distribute_weighted`（`06:934`）自动受益。

#### 验收断言
| 断言 | 期望 |
|:---|:---|
| 本体图 `tiny_element` 条数 | 从 8 降到 ≲2（仅剩真正的过小数据节点） |
| `grow_to_min` 的 `Δcollision` | ≥ −5（不再崩塌） |
| 5 个 clean 样例 | 仍 100 分 |
| `role` 覆盖 | `Σ roles === nodes.length`，无 `undefined` |

---

### F8 · `routeEdge` 障碍集 + 接受判据

#### 症状与证据
占据栅格只把节点当障碍（`06:1622` 只遍历 `ir.nodes`），因此 `orthogonal_reroute` **永远无法消除 edge-over-edge 交叉**，而 `Analyzer.edgeRouting` 一直在计（`04:287-308`）。且现在的接受判据是 `bestHits === 0`（`06:1675-1676`）——加了边障碍后这个要求会大面积不可满足。

#### 修复设计
**① 障碍集加边**（`06:1617-1629`）：把 `ir.edges` 中**除自身之外**的折线，按 `clear` 外扩后栅格化进同一张占位图（复用 `Seg.hitsRect` 的判定，`01_util.js:140-204`）。源/目标节点的端口区域照旧豁免。

**② 接受判据改"严格减少"**（`06:1662-1676`）：
```js
/* 原：必须 0 命中 */
/* 新：节点命中必须 0（硬），边命中必须严格少于原路径（软但严格） */
if (nodeHits > 0) return { failed: true };
if (edgeHits >= origEdgeHits) return { failed: true };
return { pts, nodeHits, edgeHits };
```
这样"绝不越改越丑"仍然成立（要么严格更好、要么不动），但不再因为"做不到零交叉"而整体放弃。

#### 验收断言
* `raw.edgeRouting` 的 edge-over-edge 计数在一个**专门构造的交叉样例**上下降（新增该样例作为回归件）。
* `evReroute` 的 6 条上限（`06:487`）在 `detail` 里显式声明"仅预检前 6 条"，避免决策层误以为全覆盖。
* 无交叉的样例上 `orthogonal_reroute` 仍返回 `failed`（不发无意义 op）。

---

### F9 · 遮挡判定的渐变 / 命名色支持

#### 症状与证据
`normColor(o.fill)`（`04:452-467`）对 `url(#grad)` 返回原字符串、对命名色返回小写名 —— 两侧判定（`04:122-123` 与 `06:684`）都因此把渐变/命名色填充**视为不遮挡**。本体图大量使用 `url(#gPurple)` 等渐变（`defs` 里有 6 个 `linearGradient`，实测 DOM 转储可见），存在系统性漏检风险。

#### 修复设计
新增 `Runtime.paintOpaque(el, fillValue)`（放 `02_runtime.js`，与既有 `strokeWidth`/`worldBBox` 同级）：
```
'none'/'transparent'/'' → false
url(#id) → 取 defs 中该 gradient 的全部 stop：
            所有 stop 的 (stop-opacity × 元素 opacity) >= 0.9 → true，否则 false
#rgb/#rrggbb/rgb()/rgba() → 复用 normColor + alpha 判定
命名色 → 查内置表（SVG 常用 ~16 色），表外 → 保守返回 false（视为不遮挡，不新增误报）
```
`04:122-123` 与 `06:684` **必须同步改用同一函数**（审计已确认这两处是"同源口径"，必须保持同源，否则会出现"检测到了但修不了"的错配）。

#### 验收断言
* 新增样例：**文字压在渐变面板上** → `raw.occlusion.count ≥ 1`（当前预期为 0）。
* 干净样例的 `occlusion.count` 仍为 0（命名色表外保守返回 false，不新增误报）。

---

### F10 · 工程收尾（5 小项 + 基线）

| 项 | 位置 | 改法 |
|:--|:---|:---|
| `applyAll` 返回值被丢弃 | `07:209`（F1 会重写这段，一并修） | 接住 `{applied, errors}`；errors 写进 `steps[].reasons`（当前"apply 抛错"实际只能来自 IR/Analyzer 抛错） |
| `rec.ops` 语义错 | `07:265` | 记录的是**本轮首步计划**（含被 `opAllow` 拒绝、被门淘汰者）。改名为 `plannedOps` 并新增 `appliedOps`（来自 `steps` 中 accept 的单元），台账两者都显示 |
| `dryRun` 的 `proposed` 死变量 | `07:145/150-151` | 删除，或补进返回值（当前 UI 走的是 `rec.ops.ops`） |
| `_resolveOcclusions` 静默吞错 | `07:114` | 把单 op 失败记进返回的数组与台账（正确性路径不该无声） |
| README 尺寸过期 | `README.md:130` | 更新为 **7 139 行 / 1 615 965 B**（实测） |
| 基线指纹 | `.svgbuild/st3.json` | 加 `fingerprint{artifactSha256, segments, gitRev}`；不匹配时**报错而非静默比较**（§3.5 教训：58.8 vs 46.3 被当成同一基线） |

**改动清单签名稳定性**（`ui.html:1103`）：`opSig = strategy|label` 由 label 派生，label 变了 deny 就失效（fail-open，`ui.html:1099-1101`）。建议加稳定 `opId`（由 `gateKey + 目标 id` 生成），label 只作显示。这一项会**改变 deny 流语义**，需要 `tests/edit_ux2.cjs` 的 V6 组（`143-191`）同步更新断言，因此单独成一个提交。

---

### F11 · 归因探针（Step 0，先做）

#### 为什么必须先做
`move_text` 10 op → collision 96→0 的**机制我没有确证**。我确证的是"护栏范围小于缺陷范围"（F3），但 96→0 这种量级的崩塌更像**批量应用的相互踩踏**或**画布收尾的连带效应**（`07:210-219` 在批内会跑 `canvasTail`，而它会平移**全部** nodes/edges/texts，且可能通过 `Runtime.setResolution` 扩画布，`06:568-574`）。在没弄清之前就改代码，是在赌。

本项目已有这个传统：报告 §15.6「修掉的三个真缺陷（都是探针查出来的，不是设计出来的）」。

#### 探针设计（`tests/diag_batch.cjs`，沿用 `tests/diag_onto.cjs` 的写法）
对本体图，取 `text_overflow|move_text` 与 `style_inconsistency|normalize_style` 两个 `gateKey`：

```
1. 记录 batch 全部 op 的 label / target / itemKey
2. 逐个应用，每步后 IR.build + Analyzer.run，记录：
     score, metrics.collision, raw.collision.count, raw.occlusion.count,
     canvas(ir.canvas.w/h), contentBox, margin
3. 标出「哪一步开始崩」以及「崩的时候是哪两个节点/标签重叠」
4. 同时记录 canvasTail 在那一步是否被触发（tail.n / tail.grow / tail.canvas）
5. 单独验证：只应用那一个「肇事 op」+ canvasTail，复现崩塌？
6. 对照：应用同一 op 但**跳过 canvasTail**，崩塌是否消失？
```

第 5、6 步是关键 —— 它能把"op 本身有害"与"canvasTail 连带"**区分开**。这直接决定 F3 是"加护栏"还是"改收尾策略"。

#### 验收
探针输出一份 JSON，回答三个问题：①崩塌起点；②肇事 op 的 itemKey；③是否与 `canvasTail` 相关。**探针不改产品代码**，可与 Step 1 并行。

---

## 4. 预计效果（**预估，非实测**）

我不给假数字，只给**可验证的预测**，每条都能用 §5 的命令证伪：

| 修复 | 预测（可证伪） |
|:---|:---|
| F1 | 本体图上 `text_overflow` / `style_inconsistency` 两类**首次出现 `accept: true`**；`acceptedOps` 从 3 显著上升 |
| F2 | 轮 2 的 `rejectedKeys` **不再等于**轮 1 的子集；轮数可能从 2 保持不变但轮 2 有产出 |
| F3 | `move_text` 的失败从"collision 崩塌"变为"预检 `null`（`skipped` 上升）" |
| F4 | `steps[].gain` 在 `grow_spacing` / `move_apart` 之间不再恒等；`global_relayout` 从台账消失 |
| F5 | 实测区域数 = 9，`g#svg_31` 名字 = `Center platform container` |
| F6 | 第一段：总分逐位不变。第二段：`style` / `spacing` 在真实幻灯片上**不再恒为 0**（依赖定标） |
| F7 | `tiny_element` 8 → ≲2；`grow_to_min` 的 `Δcollision ≥ −5` |
| F8 | 新增交叉样例的 edge-over-edge 计数下降 |
| F9 | 新增渐变遮挡样例的 `occlusion.count ≥ 1` |

**明确不承诺**：本体图的总分会到多少。理由：`spacing`/`style` 两个维度合计 0.25 权重在幻灯片域恒零，修好它们需要 F5+F6 的定标，而定标结果取决于 sweep —— 先测后说。

---

## 5. 验证矩阵

```powershell
$env:NODE_PATH=".svgbuild\node_modules"

# 基线（F10 之后才有指纹；之前先手工确认产物 sha）
node tests/sweep_rule.cjs                       # 全量 36 样例 × rule 臂 → 与基线逐条对照
node tests/smoke_svgb.cjs                       # 产物冒烟：零 pageerror / 零失败请求 / 四视图不改内容 sha256
node tests/contain_audit.cjs real-01            # 用户可见的「文字越出容器」审计（与分数无关）
node tests/validate_occlusion.cjs real-01       # 遮挡前后对照（F9 的依据）
$env:SVGB_TARGET="svgb_beautifier.html"; node tests/edit_e2e.cjs   # 编辑闭环不被破坏
$env:SVGB_TARGET="svgb_beautifier.html"; node tests/edit_ux2.cjs   # 改动清单（F10 签名改动的依据）

python build.py --check && python build.py --verify    # 源齐全 + 产物逐字节可复现
```

⚠️ **`tests/` 脚本失败时退出码仍为 0**（只有致命异常才非零，`edit_e2e.cjs:694`）—— 必须**解析 JSON** 判断通过，不能看退出码。

| 修复 | 必跑 | 关键断言 |
|:---|:---|:---|
| F1 | `sweep_rule` + 本体图探针 | `canvas_margin`/`spacing` 样例逐位不变；本体图两类不再归零；`sumDelta` 不降 |
| F2 | `sweep_rule` | 轮 2 与轮 1 的 `rejectedKeys` 集合差非空 |
| F3 | `sweep_rule` + `contain_audit` | 无 `move_text` 相关 `Δcollision < −5` |
| F4 | `sweep_rule` | `global_relayout` 不出现在 `firstSrc`/`chosen`；`distribute_equal` 逐位不变 |
| F5 | 新诊断探针 | 区域数 9；归属唯一；命名正确 |
| F6 一段 | `sweep_rule` | `score` 与 7 个既有 metric **逐位不变** |
| F6 二段 | `sweep_rule` | 5 clean 样例恰好 100/0 issue；扁平 SVG 不扣分 |
| F7 | `sweep_rule` | `tiny_element` 下降；`grow_to_min` 的 `Δcollision ≥ −5` |
| F8 | 新交叉样例 | edge-over-edge 计数下降 |
| F9 | `validate_occlusion` + 新渐变样例 | 新样例 `occlusion.count ≥ 1`；clean 样例仍 0 |
| F10 | `build.py --verify` + `edit_ux2` | 产物可复现；改动清单仍可取消 |
| 全部 | `edit_e2e` + `smoke_svgb` | 编辑闭环与产物冒烟零回归 |

---

## 6. 风险登记与回滚

| 风险 | 等级 | 缓解 | 回滚 |
|:---|:---:|:---|:---|
| F1 的 item 级提交与 `owner` 占用不一致 | 中 | 每个成功单元后立即更新 `an` 并在下一循环重规划（`07:182`），owner 由重规划重建 | 清空 `Geo.ATOMIC` 表即恢复现状 |
| F6 二段新维度误报 | **高** | 两段式 + clean 样例 100 分硬闸 + sweep 定标 + 「不适用→满分」显式语义 | 移除 `METRIC_KEYS` 条目即回到一段 |
| F3 护栏变严导致 `move_text` 完全失效 | 中 | 护栏只否决"落进别人容器/压到别的文字"的情形；正常居中不受影响。断言 `move_text` 在至少一个样例上仍被采纳 | 恢复 `06:1400-1404` 的原有循环范围 |
| F7 角色误判把真节点标成 decoration | 中 | 默认兜底 `'label'`（进 tiny 判据）；`data-role` 方言优先；断言 `Σ roles === nodes.length` | 停用 `role` 过滤，回到纯面积判据 |
| F8 加边障碍导致重路由普遍失败 | 中 | 接受判据改"严格减少"而非"零交叉"；保留"失败即不发 op" | 障碍集只放节点（现状） |
| F9 命名色表外误判 | 低 | 表外保守返回 `false`（不新增误报），只让渐变生效 | 恢复 `normColor` 旧判定 |
| F10 改 `opSig` 破坏 deny 流 | 中 | 单独成一个提交，同步更新 `edit_ux2` V6 断言（`143-191`） | 保留 label 派生签名 |

**总回滚原则**：每项修复都由**一个开关/表/常量**控制（`Geo.ATOMIC`、`attempts` 上限、`regions=null`、`WEIGHTS`、`role`、障碍集、`paintOpaque`），互不纠缠 —— 任一项出问题都能单独退回，不需要回退整个提交。

---

## 7. 未验证项（诚实标注，不要在实现时当成已知）

| # | 未确证的事 | 如何确证 |
|:--|:---|:---|
| 1 | `move_text` / `normalize_style` 批导致 collision 96→0 的**机制** | **F11 探针**（Step 0）。我的两个候选解释：①批量应用的相互踩踏；②批内 `canvasTail` 的连带（它会平移全部元素并可能扩画布，`07:210-219` / `06:526-605`）。**未区分** |
| 2 | `op.itemKey` 是否严格对应"一组 targets" | 代码已确认 `ik = it.targets.join(',')`（`06:783`）与 `op.itemKey = type + '|' + itemKey`（`06:792`）。**但"同一 itemKey 的 op 是否必然语义原子"未逐一验证** —— F1 实现时应对全部 9 个 issue 类型各取一个样例，打印 `itemKey → ops` 分布来确认 |
| 3 | 新维度的 `sat` 具体取值 | **必须 sweep 定标**，不能拍脑袋。本文只给起点 |
| 4 | `leaves` 修正后本体图的 `inkDensity` 绝对值 | 探针口径含重复计入（>1）。F5 实现后需重测并与 §3.3 的相对次序对照 |
| 5 | 命名色的完整集合是否够用 | 内置 ~16 色表覆盖 SVG 常见色；表外保守 `false`。需用真实样例统计未命中率 |
| 6 | `g#svg_115` 应归类为 `band` 还是 `panel` | 按 `w/h = 23.5 ≥ 6` 规则为 `band`（因此不参与 `whitespace` 惩罚）。**这个归类是否合理需要人工看一次图确认** |

---

## 附录 · 关键插入点索引

| 修复 | file:line | 动作 |
|:---|:---|:---|
| F1 | `06_geometry.js:80` | 新增 `Geo.ATOMIC` + `Geo.atomicity` |
| F1 | `07_patch.js:201-246` | 单批次应用 → `_tryUnits` 快/慢路径 |
| F1 | `06_geometry.js:774` 后 | 消费 `sopt.rejectItems` |
| F1 | `07_patch.js:181` | 透传 `rejectItems` |
| F2 | `07_patch.js:167` → 循环外 | `reject` 改为 `attempts` 派生 |
| F3 | `06_geometry.js:1389/1400-1404` | 签名加 `ir`；护栏加跨节点/自由文本 |
| F3 | `06_geometry.js:1422` | 调用点同步 |
| F4a | `04_analyzer.js:370` | 候选表删 `global_relayout` |
| F4a | `06_geometry.js:148` | 桩 → `score:0` |
| F4b | `06_geometry.js:928` | `base` 按 `g.key` 分派 |
| F5 | `ui.html:418-431` | 插入 `src/03b_region.js` |
| F5 | `03_ir.js:192` 前 | 软依赖调用 `RegionGraph.build` |
| F6 一段 | `04_analyzer.js:46-54` | `raw.region`（不改 score） |
| F6 二段 | `04_analyzer.js:32-35`、`56-65` | `WEIGHTS`/`METRIC_KEYS`/`METRIC_CN`/metrics |
| F6 二段 | `07_patch.js:50` | `GUARD` 追加 |
| F6 | `04_analyzer.js:361-428` | 3 个新 issue 类型（+ `06:18-28` LABEL、`06:137-177` evaluate、`06:74-79` PHASES×4） |
| F7 | `03_ir.js:169` 附近 | `n.role` + `n.importance` 重定义 |
| F7 | `04_analyzer.js:419` | `tiny_element` 收窄 |
| F7 | `06_geometry.js:1090-1108` | `grow_to_min` 双保险 |
| F8 | `06_geometry.js:1617-1629` | 障碍集加边 |
| F8 | `06_geometry.js:1662-1676` | 接受判据改"严格减少" |
| F8 | `06_geometry.js:487` | `evReroute` 上限声明 |
| F9 | `02_runtime.js`（新增） | `paintOpaque` |
| F9 | `04_analyzer.js:122-123`、`06_geometry.js:684` | 同步改用 |
| F10 | `07:209/265/145/114`、`README.md:130`、`.svgbuild/st3.json`、`ui.html:1103` | 见 F10 表 |
| F11 | `tests/diag_batch.cjs`（新增） | 归因探针 |

---

*本文档为只读分析 + 设计产物；未修改任何源码、样例或 SVG。所有症状数字可由 `svgb_layout_optimization_plan-v1.md` 附录 A 的探针原样复现。*
