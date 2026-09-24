# SVG Beautifier 布局修复 · 实施报告 v1

> 对应设计：`svgb_layout_repair_design-v1.md`（F1–F11）
> 对应路线图：`svgb_layout_optimization_plan-v1.md`
> 基线提交：`fd152e6`（用 git worktree 独立检出，见 §7）
> 本报告所有数字均为**实测**；凡未实测的一律标注为"预估/未验证"。

---

## 0. 结论（一句话）

设计里的 F1–F11 **全部落地**，另补三处设计未覆盖的根因修复（§4）。全量 36 个样例的**美化后分数与基线逐位相同**（`meanAfter 93.517`、`sumDelta 286.9`、`acc 52`），而**被浪费的否决从 141 降到 135**；用户报的那张本体图（`real-onto_platform_architecture`）里造成"`collision` 96→0"的机制**已被消除**（详见 §4）。

同时，实施过程用探针**证伪了设计文档中的 3 处前提**，并推翻了路线图对"布局问题"的归因 —— 这些更正写在 §3 / §4，没有掩盖。

---

## 1. 交付物

| 文件 | 状态 | 规模变化 |
|:--|:--|:--|
| `src/03b_region.js` | **新增** | 26 607 B / 451 行 —— `RegionGraph`（区域图 + 源图命名） |
| `src/03_ir.js` | 修改 | +63 行 —— 语义角色 F7、区域图软依赖 F5、`isBg` 钉作者画布 X1 |
| `src/04_analyzer.js` | 修改 | +127 行 —— 区域级度量 F6 第一段、`tiny_element` 收窄、悬空 paint 引用 F9 |
| `src/06_geometry.js` | 修改 | +228 行 —— 原子性分级 F1、`global_relayout` 下线 F4a、`grow_spacing` 语义 F4b、`anchorDelta` 护栏③④、`routeEdge` 边感知 F8 |
| `src/07_patch.js` | 修改 | +269 行 —— 校验单元重写 F1（**二分搜索**）、跨轮记忆 F2、作者原文/画布通道、台账补全 F10 |
| `ui.html` | 修改 | +22 行 —— 注册 `03b_region.js`；`opSig` 稳定身份 F10 |
| `tests/sweep_rule.cjs` | 修改 | +43 行 —— 基线**指纹** F10 |
| `tests/diag_batch.cjs` | **新增** | F11 只读诊断探针（批次塌陷归因） |
| `README.md` | 修改 | 产物行数/字节数校正 F10 |
| `svgb_beautifier.html` | 重新生成 | 8 451 行 / 1 681 738 B |
| `svgb_layout_repair_design-v1.md` | 修改 | 补 §0.1–§0.4 的实测更正 |
| `svgb_layout_optimization_plan-v1.md` | 修改 | 更正 F3 条目的错误前提 |

`git diff --stat`（不含新增文件）：`10 files changed, 1827 insertions(+), 146 deletions(-)`。
测试套件产生的两张截图（`tests/edit_ui_*.png`）是**输出物**而非基准，已还原，避免混入无关二进制 diff。

---

## 2. 实测结果

### 2.1 全量 36 样例：零质量回归

基线用 `git worktree add <dir> fd152e6` 独立检出**改动前**的代码跑同一脚本，因此两次测量的输入与代码都不重叠、可逐条对照。

交付树的源码指纹：`sha256 f97d0056f7f47380`（`segments: 15`、`filesHashed: 16`）。该指纹由 `tests/sweep_rule.cjs` 在 **`page.goto` 之前**算出（哈希 `ui.html` + 其全部 `<script src>` 内容），因此扫描结果能自证"测的就是这棵树"，不会在代码漂移后被误当成同一基线。

| 指标 | 基线 `fd152e6` | 本次交付 | 判定 |
|:--|--:|--:|:--|
| 样例数 | 36 | 36 | — |
| `meanBefore` | 85.547 | 85.547 | **逐位相同** |
| `meanAfter` | 93.517 | **93.517** | **逐位相同** |
| `sumDelta` | 286.9 | **286.9** | **逐位相同** |
| 接受 op 数（累计） | 52 | **52** | **逐位相同** |
| 否决 op 数（累计） | 141 | **135** | **−6（少做无用功）** |
| 崩溃 / 页面错误 | 0 | **0** | — |

**逐条差异只有 2 个样例，且两者的 `after` 分数都不变，只是否决数下降**：

| 样例 | after 基线 → 本次 | Δafter | Δ否决 |
|:--|:--|--:|--:|
| `raw-grid-…-s24` | 95.75 → 95.75 | 0 | −1 |
| `real-laya-marker-scorer` | 94.10 → 94.10 | 0 | −5 |

否决数下降来自 **F4a**：幽灵策略 `overlap:global_relayout` 在 `Geo.plan` 的 switch 里根本没有分支（永远产不出 op），却带着 `{score:30}` 参与排序，把自己排进候选并稳定地"失败一次"。把它的 `evaluate` 分数改为 0 后不再参与排序，于是这些"注定失败的步骤"从台账里消失。

> **为什么要专门建 worktree 取基线**：`.svgbuild/st3.json` 里那份旧基线记录的是 `real-onto 58.8 → 58.8, acc 0 / rej 15`，与本仓库当前代码**不可比**。差异可精确解释：`58.8 = 46.3 + 0.25 × (96 − 46)`，即旧记录的 `before` 早于遮挡项并入 `collision` 的那次改动。直接拿旧 JSON 当基线会得出"严重回归"的错误结论。

### 2.2 用户报的本体图：塌陷机制消失

样本 `real-onto_platform_architecture`（1920×1080 幻灯片，39 节点 / 10 连线 / 62 文本）：

| 项 | 修复前 | 修复后 |
|:--|:--|:--|
| 总分 | 46.30 → 69.25（Δ+22.95） | 46.30 → 69.25（Δ+22.95） |
| `text_overflow:move_text` | **10 个 op，Δ−24.8，`collision` 96→0** | **4 个 op，Δ−0.4，无塌陷** |
| `style_inconsistency:normalize_style` | **24 个 op** | **20 个 op** |
| `text_overflow:resize_container` | 4 个 op，Δ−13.3 | 3 个 op，Δ−12.1 |
| `tiny_element:grow_to_min` | 8 个 op，Δ−22.9 | 8 个 op，Δ−22.9 |

**总分没变，但病灶消失了**：那 10 个 op 里有 9 个是把 H1 标题整体平移 (697.5, 449.5)px 到画布中心的"搬运 op"（见 §4），它们被 4 个合法 op 取代。也就是说"一键美化对这张图几乎不动"的**直接原因**已经解除。

**为什么总分仍未提高（诚实说明）**：剩下的批次是**真的没有净收益** —— `normalize_style` 的干净子集 Δ≈0，`grow_to_min` 的任意子集也过不了门（§2.4 有二分搜索的实测结论）。瓶颈已经从**几何引擎**转移到**评分视野**：该图的 `spacing` 与 `style` 两个维度在美化前后**恒为 0**（已饱和在最差档），几何层把这两类问题改好了，评分也**看不见**。这正是 `report.md` §16.1 记录的口径边界，也是 F6 存在的理由 —— 而 F6 第二段（给新维度上权重）必须先完成定标，本次**有意未做**（§6）。

### 2.3 区域图（F5）与区域度量（F6 第一段）

`RegionGraph` 在本体图上识别出 **9 个区域**，其中 **8 个拿到了作者写的中文/英文区名**：

| id | 元素 | kind | name（来自作者原文注释） | 成员 |
|:--|:--|:--|:--|--:|
| r2 | `rect#svg_4` | frame | `Background` | 1 |
| r3 | `rect#svg_5` | frame | `""`（紧前兄弟是 `<rect>` 而非注释 → 保持空，**不猜**） | 1 |
| r4 | `g#svg_8` | band | `Top capability ribbon` | 1 |
| r5 | `g#svg_12` | panel | `Left: data/system ecosystem` | 7 |
| r6 | `g#svg_31` | panel | `Center platform container` | 19 |
| r7 | `g#svg_72` | panel | `Right side: applications` | 7 |
| r8 | `g#svg_102` | band | `Bottom domain lane` | 1 |
| r9 | `g#svg_115` | band | `Key relationship labels` | 2 |
| r10 | `g#svg_120` | band | `Legend` | 0 |

不变量全部成立：每个节点**恰好**归属一个区（39/39，无重复）、无 `inkDensity > 1`、37 个样例扫描无抛错、畸形入参返回 `null` 而不抛。

`Analyzer.regionMetrics` 因此从 `applicable:false` 变为 `applicable:true`：3 个 panel，`balance 0.66`（最挤 `Left: data/system ecosystem` 0.53，最空 `Center platform container` 0.18），`whitespace 0`（无面板过挤），`hierarchy 0`（并列对不计入）。

**F6 第一段是"可观不可修"**：新维度只写入 `raw.region`，**不进** `METRIC_KEYS` / `WEIGHTS` / `score` —— 所以 §2.1 的"总分逐位相同"本身就是这条不变量的证明。

**命名为什么需要专门通道**：svgcanvas 的 `Drawing.identifyLayers()` 会把根级**元素**重挂进末尾新建的 `g.layer`，而**注释节点被 ignore、留在 `#svgcontent` 原位** —— 于是"注释紧邻区元素"这层关系在载入后永久丢失（实测载入后 9 个区的 `name` 全为 `''`）。修复方式是让 `Pipeline.beautify` 把**作者原文**经 `o.sopt.svgText` 传下去：它是未经改动的原文，交错关系完好。之所以挂在 `o.sopt` 而不是记在 `Runtime` 上，是因为管线内部的 `rt.load(preSvg/uSvg)` 回滚只换 DOM 不换该字段 —— 记在 Runtime 上会被第一次回滚用"导出串"（注释已丢）覆盖，导致区域名随每次重算抖动、评分失去幂等性。

**命名正确性的独立验证**（不是拿期望值反推）：对每个"数量相等"的标签类，逐位比较**源图元素的 `<text>` 子树计数**与**对应区的 texts** —— 本体图 `[g]` 两侧均为 `[2,11,21,11,7,2,4]`，`real-05` 为 `[10,15,0]`，`real-04` 为 `[12,9,4]`，**错位组数 = 0**。

### 2.4 二分搜索（F1 强化）：安全，但在本图上无收益

`normalize_style` 的 24 个 op 里**只有第 7 个有害**（字号 16→18px 把文字探到不透明容器下）。逐 item 提交在这里**完全无效** —— 单个字号改动自身 Δ≈0，而 op 级门要求 Δ>0 严格提升 → 24 个单元全数落空。因此把逐 item 提交升级为**对单元（item）做二分搜索**。

**实测结论：本体图上一个额外 op 都没提交**，因为该图**不存在净收益子集**（干净子集 Δ≈0）。这是实测结论而非失败。二分搜索的价值在于**它是安全的**：每次提交都必须先过同一个 op 级门，且 `gain` 相对当前已提交状态测得，所以最坏情况是什么都不提交、与旧行为等价 —— 它只可能"多提交已被证明有提升的子集"，不可能引入劣化。

### 2.5 测试矩阵

| 测试 | 结果 | 与基线对比 |
|:--|:--|:--|
| `tests/edit_e2e.cjs` | **47/47** | 相同 |
| `tests/edit_cancel.cjs` | **14/14** | 相同 |
| `tests/edit_ux2.cjs` | **12/15** | **与基线逐条相同**（3 项失败在 `fd152e6` 上同样失败，见下） |
| `tests/edit_multi.cjs` | **16/18** | **与基线逐条相同**（2 项失败在 `fd152e6` 上同样失败） |
| `tests/contain_audit.cjs real-01` | 溢出 4 → **0**，`maxOverrun 62.63px → 0` | 无退化 |
| `tests/validate_occlusion.cjs` | `pageErrors: []` | 无退化 |
| `tests/smoke_svgb.cjs`（单文件产物） | `ok: true`, `failed: []` | 无退化 |
| `python build.py --check` | `OK 源齐全，15 段` | — |
| `python build.py --verify` | `OK …一致` | — |

**5 项失败是既有缺陷、与本次改动无关**（已用同一脚本在基线 worktree 上复现，失败项名称完全相同）：

* `edit_ux2`：`V1 选中 g 时字号输入框可用` / `V1 改字号真的生效（全部目标变 37）` / `V1 字号改动进了撤销栈与轨迹`
* `edit_multi`：`M4 批量填充：全部选中元素同时变色` / `M6 多选时属性框如实标记「多值」：填充不一致 → eFill 带 mixed`

两组都落在**编辑器 UI 的字号/填充**路径上，与本次改动的作用面（美化管线 / IR / 几何 / 区域图）不重叠。**未在本次修复**（超出"按设计修复布局"的范围），如需处理应单独立案。

---

## 3. 设计文档中被实测证伪的 3 处前提

| # | 原设计（错） | 实测（对） | 证据 |
|:--|:--|:--|:--|
| 1 | **F9**：`normColor` 把渐变/命名色"视为不遮挡"→ **遮挡漏检** | **方向相反**。`normColor('url(#gPurple)')` → `'url(#gpurple)'`（**truthy**）；`normColor('red')` → `'red'`（truthy）。渐变与命名色**一直被当成不透明遮挡源**，不存在漏检 | 11 个入参的真值表；本体图 6 个渐变 `stop-opacity` **全为空**（完全不透明），全图无 `fill-opacity < 1` |
| 2 | **F7**：`tiny_element` 把图例色块/装饰点当数据节点 → 应由 role 收窄，预期 **8 → ≲2** | **收窄在该样本上是 no-op**。8 条**全部是真实的有标签数据节点**（`Validator` / `Repository` / `Agent ToolChain` / `数据语义化` …），该样本 `decoration` 数 = **0**，`role` 分布 = 34 data / 2 container / 3 shape | 8 条 tiny 的完整清单（含面积、标签、role） |
| 3 | **F3**：`anchorDelta` 签名**没有** `ir`，需要改签名 + 同步改调用点 | 签名**已经是** `anchorDelta(ir, n, l)`，两个调用点**已经传入 `ir`**。无需改签名 | `grep anchorDelta src/06_geometry.js` 三处命中 |

**因此落地的内容与设计有两处不同**：

* **F9 改为修真正存在的缺陷**：**悬空**的 paint 引用 `url(#nonexistent)` 旧行为返回 truthy，会被当成不透明遮挡源 → **凭空报出"文字被遮挡"**。在 SVG 里解析不到 paint server 的元素根本不被绘制，必须按"无填充"处理。这条对全部现有样例都是 no-op（它们没有悬空引用），只消除一个潜在误报。**没有**引入 stop-opacity 解析与命名色表 —— 那是在为一个不存在的问题写代码。
* **F7 的收益来源被改正**：role 层保留，但定位改为**基础设施**（供 F6 的区域/层级维度使用）+ **防御性护栏**（挡住带标签的图例件与方言标注件），而**不是**"本体图 tiny 的修复"。本体图 `tiny_element` 成批放大的问题由 **F1 的增量提交**解决（每个 tiny 节点本就是独立 item，按 item 提交后只有不撞的那些会生效）。

---

## 4. F11 诊断的真实机制，以及设计之外补的两处根因修复

### 4.1 路线图的归因是错的

路线图与设计都把"`collision` 96→0"归因为**节点两两重叠**。F11 的只读诊断（`tests/diag_batch.cjs`，两次运行逐位一致，以关键函数源码哈希锚定）实测：**节点重叠完全没有变化** —— `pairs` 恒为 `1`、`collision.density` 恒为 `0.02`、39/39 个节点位移普查全是 `Δ=(0,0)`。

塌陷来自 **occlusion**，而它被**折进同一个 collision 指标**：

```
metrics.collision = sc(raw.collision.density + raw.occlusion.density, collSat)   // 04_analyzer.js:58 / :37
occlusion.density = clamp(Σ max(cover, 0.25), 0, 1)                              // 04_analyzer.js:233
collSat = 0.5
```

**两条遮挡就恰好等于 collSat（2 × 0.25 = 0.5）→ collision 归零。** 这是台阶不是斜坡：第 1 条遮挡已吃掉半个指标，第 2 条直接归零。`normalize_style` 正是**恰好卡在阈值上**。

具体肇事 op：`text_overflow|move_text` 的第 **1/10** 个 op（`opFixAnchor`，属主 `n3 = rect#svg_5`）把 H1 标题从 `(116.5,92.5,341×45)` 平移到 `(814,542,341×45)` —— **位移 (697.5, 449.5)px**，标题随即落在 `n23`/`n25`（文档序更靠后、不透明）之下。

### 4.2 canvasTail 是"历史帮凶"，不是直接成因

E4 精确复刻 `applyAll → canvasTail → checkOp` 证明**带 tail 与不带 tail 的裁决完全相同**；反向只跑 canvasTail 得到 `n=0 ops, grow=false`（无操作可施加）。**但此前有一次被接受的** `spacing|distribute_equal` 的 tail 调用 `Runtime.setResolution` 把画布从 1920×1080 撑到 **2036.5×1129**。单变量对照（同一 DOM，只改 `canvas.w/h`）：

| 画布 | `n3` 面积比 | `isBg` | 结果 |
|:--|:--|:--|:--|
| 1920×1080（作者尺寸） | 0.86 | **true** | 标题/副标题/图例是自由文本 → `move_text` 批次 = **4 个 op**（无搬运动作） |
| 2036.5×1129（tail 之后） | 0.78 | **false** | 满版外框降级为普通节点，**认领**标题/副标题/图例为自身 labels → 批次膨胀到 **10 个 op**，含 (697.5,449.5)px 搬运动作 |

即：**"谁是满版底板"这一语义随画布尺寸漂移** —— `03_ir.js` 的 `area/cvArea ≥ 0.85` 判据正好卡在真实图的 **0.86** 上，一次 6% 的画布增长就把它翻了过来。这是**非幂等重分析**：同一个 DOM，`IR.build` 两次给出不同语义。

### 4.3 设计之外补的两处修复（X1 / X2）

| # | 修复 | 实测效果 |
|:--|:--|:--|
| **X1** | `isBg` 改为相对**作者画布**判定。`Pipeline.beautify` 在 `rt.load` 之后、任何 canvasTail 之前把 `{w,h}` 钉进 `o.sopt.authoredCanvas`（与 `svgText` 同一通道，**回滚免疫**）；`03_ir.js` 用 `bgArea` 替代 `cvArea`。**未带该字段时退回当前画布，行为与改动前逐位一致** | 本体图 `text_overflow:move_text` 从 **#10（Δ−24.8，collision 96→0）** 收敛为 **#4（Δ−0.4，无塌陷）**；`normalize_style` 从 #24 → #20 |
| **X2** | `anchorDelta` 护栏③复用的 `wouldCollide` 带 `coverRatio ≥ 0.95` 豁免。该豁免本意是放过"标签完整待在自己父容器/满版底板内"的合法嵌套，但它**同样放行**了"标签完整落进**另一个**不透明、且绘制更晚的容器底下" —— 恰是 Analyzer 判为缺陷、门级必然扣分的形态。新增**护栏④**：与 `Analyzer.occlusion` **同源**判据（不透明、非属主、非背景、文档序在文字之后、两维交叠 ≥6px）；只否决**新引入**的遮挡（原位置本就被同一形状压着的不算新缺陷，否则被遮挡的标签永远修不动） | 直接掐断那个 697.5×449.5px 搬运 op 的产生路径 |

> **一个被实测抓出的自身缺陷**（不在设计里，由回归扫描发现）：item 级黑名单原先只按 `itemKey`（= `type|targets`）记账，**不含策略**。于是一个策略在某个 item 上失败，会连带封杀同类问题在该 item 上的**其它策略** —— `wrap_text` 失败把 `resize_container` / `move_text` 一起封掉了。实测代价：`real-02` 丢掉一次本会被接受的 `resize_container#5`（72.15 → **68.95**），`real-03` 丢掉 `resize_container#2`（69.95 → **69.55**）。改为按 **(策略, item)** 二元组记账后两者**逐位复原**为 72.15 / 69.95。

---

## 5. 逐项完成状态

| 项 | 状态 | 说明 |
|:--|:--|:--|
| F1 校验单元重写 | ✅ | 原子性分级 `Geo.ATOMIC` + **二分搜索**子集提交；另修 item 黑名单的策略作用域 |
| F2 跨轮记忆 | ✅ | `attempts` Map + `maxAttempts`（默认 2），到期后进 `reject` |
| F3 `anchorDelta` 护栏 | ✅ | 护栏③（跨节点，复用 `wouldCollide`）+ 护栏④（z-order 遮挡，与 Analyzer 同源） |
| F4a `global_relayout` 下线 | ✅ | `evaluate` 分数 30 → 0，不再参与排序；6 处注册点逐一核对 |
| F4b `grow_spacing` 语义分家 | ✅ | `base = max(observed, st.gap)` |
| F5 `RegionGraph` | ✅ | 9 区、8 命名、不变量全成立、畸形入参返回 `null` 不抛 |
| F6 区域级维度 | ⚠️ **第一段完成，第二段有意未做** | `raw.region` 可观不可修（总分逐位不变即为证明）。第二段（提升为 `WEIGHTS`/`METRIC_KEYS`）**必须先完成定标**，见 §6 |
| F7 语义角色 | ✅（收益来源已更正） | `n.role` + `tiny_element` 防御性收窄 + `grow_to_min` 双保险 + 复合 `importance`；**对本体图是 no-op**，见 §3 |
| F8 `routeEdge` 边感知 | ✅ | 其它边按**软惩罚**（`EDGE_PEN=6`）进入代价而非硬阻塞；接受判据改为"节点穿越不增加 **且** 边交叉不增加"；`evReroute` 预检上限 6→12 并**显式声明截断** |
| F9 遮挡不透明判定 | ✅（内容被更正替换） | 只修**悬空** paint 引用，见 §3 |
| F10 工程收尾 | ✅ | `applyAll` 错误不再被吞、`dryRun` 返回 `proposed`、遮挡修复失败进 `occErrors`、台账补 `appliedOps`/`attempts`/`rejectedItems`、`README` 尺寸校正、sweep **基线指纹**、`opSig` 稳定身份 |
| F11 只读诊断 | ✅ | `tests/diag_batch.cjs`，结论见 §4 |

**`opSig`（F10 最后一项）的残余局限（如实标注）**：签名从 `strategy|label` 改为 `元素id|kind|策略|问题类型`，消除了两处相反方向的漏洞（同 label 不同元素的**冲突**；label 带数字导致预览/应用**失配**而 fail-open）。**残余**：同一元素上、`kind`/策略/问题类型都相同的多个 op（例如同一次 `normalize_style` 里对同一文本既改字号又改填充）仍会共用签名。彻底解决需要在 `claim()` 处下发显式稳定 `opId`，属独立改动。实测 `edit_ux2` 的 V6 仍是 `unchecked 15 → deny 15`，未引入新冲突。

---

## 6. 没做什么 / 已知局限（请勿当作已完成）

1. **F6 第二段未做**（有意）：给区域级维度上权重需要先观测其在全部样例上的分布并定标饱和度。在数据齐全前上权重，等于把误报直接写进总分。本次只交付"可观"。
2. **`spacing` / `style` 在幻灯片域恒为 0 的口径边界未动**：这是本次**没有**提高本体图总分的根本原因。属于评分标定问题，不是几何问题。
3. **二分搜索在本体图上零收益**：该图不存在净收益子集（§2.4）。它已被证明安全，但不要期待它凭空造出收益。
4. **`evReroute` 预检只覆盖前 12 条连线**：超出部分已在 `detail` 里显式声明为未预检，但确实没有全量预检（`routeEdge` 是 O(E) 的栅格 A*，全量会放大开销）。
5. **`collision` 指标的 2 条遮挡台阶未改**：`occlusion.density` 与 `collision.density` 相加再对小 `collSat` 取饱和，导致"2 条遮挡 = 归零"的突变。本次**只消除了触发它的病灶**（§4.3），**没有**改指标形态 —— 改形态会影响全部样例的分数可比性，应单独立案并配定标。
6. **`edit_ux2` 3 项 / `edit_multi` 2 项失败是既有缺陷**，在基线提交 `fd152e6` 上同样失败，本次未修（§2.5）。
7. **Laya 决策模型的角色未变**：本次没有给它任何几何/坐标权威，也未新增模型调用。
8. **未做端到端反事实**："关掉画布增长后重跑整条管线"没有跑；§4.2 的对照是在**捕获到的批前状态**上做单变量替换（同一 DOM，只改 `canvas.w/h`），不是完整管线重跑。

---

## 7. 复现命令

```powershell
$env:NODE_PATH=".svgbuild\node_modules"

# 构建与自检（15 段；--verify 比对产物与源码一致性）
python build.py
python build.py --check
python build.py --verify

# 单文件产物冒烟
node tests/smoke_svgb.cjs

# 全量 36 样例扫描（输出 {fingerprint, rows}；指纹在加载页面前固定，防止代码漂移后误比）
node tests/sweep_rule.cjs > .svgbuild\sweep_ship.json

# 与基线对照：先用独立 worktree 检出改动前的提交，再跑同一脚本
git worktree add ..\svgedit-h0 fd152e6
#   （在 worktree 内）$env:NODE_PATH="<abs>\.svgbuild\node_modules"; node tests\sweep_rule.cjs > <abs>\.svgbuild\baseline_h0.json
# 逐条对照（脚本自动处理 PowerShell 重定向写出的 UTF-16LE）
node .svgbuild\cmp_sweep.cjs .svgbuild\baseline_h0.json .svgbuild\sweep_ship.json

# F11 批次塌陷归因（只读）
node tests\diag_batch.cjs

# 其余测试
node tests\edit_e2e.cjs        # 47/47
node tests\edit_cancel.cjs     # 14/14
node tests\edit_ux2.cjs        # 12/15（3 项为既有失败）
node tests\edit_multi.cjs      # 16/18（2 项为既有失败）
node tests\contain_audit.cjs real-01
node tests\validate_occlusion.cjs real-01
```

> ⚠️ 这些测试**即使检查失败也返回退出码 0**，必须解析输出而不能只看 `$LASTEXITCODE`。
> ⚠️ 本机 PowerShell 的 `>` / `*>` 重定向写出 **UTF-16LE**；直接用 `JSON.parse(readFileSync(p,'utf8'))` 会得到夹 NUL 的乱码并静默解析失败。仓库内两个对照脚本（`cmp_sweep.cjs` / `fails.cjs`）已按 BOM 嗅探解码。

---

## 附：本次改动触及的关键位置速查

| 位置 | 内容 |
|:--|:--|
| `src/03_ir.js` | `SKIP_INSIDE`、`isBg`（X1）、自由文本归属、`role`（F7）、`importance`（F7）、`RegionGraph` 软依赖（F5） |
| `src/04_analyzer.js` | `WEIGHTS`/`METRIC_KEYS`/`METRIC_CN`、`sc`、`run`、`regionMetrics`（F6-1）、`occlusion`、`tinyElement` 收窄、`normColor`（F9） |
| `src/03b_region.js` | `RegionGraph.build` 五参签名 `(rt, content, nodes, canvas, opts)`，`opts.svgText` 为作者原文 |
| `src/06_geometry.js` | `Geo.ATOMIC` / `atomicity`（F1）、`evReroute`（F8）、`_crossCount`、`routeEdge`（F8）、`plan` 的 `rejectItems` 过滤、`case 'tiny_element'`（F7）、`anchorDelta`（F3）、`opFixAnchor` |
| `src/07_patch.js` | `beautify`（`svgText` / `authoredCanvas` 通道）、`_tryUnits`、`_groupByItem`、逐轮 `reject`/`rejectItems`/`budget`/`steps`、二分搜索 `trySub`、`_resolveOcclusions` |
| `ui.html` | `03b_region.js` 注册；`opSig`（F10） |
