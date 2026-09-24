# 本体图「一键美化」全局布局推理优化方案 · v1

> 对象：`svgb_beautifier.html`（= `ui.html` 由 `build.py` 内联出的单文件产物）
> 触发问题：对 **ontology 本体图**（`real-onto_platform_architecture` / `svg/onto_platform_architecture.svg`）执行「一键美化」时出现布局问题 —— 局部规则正确、全局布局恶化。
> 本文所有结论都带 `file:line` 证据；所有数字都是在当前工作区**当场实测**的（探针见附录 A），不是引用旧报告。
> 本文只读分析 + 方案，**未修改任何源码或 SVG**。

---

## 0. 结论摘要（先看这个）

你那份分析的方向是对的，但它假设的架构与这份代码的真实形态有 4 处关键错位。先把错位讲清楚，方案才不会是空中楼阁：

| 你的假设 | 代码事实 | 影响 |
|:---|:---|:---|
| Laya 是"自主选择最优 Patch 的决策器" | `Laya` 只是一个可选后端（`127.0.0.1:8771`，`05_laya.js:20-33`）。报告已诚实记录：**模型 choice 采纳 0 次与 18 次，最终质量完全相同（99.039 vs 99.039）**，Laya 当前提供的是"可审计通道"而**不是质量来源** | 把"全局布局推理"押在 Laya 上不会有效果；要押在**几何层 + 评分层** |
| 已经存在 Card1..Card4 这样的语义结构可供 Laya 识别 | `IR` 是**扁平**的：只有 `nodes / edges / texts / decorations / preserved`（`03_ir.js:192-199`），**没有容器树、没有区域、没有父子关系**；纯容器 `<g>` 被显式丢弃（`03_ir.js:134` `if (t === 'g') continue; 纯容器组：下钻即可`） | "理解设计意图"缺的不是模型，是**数据模型里没有区域这层** |
| 有多个候选方案、由评分择优 | **不存在多方案**。候选策略只是 issue 上的静态字符串数组（`04_analyzer.js:370/376/384/…`），`Pipeline.preview` **不打分**（`07_patch.js:86-90`），全仓库**没有任何对多个完整方案做 argmax 的地方** | "生成多个优化方案 → 自主选择最优"要从零建 |
| 评分维度是 Structure/Typography/Color/Complexity | 实际 7 维：`collision .25 / textFit .20 / alignment .15 / spacing .15 / edgeRouting .10 / style .10 / canvas .05`（`04_analyzer.js:32`） | 你的"Structure / 复杂度"缺位，但缺的核心是**区域级密度与留白**，不是换名字 |

**本体图的实测结论（当前代码）**：

```
46.30 → 69.25   (Δ +22.95, 683 ms)
规划 24 个 op，只活下来 3 个 —— 淘汰率 87.5%
spacing = 0、style = 0   修完仍然是 0（两个维度整条哑掉）
```

**根因不是"规则太少"，而是三件事**：
1. **门的可见域缺了全局布局这一维**：`Validator` 只守 7 个既有维度（`07_patch.js:50`），区域密度、留白、视觉层级**不在评分里** → 全局变差对它**不可见**，也就无从拦截。
2. **没有区域这一层数据**：源 SVG 里明明有 9 个语义区域（Header / 左栏 / 中央平台 / 右栏 / 底栏 / 图例…），`IR` 把它们拍平成 39 个孤立节点（`stats.groups = 1`）。
3. **"一次只动一个元素一小步"被制度化**：`claim()` 的 `owner` 约束每元素每轮只允许一个 op（`06_geometry.js:781-797`），这与"全局重排必须同时动一批元素"**结构性冲突**；承载全局重排的 `global_relayout` 是个**幽灵策略**（详见 R4）。

**方案的落点**：不重写引擎，而是**先补评分视野（阶段 A）→ 再让"方案"成为一等对象并打分择优（阶段 B）→ 然后才实现真正的区域重排（阶段 C）**。顺序不能颠倒：没有 A，B 和 C 的效果无法被门禁看见，做了也会被 `MIN_GAIN=0.05`（`07_patch.js:51`）当 Δ0 丢掉。

---

## 1. 交付物、复现与本文口径

### 1.1 复现命令（都可直接跑）

```bash
# 构建产物（只需 Python 标准库，不需要 node）
python build.py                 # 产出 svgb_beautifier.html
python build.py --check         # 只校验：源齐全 / 无残留外链
python build.py --verify        # 断言与磁盘产物逐字节一致（剥离 banner 时间戳）

# 端到端探针（需 .svgbuild/node_modules 内有 playwright-core + 本机 Edge）
export NODE_PATH="$PWD/.svgbuild/node_modules"      # PowerShell: $env:NODE_PATH
node tests/sweep_rule.cjs       # 全量样例 × rule 臂
node tests/smoke_svgb.cjs       # 单文件产物冒烟
SVGB_TARGET=svgb_beautifier.html node tests/edit_e2e.cjs
```

本次审计实测 `python build.py --check` → `OK 源齐全，14 段，内联 JS 1471140 字 / 1532161 B`；`--verify` → `OK 产物可复现`。磁盘产物 **7 139 行 / 1 615 965 B**。⚠️ `README.md:130` 写的是「7 425 行 / 1 578 008 B」，**已过期** 286 行 / 37 957 B（纳入阶段 G）。

### 1.2 装配顺序（决定了新模块能挂在哪）

`build.py` **没有**源文件清单，它按 `ui.html:418-431` 的 `<script src>` **文档顺序**内联（`build.py:67-79`、`88-89`）：

```
vendor/svgcanvas.min.js → 01_util → 02_runtime → 03_ir → 04_analyzer
→ 06_geometry → 05_laya        ← 注意 06 在 05 之前
→ 07_patch → 10_samples → 11_realsvgs → 08_ui → 09_editor → 12_palette → 13_codemode
→ ui.html 内联控制器 (432-1530)
```
新增模块（如 `src/14_plan.js`）只要插进这个列表就会被自动内联；但它必须排在 **`06_geometry.js` 之后、`07_patch.js` 之前**（下游是调用方）。

### 1.3 一处必须纠正的定位

`src/08_ui.js` **不是面板层**，它是非侵入叠加视图层（`Views`，`08_ui.js:23`）。Issue 面板 / Laya 决策 / Patch 台账 / 质量分 / 改动清单**全部在 `ui.html:432-1530` 的内联控制器里**（`const UI = {` 在 `ui.html:442`）。改 UI 要去 `ui.html`，不是 `08_ui.js`。

---

## 2. 现状：真实链路

### 2.1 链路拓扑（与你的"诊断 → 决策 → Patch → 评估"一致，但能力分布不同）

```
SVG 文本
  │  Runtime.load / normalize                    02_runtime.js:128-188
  ▼
IR.build（扁平语义模型）                           03_ir.js:39-199
  │   · 组→节点 / 形状+文字 / 边端点吸附
  │   · 无容器树、无区域、无语义角色表
  ▼
Analyzer.run（7 维评分 + 9 类 issue）              04_analyzer.js:39-74 / 361-428
  ▼
LayaDecide.run                                     05_laya.js:224-310
  │   · LayaRule.plan 产出 7 类问句                05_laya.js:73-159 / 163-211
  │   · 规则候选来自 issue.candidates（静态字符串）04_analyzer.js:370…
  │   · 后端不可用 → 逐位回退 rule；信息量门拦噪声  05_laya.js:260-299
  ▼
Geo.plan（按 issue 类型逐条产出 op）               06_geometry.js:750-1128
  │   · claim() owner：每元素每轮只准一个 op       06_geometry.js:781-797
  │   · canvasTail：唯一"整幅平移"算子             06_geometry.js:526-605
  ▼
Pipeline.beautify（逐批 apply → 重算 → 过门 → 回滚）07_patch.js:123-352
  │   · patch 不可逆，回滚 = 整档快照 rt.load      07_patch.js:204 / 242
  │   · op 级门 checkOp / 轮级门 check            07_patch.js:70-79 / 55-64
  ▼
结果 + 台账（round ledger / op ledger / editor track）
```

**关键结构性事实**：`Geo.plan` 是**局部算子库 + 全局测量前端**的混合体。真正"读全文档"的只有 6 处，而且都是**测量/校验**而非**求解**：`fontTiers`（`06:46-56`）、`evaluate` 的 style 分支（`06:157-169`）、`snapTargets`（`06:1565-1599`）、spacing 分支（`06:889-959`）、`routeEdge`（`06:1602-1693`）、`canvasTail`（`06:526-605`）。**没有任何全局重排求解器**，也没有任何自动布局算法（radial / tree / layered / force 全部不存在）。

### 2.2 你分析中的 8 条设计，逐条落到代码

| 你的设计 | 现状 | 已有基础（可复用） |
|:---|:---|:---|
| SVG Semantic Graph（Document → Section → Card） | ❌ **不存在**，IR 扁平（`03_ir.js:192-199`） | 组→节点吸收规则（`03_ir.js:87-97`）、`isBg` 满版底板判定（`03_ir.js:152`）、"最小包含者优先"归属（`03_ir.js:154-161`） |
| Layout Intelligence / 页面级规则（Figma Auto Layout） | ❌ 只有 `rowFamily` 能识别"一条横向等宽卡片带"（`06_geometry.js:1164-1199`：同 shape / 宽高 ±2 / 同顶边 ±3） | `R.union / area / gap / intersect`（`01_util.js:79-137`）、`routeEdge` 的占据栅格（`06:1617-1629`） |
| Density Score（区域密度） | ❌ 06 内无任何 density 指标；只有 Analyzer 的**全画布** `canvas`（`04:343-358`） | `freeSpace` 逐元素可动空间（`06:82-117`）、`ir.medArea`（`03:173`） |
| Whitespace Balance（负空间） | ❌ 不存在 | 同上 |
| Semantic Center Rule（中心节点占比） | ❌ 不存在 | `n.importance` 存在但 = **文本字数+1**（`03:169`），且**只被 `distribute_weighted` 用到**（`06:930/934`） |
| Connector Routing（避障路由） | ⚠️ **部分**：`routeEdge` 是真 A*（8px 栅格、4 向、转向罚 2.2、上限 20 万次扩展，`06:1602-1693`）—— 但它**只把节点当障碍，不把其它边当障碍**（`06:1622`），所以 edge-over-edge 交叉**永远修不掉**（Analyzer 仍在计 `edgeHits`，`04:287-308`） | 直接扩障碍集即可 |
| Visual Hierarchy Model（视觉权重） | ❌ 不存在（`importance` 只是文本长度） | `contrastRatio` / `lumaOf` / `colorDist` 已备好（`06:1828-1852`） |
| Design Intent（文档类型：架构图/流程图/海报） | ❌ 不存在分类。只有 5 个**风格键**（minimal/technical/enterprise/presentation/dense，`06:31-37`）和 `dialect = semantic|heuristic`（`03:81`）。风格只影响 `pad/gap/tier/lineGap` | `STYLE` 表可扩展为 `intent → style` |

---

## 3. 实测证据：本体图为什么"跑完了但没好"

### 3.1 样本与口径

* 样本：`real-onto_platform_architecture`（`src/11_realsvgs.js:49`），源文件 `svg/onto_platform_architecture.svg`（18 021 B / 224 行 / 46 rect / 62 text / 13 path）。
* 该样本在样例表里被标注为 **「真实图 · 标定域外（回归件：不得越改越丑）」**（`src/10_samples.js:363`）。
* 无 `data-role` → `IR.dialect = 'heuristic'`（`03_ir.js:81`）。
* 画布 1920×1080，典型**幻灯片式三栏版式**（左 360 + 中 920 + 右 324 + 顶栏 + 底栏）。
* 探针：`.svgbuild/onto_probe.cjs`（附录 A）。**`ui.html` 与 `svgb_beautifier.html` 两个目标的测量结果逐位相同**，说明结论描述的就是你手上那份产物。

### 3.2 测量结果

| 量 | 值 |
|:---|:---|
| 总分 | **46.30 → 69.25**（Δ +22.95，683 ms） |
| 规划 op / 采纳 op | **24 / 3（淘汰率 87.5%）** |
| 轮次 | 轮 1：采纳 3 / 淘汰 12；轮 2：采纳 0 / 淘汰 9 → 因"全部 op 被 op 级门淘汰"终止 |
| 维度 before | collision **46** · textFit 96 · alignment 44 · **spacing 0** · edgeRouting 90 · **style 0** · **canvas 0** |
| 维度 after | collision **96** · textFit 96 · alignment 76 · **spacing 0** · edgeRouting 100 · **style 0** · canvas 93 |
| issue 数 | **46 条**：misalignment 18 · spacing 8 · tiny_element 8 · overlap 4 · text_overflow 4 · occlusion 1 · canvas_margin 1 · edge_crossing 1 · style_inconsistency 1 |
| IR 统计 | nodes **39** · edges 10 · labels 62 · **groups 1** · decorations 8 · danglingEdges 0 |
| 画布 | contentBox `x=-0.5 w=1988.5` → 右边距 **−68px（内容出界）**，utilization 1.04 |

**读法**：修完分数涨了 23 分，但 **`spacing` 和 `style` 两个维度仍然死 0**。也就是说「一键美化」在这张图上的实际效果是：**修掉了重叠与遮挡、把画布拉回来了，但间距体系与样式体系统统没动**。这正是观感上"美化跑完了、格子还是乱的"的来源。

### 3.3 区域结构：源里存在，被 IR 丢掉

我把加载后的真实 DOM 层级剥掉包装层（`svgcanvas` 会把整份内容塞进一个 `<g>`，`#svgcontent` 下还有 `title/desc/defs`）后逐区域测量：

| 区域（DOM） | 语义（源码注释） | 成员节点 | 文字 | bbox (x,y,w,h) | 占画布 | 墨密度* | 留白* |
|:---|:---|---:|---:|:---|---:|---:|---:|
| `rect#svg_4` | Background | 1 | 0 | -0.5,-0.5,1921,1081 | 1.001 | 1.00 | 0 |
| `rect#svg_5` | 外框 | 1 | 0 | 53,47,1814,986 | 0.863 | 1.00 | 0 |
| `g#svg_8` | Top capability ribbon | 1 | 2 | 1217,77,568,84 | 0.023 | 1.00 | 0 |
| **`g#svg_12`** | Left: data/system ecosystem | 7 | 11 | 91,219,362,628 | 0.110 | **1.63** | 0 |
| **`g#svg_31`** | Center platform container | 19 | 21 | 499.5,195.5,921,683 | **0.303** | **2.66** | 0 |
| **`g#svg_72`** | Right side: applications | 7 | 11 | 1463,219,326,628 | 0.099 | **1.62** | 0 |
| `g#svg_102` | Bottom domain lane | 1 | 7 | 91,899,1698,92 | 0.075 | 1.00 | 0 |
| **`g#svg_115`** | Key relationship labels | 2 | 2 | 451.5,321.5,1011,43 | 0.021 | **0.09** | **0.908** |
| `g#svg_120` | Legend | 0 | 4 | — | 0 | 0 | 0 |

\* 口径：`墨密度 = Σ(成员节点 bbox 面积) / 区域 bbox 面积`。**嵌套容器会被重复计入**，所以 >1 是正常的 —— 只用于**区域之间的相对比较**。`留白 = 1 − min(1, 墨密度)`。

**证据链**：
* 源 SVG 里语义区域是**显式存在**的（`<!-- Header -->`、`<!-- Left: data/system ecosystem -->` … 与 `<g>` 一一对应，见 `svg/onto_platform_architecture.svg:47-222`）。
* 但 `IR` 只认出了 **1 个 group node**（`stats.groups = 1`），41 个容器组里绝大多数被"下钻"丢掉了（`03_ir.js:134`）。
* 你观察到的"中央过重 / 两侧空 / 图例那带几乎全空"是**可测的**：中央 0.303 占画布、墨密度 2.66；左 1.63 / 右 1.62；图例带留白 0.908。
* **但这些量一个都不在评分里**，所以"美化"看不见它们，也就无从改善。

### 3.4 op 级裁决：24 个 op 只活下来 3 个（含淘汰理由）

轮 1 完整裁决（`strategy / issue / 目标 / op 数 / 采纳 / 增益 / 理由`）：

| 策略 | issue | nOps | 采纳 | Δ | 淘汰理由（截断） |
|:---|:---|---:|:---:|---:|:---|
| `move_apart` | overlap | 2 | ✗ | −10.95 | 节点碰撞劣化 −54.0（96→42）、对齐劣化 −14.0 |
| `grow_spacing` | overlap | 2 | ✗ | −10.95 | **与 `move_apart` 逐字相同的理由与数值**（两者共用同一段 op 代码，`06:845-859`） |
| `global_relayout` | overlap | 2 | ✗ | −10.95 | 同上（幽灵策略，见 R4） |
| `distribute_equal` | spacing | 2 | **✓** | +4.65 | — |
| `distribute_equal` | spacing | 1 | ✗ | −0.9 | 未带来提升；对齐劣化 −6.0 |
| `distribute_weighted` | spacing | 5 | ✗ | −1.9 | 未带来提升；碰撞 −4.0、对齐 −6.0 |
| `snap_edges` | misalignment | 8 | **✓** | +4.80 | — |
| `snap_centers` | misalignment | 11 | ✗ | **0** | 未带来提升（68.25→68.25，Δ0） |
| `snap_edges` | misalignment | 6 | ✗ | **0** | Δ0 |
| `grow_to_min` | tiny_element | 8 | ✗ | **−22.9** | **节点碰撞劣化 −80.0（96→16）**、对齐 −22.0 |
| `move_text` | text_overflow | 10 | ✗ | **−24.8** | **节点碰撞劣化 −96.0（96→0）** |
| `wrap_text` | text_overflow | 2 | ✗ | −3.3 | 碰撞 −4.0、文本适配 −4.0、对齐 −10.0 |
| `resize_container` | text_overflow | 4 | ✗ | −13.3 | 碰撞 −50.0、对齐 −8.0 |
| `normalize_style` | style_inconsistency | **24** | ✗ | **−26.4** | **节点碰撞劣化 −96.0（96→0）**、文本适配 −12.0 |
| `orthogonal_reroute` | edge_crossing | 1 | **✓** | +1.00 | — |

轮 2 的 9 条与轮 1 的失败项**几乎逐条重复**（`distribute_weighted`、`snap_centers`、`snap_edges`、`grow_to_min`、`move_text`、`wrap_text`、`resize_container`、`normalize_style`），**全部再次被同一理由淘汰**，然后整轮终止。原因是 `reject` 黑名单**在每轮开头被重置**（`07_patch.js:167` 在 round 循环内声明），跨轮不记忆。

从这张表能读出 4 个可直接归因的缺陷（对应 §4 的 R1/R2/R3/R5）：

1. **批量原子化导致"自我踩踏"**：`move_text` 10 个 op 一起应用 → collision 96→0；`normalize_style` 24 个 op 一起应用 → collision 96→0。单看每个 op 都"不欠账"，**成批一起动就互相撞**。引擎的校验单元是"一条 issue 的完整修复动作"（`07_patch.js:196-203`），没有"逐 op 试跑 + 选子集"的能力。
2. **`tiny_element` 误判密集**：8 条 tiny 全是"有标签但面积 < 中位面积×0.35"（`04:419`）。在这张图上很可能包含图例色块、10×10 圆点这类**装饰件**；把 8 个一起放大 → collision 96→16。缺的是**语义角色**（装饰件 vs 数据节点）。
3. **Δ0 的无效重规划被反复烧**：`snap_centers` / `snap_edges` 产出 11 与 6 个 op，净收益恰好 0 → 被 `MIN_GAIN_OP = 0`（`07_patch.js:52`）判为"该批未带来提升"。这类 op 在候选阶段就该被预测淘汰，不该真的应用到 DOM 上再回滚。
4. **同义策略占位**：`move_apart` / `grow_spacing` / `global_relayout` 三条给出**完全相同的数字**，实际只有一份代码在跑（见 R4/R6）。Laya 的候选表里因此有 1/3 是幻觉。

### 3.5 基线不可比性（做回归前必须先解决）

工作区里存的旧扫描 `.svgbuild/sweep_now.json` 记录本样本为：

```
real-onto_platform_architecture   before 58.8  after 58.8  acc 0  rej 15  rounds 1
```

而今天实测是 `46.3 → 69.25`、`acc 3 / rej 21`、`2 轮`。**同一份 `ui.html`、同一个样本，数字不同**。

差异可以精确解释为遮挡项：

```
46.3 + 0.25 × (96 − 46) = 46.3 + 12.5 = 58.8        ← 逐位吻合
        └ collision 权重  └ 遮挡消解后 collision 46→96
```

即旧基线的 `before` 是**遮挡已被计入/已消解之后**的分数。我没有去 bisect 这一漂移由哪个提交引入（`cfccabd fix(occlusion)` 是强嫌疑），但结论是硬性的：

> ⚠️ `.svgbuild/sweep_now.json` 与 `.svgbuild/st3.json` 对本样本**与新代码不可比**。任何优化落地前，先重跑 `node tests/sweep_rule.cjs` 重建基线，否则"零回归"无法证明。

参照：22 个合成样例的三臂基线是可用的 —— `rule` 均值 **91.477 → 99.039**，`mix` 同为 **99.039**，`model` **98.964**（与报告 §9.4「采纳 0 次与 18 次结果同为 99.039」一致）。

---

## 4. 根因（R1–R6）

> 每条都给"证据 → 直接后果 → 归属阶段"。

### R1 · `IR` 没有区域层，全局布局无处安放
* **证据**：IR 返回 `{nodes, edges, texts, decorations, preserved, dialect, medArea, contentBox, opts, stats}`（`03_ir.js:192-199`）；纯容器组被丢弃（`03_ir.js:134`）；本样本 `stats.groups = 1`。唯一接近"分组"的是 `rowFamily`（`06:1164-1199`），判据是"同 shape / 宽高 ±2px / 同顶边 ±3px / 且自己也有 pad issue" —— **只能识别一条横向等宽卡片带**。
* **后果**：区域密度、区域留白、视觉层级、"中央过重"这类判断**没有输入数据**。你观察到的现象确实是缺陷，但引擎连"看见"它的资格都没有。
* **归属**：阶段 A（区域图）。

### R2 · 门的可见域决定了"能不能被拦住"，而全局布局不在其中
* **证据**：`Validator.GUARD = {collision:−1.0, textFit:−1.0, edgeRouting:−1.5, alignment:−3.0, spacing:−3.0, style:−3.0, canvas:−3.0}`（`07_patch.js:50`）；`MIN_GAIN = 0.05`（`:51`）；`checkOp` 只比这 7 个维度（`:70-79`）。UI 进度条直接遍历 `Analyzer.METRIC_KEYS`（`ui.html:1320`）。
* **后果**：**"整体布局变差"在当前架构里是不可表达的事件。** 一个 op 只要让 7 个维度不劣化就能过门；把中央区域塞得更挤、把两侧留得更空，7 个维度都可以纹丝不动。这是"局部规则正确但全局恶化"的**机制**，不是观感。
* **归属**：阶段 A（新维度 + 新守卫）—— **这是所有其他工作的前置**。

### R3 · 没有"候选方案"这个对象，`preview` 也不打分
* **证据**：候选是 issue 上的静态字符串（`04_analyzer.js:370/376/384/390/396/401/406/411/416/423`）；`Geo.evaluate` 返回的是**启发式偏好分**（如 `global_relayout` 固定 30 分，`06:148`），**不是预测的 before/after**；`Pipeline.preview` 返回 `{dec, pl}` **无 score**（`07_patch.js:86-90`）；`dryRun` 直接 `after: before`（`:151`）且 UI 明确写 After 留空（`ui.html:1298-1301`）。全仓库唯一的"假想位移 → 回喂 Analyzer 重算"钩子是 `alignErrWith`（`06:1209-1222`），但只服务对齐一个轴。
* **后果**：无法"生成多个优化方案 → 择优"。而且 §3.4 里 Δ0 的 17 个 op 之所以被真的应用到 DOM 上再回滚，就是因为**没有应用前的预测**。
* **归属**：阶段 B。

### R4 · `global_relayout` 是幽灵策略；`gate.relayout` 算了但从不读
* **证据链**（全部与实际代码核对过）：
  * 在 `Geo.LABEL`（`06:20`）显示为「整体重排」；
  * 在 `Geo.PHASES` 4 个列表里都有（`06:78`）；
  * 在 `Geo.evaluate` 里**只有桩**：`{score:30, detail:'整体重排：改动面最大', risky:true}`（`06:148`）；
  * 在 `Analyzer` 候选里给 overlap（`04:370`）；
  * 在 Laya 的 `fix_order` 选项里（`05:102`），且 `should_relayout=no` 时会被从 ranks 里剔除（`05:304`）；
  * **但 `Geo.plan` 的 `switch (g.type)`（`06:820-1109`）没有 `case 'global_relayout'`** → 落 `default: break`（`06:1109`）→ **0 个 op、0 个 skip** → 立刻触发顺位回退（`06:1112-1119`）。
  * `LayaDecide` 算出的 `gate = {relayout, safeAll}`（`05:307`）中，**`gate.relayout` 在 `06` 里从未被读取**（`06` 只用 `gate.safeAll`，见 `06:758`）。
* **后果**：§3.4 里 `move_apart / grow_spacing / global_relayout` 三条数字完全相同 —— 因为前两条共用同一段 op 代码（`06:845-859`，只换了 `g.key` 和标签），第三条什么都不做而回退到前两条。**候选表里 1/3 是幻觉，"整体重排"这个能力根本不存在。**
* **归属**：阶段 C。

### R5 · `claim()` 的"每元素每轮一个 op"与全局重排结构性冲突
* **证据**：`claim()` 用 `owner` Map 保证同一元素本轮只被一个 op 触碰，其余记 `skipped`（`06:781-797`，`06:793` 写 `'该元素本轮已被 … 占用'`）。文件头注释把这条定义为"防止越改越丑的核心约束"（`06:11-13`）。唯一绕过它的先例是 `canvas_margin`：用**同一个 itemKey 批量 claim**（`06:1073/1080/1086`），以及 `canvasTail` 这条独立算子（`06:526-605`，不经 Laya 决策、不经 claim）。
* **后果**：全局重排天然需要"同时动一批元素"，与该约束正面冲突。要么照 `canvas_margin` 用同一 itemKey 批量占位，要么照 `canvasTail` 走独立算子。
* **归属**：阶段 C（采用 `canvas_margin` 同 itemKey 的范式）。

### R6 · 无语义角色 + 标定域外，两件事叠加放大了误判
* **R6a 无语义角色**：`tiny_element` 判据是"有标签 + 面积 < 中位面积×0.35"（`04:419`）—— 完全不区分"数据节点"与"图例色块 / 分隔线 / 装饰圆点"。`n.importance` 只是**文本字数+1**（`03:169`）。
* **R6b 标定域外**：报告 §16.1 已记录「打分器标定域限于图谱式排版，不含 1920×1080 幻灯片式排版；6 张真实幻灯片图得分仅 58.8~70.25」。机制在代码里可见：
  * `STYLE` 预设字号档位是给小画布调的（`06:32-36`，如 `enterprise: tier [15,13]`），套到 1920×1080 的 `54/30/24/22/19px` 上等于"用便签字号排海报"。代码**已经知道**这件事，所以 `fontTiers` 改为文档内求（`06:40-56` 的注释直接点出 `real-05` 的失败）；
  * `Analyzer.DEF` 的 `fillPalette: 3` / `fontTiers: 2`（`04:28-29`）对幻灯片式的丰富配色与多级字号过严 → `style` 归零；
  * `cvSat: 0.6`（`04:21`）对三栏版式的间距变异系数过严 → 本样本 `spacingCv = 5.89`，`spacing` 归零。
* **后果**：`style` 与 `spacing` 两个维度在真实图上**恒为 0**，合计 0.25 的权重永久失效；`tiny_element` 8 条误判成批触发 → collision 96→16。
* **归属**：阶段 D（语义角色）+ 阶段 E（标定域 / 文档类型）。

---

## 5. 优化方案

### 5.0 目标态架构

```
                     SVG
                      │
              Runtime.load / normalize            02_runtime.js
                      ▼
              IR.build  ──────────────────┐
                      │                   │
        ┌─────────────┴──────────┐        │   ★ 新增
        ▼                        ▼        │
  RegionGraph.build        （既有 flat IR）│   RegionGraph：区域树 + 角色
  区域树 / 角色 / 权重          │         │
        │                        │        │
        └────────────┬───────────┘        │
                     ▼                    │
             Analyzer.run  ← ★ 新增 3 维（regionBalance / whitespace / hierarchy）
                     │                    │
        ┌────────────┴────────────┐       │
        ▼                         ▼       │
  LayaDecide.run            ★ Planner.candidates()
  （问句 + 信息量门）        每个 issue → 2~4 个「完整方案」
        │                         │       │
        └────────────┬────────────┘       │
                     ▼                    │
            ★ Planner.evaluate(plan)      │  snapshot → apply → 重建IR → 打分 → 回滚
              （复用 07_patch.js:204-244） │  与 alignErrWith(06:1209) 同源口径
                     ▼                    │
              ★ argmax + 守卫 → 入选方案    │
                     ▼                    │
                Geo.plan（既有 op 构造器 + ★ 区域重排）
                     ▼
          Pipeline.beautify（apply → 重算 → 过门 → 回滚）
                     ▼
              评分 / 台账 / Before-After
```

原则：**新增能力全部挂在既有接缝上，不重写引擎；每一步都单独可验收、可回滚。**

---

### 阶段 A（P0）· 区域图 + 三个新维度：让全局布局"可见"

> 没有这一步，后面所有工作都无法被门禁验证。**必须第一个做。**

**A1 · `RegionGraph`（新模块 `src/03b_region.js`，排在 `03_ir.js` 之后、`04_analyzer.js` 之前）**

从**渲染后的 DOM 容器层级**建区域树（而不是只从 flat IR 猜）：

```js
RegionGraph.build(ir, rt) -> {
  regions: [{
    id, dom, depth, parent,
    kind,            // 'frame' | 'band' | 'panel' | 'card' | 'cluster' | 'decoration'
    bbox,            // 区域内容 bbox（R.union of members）
    members: [nodeId], texts: [textId],
    inkArea,         // Σ 成员 bbox 面积（**排除被自己包含的成员**，修正附录 A 的口径缺陷）
    inkDensity,      // inkArea / area(bbox)
    whitespace,      // 1 − min(1, inkDensity)
    childRegions: []
  }],
  byNode: {nodeId -> regionId},   // 最小包含者优先
  issues: [...]
}
```

实现要点（全部有既有先例可抄）：
1. **包装层归一**：`#svgcontent` 下还有 `title/desc/defs`，且 `svgcanvas` 会把整份内容塞进一个 `<g>` —— 必须先按 `SKIP_INSIDE`（`03_ir.js:19-20`）过滤，再"只剩一个 `<g>` 就下钻"。（这是本次探针踩过的坑，见附录 A。）
2. **归属用"最小包含者优先"**：复用 `03_ir.js:154-161` 对自由文本已经采用的同一原则，避免嵌套容器重复吞并子节点。
3. **`kind` 判定**（纯几何，可回归）：
   * `frame`：面积 ≥ 85% 画布 → 复用 `isBg` 口径（`03_ir.js:149-152`，注意用**面积比**而非 `coverRatio`，注释已解释为什么）；
   * `band`：`aspect = w/h ≥ 6` 且 `h ≤ 12%·画布高`（顶栏 / 底栏 / 图例带）；
   * `panel`/`card`：`aspect ∈ [0.4, 4]`，且（成员 ≥ 2 或 成员 ≥ 1 且文字 ≥ 2）；
   * `decoration`：**无标签**且面积 < 画布 0.05% 且形状为 `rect/circle/ellipse` → 图例色块、分隔线、装饰点；
   * `cluster`：其余。
4. **区域语义命名（可选，低成本高收益）**：源 SVG 的分节 `<!-- … -->` 注释在加载后**完整保留在 DOM 里** —— 实测 `domCommentCount = 16 / srcCommentCount = 16`（**零丢失**），且其中 13 条就在版式根下的 **depth 0**（`Background` / `Header` / `Top capability ribbon` / `Left: data/system ecosystem` / `Center platform container` / `Right side: applications` / `Bottom domain lane` / `Key relationship labels` / `Legend` / `Footer` …），深层还有 `Ontology layer`（depth 2）；导出后仍为 16 条。因此直接读 `previousSibling` 的注释即可作为 `region.name`，给出 "Center platform container" 这样的可读标签。这比让模型猜"这是 Card4"便宜得多，也**完全确定性**。

**A2 · 三个新维度接入 `Analyzer`（`04_analyzer.js`）**

必须同时改 4 处，否则维度对门禁不可见（这是审计确认的硬契约）：

| 位置 | 改动 |
|:---|:---|
| `WEIGHTS`（`04:32`） | 重新配平，建议：`collision .22 / textFit .16 / alignment .12 / spacing .12 / edgeRouting .08 / style .07 / canvas .04 / regionBalance .10 / whitespace .05 / hierarchy .04`（Σ=1.00） |
| `METRIC_KEYS` + `METRIC_CN`（`04:34-35`） | 追加 `regionBalance`（区域均衡）、`whitespace`（留白分布）、`hierarchy`（视觉层级）；UI 进度条会自动跟随（`ui.html:1320`） |
| `run()` 的 metrics 组装（`04:46-65`） | 调用新 metric 函数 |
| `stateText()`（`04:431-449`） | 追加区域摘要行，供 Laya 的 state 文本使用 |

维度定义（保持文件既有的 `sc(d, sat) = 100·clamp(1 − d/sat, 0, 1)` 单调映射风格，`04:37`）：

* **`regionBalance`** —— 区域内"忙闲不均"。
  `d = (max − min) / max` 遍历所有 `panel/card` 区域的 `inkDensity`，`sat ≈ 0.55`。
  本样本预期立刻可见：中央 2.66 vs 左 1.63 / 右 1.62。
* **`whitespace`** —— 留白是否落在可读带内（过低 = 拥挤，过高 = 空旷）。
  对每个 `panel/card` 区域算 `w = whitespace`；`d = Σ penalty(w) / n`，
  `penalty(w) = clamp((0.22 − w)/0.22, 0, 1) + clamp((w − 0.62)/0.38, 0, 1)`；`sat = 0.6`。
  本样本预期：图例带 `w = 0.908` → 触发"空旷"。
* **`hierarchy`** —— 语义重要性排序与视觉权重的**秩一致性**。
  视觉权重 `V(r) = 面积占比 × 平均字号档位 × 对比度`；语义重要性 `S(r)` 用（存在语义注释名 ? 2 : 0）+ 子节点数 + 标题档文字数。
  `d =` 区域内 `(S, V)` 的**逆序对比例**；`sat = 0.5`。
  这直接对应你的「Rule 3 · Semantic Center Rule」：中央本体块 `S` 高、`V` 也高是**对的**；错的是两侧 `S` 中而 `V` 被压到很低。

**A3 · 新维度必须进守卫（`07_patch.js:50`）**

```js
GUARD: { …, regionBalance: -2.0, whitespace: -2.0, hierarchy: -2.0 }
```
阈值取比 `spacing/style`（±3.0）略紧：这两维是"新引入、先保守"。**不加进 `GUARD`，新维度对 op 门完全无效。**

**A4 · 新 issue 类型 `region_imbalance`（注意注册契约，见 §6）**

```js
// Analyzer.issues() 追加
add('region_imbalance', [worstRegion.id], sev, evidence, ['reflow_region', 'expand_region', 'keep_region']);
```
优先级建议：`max−min > 0.5` → `high`；`whitespace > 0.75 或 < 0.12` → `medium`。

**A 阶段验收**
* 干净样例仍**恰好 100 分、0 issue** —— 沿用报告 §4 的自洽性锚点（5 个 clean 样例）。这是防止新维度"自伤"的第一道闸。
* 本体图：`regionBalance / whitespace / hierarchy` 三项非满分，且**区域排序与 §3.3 的表一致**。
* `python build.py --check` + `--verify` 通过；`node tests/sweep_rule.cjs` 全量**零回归**（先按 §3.5 重建基线）。

---

### 阶段 B（P0）· 候选方案一等公民 + 打分择优

**B1 · 新模块 `src/14_plan.js`（排在 `06_geometry.js` 之后、`07_patch.js` 之前）**

```js
const Planner = {
  /* 每个 issue 产出 2~4 个「完整方案」，而不是 1 个策略 */
  candidates(ir, an, dec, sopt) -> [{
    id, label, rationale,
    kind,            // 'local' | 'regional' | 'global'
    ops: [Op],       // 复用 Geo.mk() 的 op 形状（06:798-799）
    claims: [nodeId],
    predicted: null  // 由 evaluate 填
  }],

  /* 真实打分：snapshot → apply → 重建 IR → Analyzer.run → 回滚 */
  evaluate(rt, ir, an, plan, sopt) -> { score, metrics, delta, reasons, costMs },

  /* 择优：argmax + 守卫 + 预算 */
  select(scored, an, budget) -> { picked, rejected, reason }
};
```

**关键实现事实（决定这一阶段是"廉价"还是"昂贵"）**：
* `Planner.evaluate` **不需要新机制** —— `07_patch.js:204-244` 已经在做这件事：`preSvg = rt.exportString()` → `Patch.applyAll(batch)` → `IR.build` / `Analyzer.run` → `rt.load(preSvg)`。把它抽成可复用函数即可。
* `alignErrWith`（`06:1209-1222`）提供了**不碰 DOM 的预测**范式（假想位移后的浅拷贝节点表回喂 `Analyzer`），可用于**廉价预筛**，只对通过预筛的 top-K 做真打分。
* **成本预算**（用本次实测反推）：本体图整轮 24 步 / 683 ms ≈ **28 ms/步**；小样例 3.5~9 ms/步。所以 `Planner.evaluate` 的预算是**每 issue 最多 K=3 个方案**，全局每轮总评估次数上限（建议 24），超预算退化为现状的单方案路径。
* **必须保持确定性**：顺序固定（不依赖 `Object.keys` 的插入序抖动）、平局用固定 tiebreak（如 `id` 字典序），否则"可回归"失效。

**B2 · 与既有 Laya 的分工（不要重叠）**
* Laya 继续管**离散决策**（`dominant_issue / fix_order / style / severity / should_relayout / safe_to_auto_fix`，`05:86-138`）—— 那是它的强项（`dominant_issue` 是唯一有信息的信号，conf 0.872 / spread 5.76，`05:238-244`）。
* `Planner` 管**方案层择优**（连续、可算、可验证）。
* 明确**不让 Laya 输出坐标**（这一条现有代码已经守住了，`05:1-14` 的职责边界注释值得保留）。

**B3 · 先消灭 §3.4 里的 Δ0 浪费**
在 `Planner.select` 里对"预测净收益 ≤ 0"的方案**直接不入选**，而不是应用后再回滚。这一步单独就能把本体图的无效 DOM 抖动（`snap_centers` 11 op、`snap_edges` 6 op，净 Δ0）省掉。

**B 阶段验收**
* 本体图：轮 2 的"重复失败重规划"消失或显著减少（用 `ledger[].steps[].reasons` 断言）。
* Δ0 批次数 → 0（断言 `steps[].gain === 0 && accept === false` 的数量为 0）。
* 全量样例 `sumDelta` **不低于**基线（沿用报告 §18 的 `sumDelta` 口径）。
* 每轮 `Planner.evaluate` 调用次数 ≤ 预算（写进 ledger 供断言）。

---

### 阶段 C（P1）· 打通幽灵策略：真正的区域重排

**C1 · 由预测驱动**：`reflow_region` 只在 A 阶段的 `regionBalance` / `whitespace` 判为 `high` 时进入候选。

**C2 · op 构造器 `Geo.reflowRegion(region, st)` —— 建议按 `canvasTail` 而非 issue 机制接入**

理由（R5）：`claim()` 的 owner 约束与"同时动一批元素"冲突。`canvasTail`（`06:526-605`）是**已被验证的绕过先例**：不经 Laya 决策、不经 claim、在 `07_patch.js:214`（批内）与 `:284`（轮末）被直接调用。区域重排按同一范式接入，风险最低。

```js
Geo.reflowRegion(ir, region, st) -> { ops: [Op], dbg }
```
算法规格（**必须是可以写完的确定算法，不是"让模型想想"**）：
1. **只在区域内重排**：以 `region.bbox` 为可用域（不移动区域本身，避免破坏幻灯片三栏版式 —— 这正是你担心的"坐标调整破坏语义关系"）。
2. **候选版式**（每个区域给 2~3 个，交 `Planner` 打分）：
   * `stack`：成员按原有阅读序（先 y 后 x）左对齐纵排，`gap = st.gap`；
   * `grid`：按成员数选 1×n / 2×k / n×1，等距对齐到列/行中心；
   * `distribute`：保留成员相对次序，只在主轴方向等分（等价于现有 spacing 分支 `06:889-959`，但**以区域为单位**而不是以 Analyzer 的行/列聚类为单位）。
3. **不变式（硬约束，违反即返回 `null`）**：
   * 每个成员平移后**仍在 `region.bbox` 内**（±0.5px 容差，沿用 `_nudgePlan` `06:680` 的口径）；
   * 不与区域内其它成员产生**新的**碰撞（`wouldCollide`，`06:124-134`）；
   * 不改变成员的**尺寸**与**层级序**（只动位置）；
   * 不移动 `frame` / `band` / `decoration` 类成员（保护版式骨架与图例）。
4. **每个 op 必须带 `preview.before/after`**，否则 `proposed` 视图看不到（`08_ui.js:179-201`），`UI.opSig` 也依赖稳定的 `strategy|label`（`ui.html:1103`）。

**C3 · 同时修掉两个"看起来有、其实没有"**
* `Geo.evaluate` 里 `global_relayout` 的桩（`06:148`）换成真实分支，或**直接从候选表里删掉**（`04:370`）—— 二者取一，不要留第三种状态。
* `grow_spacing` 与 `move_apart` 共用同一段代码（`06:845-859`）。要么让 `grow_spacing` 真的做"整组扩间距"，要么删掉。**候选表里有幻觉比缺候选更糟**：它会让 Laya 的 ranks 失真。

**C 阶段验收**
* 本体图：`regionBalance` 提升，且**中央区域 bbox 与三栏位置不变**（断言区域 bbox 平移量为 0）。
* 新增反例保护：把 `reflow_region` 在"干净但区域密度天然不均"的样例上必须**返回 0 个 op**（例如一个刻意做成"左图右注"的合法版式）。
* `python build.py --verify` 通过（构建可复现性不能被破坏）。

---

### 阶段 D（P1）· 语义角色层：让 `tiny_element` 不再误判

**D1 · 给节点加 `role`（`03_ir.js`）**

```js
n.role = 'data' | 'container' | 'decoration' | 'swatch' | 'icon' | 'label' | 'lane'
```
判定优先级（确定性，按序短路）：
1. 有 `data-role` → 直接用（方言优先，与 `03_ir.js:81` 一致）；
2. `isBg`（`03:152`）→ `container`；
3. 在 `RegionGraph.kind === 'decoration'` 区域内且**无标签** → `decoration`；
4. 无标签 + 面积 < 画布 0.02% + 在 `band`/`panel` 内成组出现 → `swatch`（图例色块）；
5. 有标签 + 面积 ≥ 中位面积 → `data`；
6. 其余 → `label`。

**D2 · `tiny_element` 只在 `role ∈ {data, label}` 上触发**（改 `04:419`）

本样本的 `tiny_element` 8 条里，图例色块（`g#svg_115`，`whitespace 0.908`，几乎无墨）与 10×10 装饰点应立即被排除 —— §3.4 里 `grow_to_min` 的 **collision 96→16（Δ−80）** 正是它们造成的。

**D3 · 用真正的视觉权重替换 `n.importance`（`03:169`）**

```js
n.importance = wSemantic(role, depth, labelTier) × wPosition(regionCentrality) × wContrast(contrastRatio) × wSize(sqrt(area)/diag)
```
保持"全为正、量纲无关、可回归"；`distribute_weighted`（`06:934`）会自动受益。

**D 阶段验收**
* 本体图 `tiny_element` 条数**显著下降**（预期从 8 降到 ≲2，仅剩真正过小的数据节点）。
* 干净样例仍 100 分。
* `grow_to_min` 不再出现 `collision` 崩塌（断言该策略的 `Δcollision ≥ −5`）。

---

### 阶段 E（P1）· 设计意图 / 文档类型，修复标定域

**E1 · 文档类型分类（新 issue 无关的小模块，或并入 `RegionGraph`）**

```js
intent = classify(ir, rg) -> 'diagram' | 'slide' | 'flowchart' | 'dashboard' | 'illustration'
```
判据（确定性）：
* `slide`：画布近似 16:9 / 4:3，且存在 ≥1 个 `frame` + ≥2 个 `panel` 且区域数 ≥ 4；
* `diagram`：节点数 ≥ 6，边 ≥ 2，区域数 ≤ 2；
* `flowchart`：边 ≥ 节点数 × 0.8 且存在明显主轴；
* `illustration`：无 `data` 角色节点或文字极少；
* 兜底 `diagram`。

**E2 · 让标定参数按 `intent` 取值（不要一套阈值打天下）**

| 参数 | 位置 | `diagram`（现状） | `slide`（建议） |
|:---|:---|:---|:---|
| `styleSat` | `04:26` | 0.5 | 0.75（幻灯片配色天然更丰富） |
| `fillPalette` | `04:28` | 3 | 6 |
| `fontTiers` | `04:29` | 2 | 4（标题/副标题/正文/注释） |
| `cvSat` | `04:21` | 0.6 | 1.6（三栏版式行内间距变异天然大） |
| `alignTol` | `04:20`、`04:44` | 现有自适应 | 保持，但**按区域**聚簇而非全画布 |
| `STYLE` 档位 | `06:31-37` | 小画布像素 | `slide` 直接用文档内 `fontTiers`（`06:46-56` 已有此能力，只是未被风格层采纳） |

> ⚠️ **不建议**用 Laya 做这个分类。理由：报告已证明模型在本基准上无正向增益（§9.3），而文档类型是**纯几何可判**的；把它交给模型会引入不可回归的随机性。
> 这也回答了你"最关键的改进：引入设计意图"——意图应该**先从几何可判的部分入手**，而不是先训练模型。

**E3 · `intent` 参与风格选择**（改 `05:107-119`）：把现在写死的 `+25/+15/+20` 打分改为"intent → 风格先验"，并**记录到台账**，让决策可审计。

**E 阶段验收**
* 6 张真实幻灯片图（`real-01..05` + `real-onto_platform`）的 `style` / `spacing` **不再恒为 0**。
* `diagram` 域样例分数**不下降**（防"为新域牺牲旧域"）。
* 干净样例仍 100 分。

---

### 阶段 F（P2）· 连线与策略语义修正

* **F1 · `routeEdge` 把其它边当障碍**：`06:1622` 只遍历 `ir.nodes` 构造占据栅格。加入"其它边的折线按 `clear` 膨胀"后，`orthogonal_reroute` 才有机会真正消除 edge-over-edge 交叉（Analyzer 一直在计 `edgeHits`，`04:287-308`）。注意预检只测前 6 条边（`06:487`），需要一并放宽或明确记录"其余边不预检"。
* **F2 · `evReroute` 的 6 条上限**：要么提高，要么在 `detail` 里显式声明"仅前 6 条"，避免决策层以为全覆盖。
* **F3 · 遮挡的不透明判定**：⚠️ **本条已在实现阶段被实测证伪，方向写反了。** 原文写"`normColor` 把渐变/命名色一律视为不遮挡（漏检）"，实测相反：`normColor('url(#gPurple)')` 返回 `'url(#gpurple)'`、`normColor('red')` 返回 `'red'`，**都是 truthy**，即渐变与命名色一直被当作**不透明遮挡源**，不存在系统性漏检。实测本体图 6 个渐变的 `stop-opacity` 全为空（完全不透明），全图无 `fill-opacity < 1`，所以把它当不透明是**正确**行为。真正的缺陷是另一个：**悬空**引用 `url(#nonexistent)` 也返回 truthy，被当成遮挡源 → 凭空报出遮挡（SVG 中解析不到 paint server 的元素根本不被绘制）。修复见 `svgb_layout_repair_design-v1.md` §0.1 更正1。

---

### 阶段 G（P2）· 工程收尾缺陷（审计发现，独立可做）

| # | 缺陷 | 位置 | 建议 |
|:--|:---|:---|:---|
| G1 | **`Patch.applyAll` 返回值被丢弃** → 主批次的 `op.apply` 异常被吞；`'apply 抛错'` 这一步理由实际只能来自 `IR.build`/`Analyzer` 抛错 | `07:209` | 接住 `{applied, errors}`，把 errors 写进 `steps[].reasons` |
| G2 | **`rec.ops` 语义错**：记录的是**本轮第一步的计划**（含被 `opAllow` 拒绝、被门淘汰的 op），不是实际生效集 | `07:265` | 要么改名（`plannedOps`），要么改为记录 `steps` 里 accept 的 op |
| G3 | **跨轮不记忆失败**：`reject` 黑名单在每轮开头重置 → 同一批次被反复重规划（本体图轮 2 整轮复现轮 1 的失败） | `07:167`、`07:181/245` | 把 `reject` 提升到 round 循环之外（或在轮末把 `rejectedKeys` 合并进下一轮入参） |
| G4 | **`dryRun` 的 `proposed` 是死变量** | `07:145` / `07:150-151` | 删除，或补进返回值 |
| G5 | **`_resolveOcclusions` 静默吞掉单个 op 失败** | `07:114` | 至少记进台账（这是"正确性缺陷强制先行"的路径，不该无声） |
| G6 | **README 尺寸过期** 286 行 / 37 957 B | `README.md:130` | 更新为 7 139 行 / 1 615 965 B |
| G7 | **改动清单签名由 `strategy\|label` 派生**，label 变了 deny 就失效（fail-open） | `ui.html:1103`、`1099-1101` | 加稳定 `opId`（由 `gateKey + 目标 id` 生成），label 只作显示 |
| G8 | **`.svgbuild` 基线不可比**（§3.5） | `.svgbuild/sweep_now.json` | 先重建基线，并在基线文件里记录代码指纹（见 §7.3） |

---

## 6. 注册契约：新增任何 issue 类型 / 策略时的必改清单

审计确认策略 id 的**唯一来源是 `Analyzer.issues()` 的候选数组**，而它要被真正执行，必须同时出现在 6 个地方。**漏任何一处都会静默失效**（`global_relayout` 就是漏了第 4 处的活标本）：

| # | 必改位置 | 漏掉的后果 |
|:--|:---|:---|
| 1 | `Analyzer.issues()` 的 `candidates` 数组（`04:370/376/384/390/396/401/406/411/416/423`） | Laya 不会为该类型生成 `strategy_<type>` 问句（`05:144-153`） |
| 2 | `Geo.evaluate()` 的 `'<type>:<key>'` 分支（`06:137-177`） | 落 `default {score:50}`，排序失真 |
| 3 | `Geo.LABEL`（`06:18-28`） | UI 只显示裸 id（`05:148`） |
| 4 | **`Geo.plan()` 的 `switch`（`06:820-1109`）** | **0 op → 顺位回退（`06:1112-1119`）→ 幽灵策略** |
| 5 | `Geo.PHASES` **全部 4 个列表**（`06:74-79`） | `phase.indexOf(type) = −1` → 该组排到最前（`06:776-778`） |
| 6 | （若引入新维度）`Analyzer.WEIGHTS/METRIC_KEYS/METRIC_CN`（`04:32-35`）+ `Validator.GUARD`（`07:50`） | 新维度对门禁不可见，收益被 `MIN_GAIN=0.05` 当 Δ0 丢弃 |

另外两条约束：
* **`claim()` 批量占位**：一次要动多个元素的策略，必须用**同一 `itemKey`** 批量 claim（范例 `06:1073/1080/1086`），否则被 owner 拆散。
* **op 必须带 `preview.before/after`**，否则 `proposed` 视图空白（`08_ui.js:179-201`）。

---

## 7. 验收与回归方案

### 7.1 复用既有门（不要另起一套）

```bash
export NODE_PATH="$PWD/.svgbuild/node_modules"
node tests/sweep_rule.cjs            # 全量样例 × rule 臂，与基线矩阵逐条对照
node tests/smoke_svgb.cjs            # 单文件产物：零 pageerror / 零失败请求 + 四视图不改内容 sha256
node tests/contain_audit.cjs real-01 # 「文字越出容器」的用户可见事实审计（与分数无关）
SVGB_TARGET=svgb_beautifier.html node tests/edit_e2e.cjs   # 编辑闭环不被破坏
python build.py --check && python build.py --verify
```

**注意**：`tests/` 里的脚本**失败时退出码仍是 0**（只有致命异常才非零，`edit_e2e.cjs:694`）。CI 必须**解析 JSON**，不能看退出码。

### 7.2 必须新增的断言（每条对应一个阶段的验收）

| 断言 | 目的 | 归属 |
|:---|:---|:---|
| 5 个 clean 样例**恰好 100 分 / 0 issue** | 防止新维度自伤（报告 §4 的锚点） | A |
| 本体图的区域排序 == §3.3 表 | 区域图正确性 | A |
| `regionBalance/whitespace/hierarchy` 在干净样例上满分 | 新维度不误报 | A |
| Δ0 批次数量 == 0 | 消灭无效重规划 | B |
| 每轮 `Planner.evaluate` 调用数 ≤ 预算 | 成本可控 | B |
| 区域重排后**区域 bbox 平移量 == 0** | 不破坏版式骨架 | C |
| "合法但密度不均"的反例 → `reflow_region` 产出 0 op | 防止过度重排 | C |
| `tiny_element` 条数下降且 `grow_to_min` 的 `Δcollision ≥ −5` | 语义角色生效 | D |
| 6 张真实幻灯片 `style/spacing ≠ 0`，且 `diagram` 域分数不降 | 标定域扩展不牺牲旧域 | E |

### 7.3 基线卫生（来自 §3.5 的教训）

`tests/sweep_rule.cjs` 现在把结果与 `.svgbuild/st3.json` 对照（脚本头 `1-4`）。建议给基线文件加**代码指纹**：

```json
{ "fingerprint": { "artifactSha256": "…", "segments": 14, "gitRev": "…" },
  "matrix": { "rows": [ … ] } }
```

跑对照时指纹不匹配就**报错而不是静默比较** —— 否则会重演"58.8 vs 46.3 却当成同一基线"的情况。

---

## 8. 风险、取舍与明确不做的事

| 项 | 判断 |
|:---|:---|
| **最大风险：新维度引起误报** | 缓解：A 阶段以"clean 样例恰好 100 分"为硬闸；新维度守卫阈值先取保守（−2.0） |
| **第二风险：`Planner.evaluate` 把成本炸掉** | 缓解：K=3 + 每轮总预算上限 + 廉价预筛（`alignErrWith` 范式，`06:1209-1222`）；超预算退化为单方案路径 |
| **第三风险：区域重排破坏版式** | 缓解：只在 `region.bbox` 内动、不动 `frame/band/decoration`、硬断言"区域 bbox 平移量 == 0" |
| **不确定性：`RegionGraph` 的 `kind` 阈值** | `band` 的 `aspect ≥ 6 / h ≤ 12%`、`decoration` 的 `< 0.05% 画布` 都是**初值，需要 sweep 定标**（项目已有 sweep 传统，`tests/sweep_rule.cjs`）。不要拍脑袋定死 |
| **不做：让 Laya 输出坐标** | 现有职责边界（`05:1-14`）是对的，保留 |
| **不做：引入 ELK / dagre 等布局库** | 本项目零依赖（`build.py` 只用 Python 标准库，产物单文件）。引入布局库会破坏"单文件、零依赖"的交付形态。区域重排（阶段 C）以确定性几何实现 |
| **不做：先做 finetune** | 报告 §16.2 P0 已列为方向，但**必须先有阶段 A/B**：没有可回归的评分视野，finetune 无法证明增益（这正是 §9.3 记录"模型无正向增益"的原因） |
| **不做：重写引擎** | 所有改动都挂在既有接缝（`Analyzer` 维度表、`Geo.evaluate`/`Geo.plan`、`Pipeline.preview`、`canvasTail` 范式） |

---

## 9. 排期与依赖

| 阶段 | 优先级 | 依赖 | 规模 | 主要产出 |
|:---|:---:|:---|:---:|:---|
| **A · 区域图 + 3 维 + 守卫** | **P0** | 无 | **L** | `src/03b_region.js`；`04_analyzer.js`（+3 维、+`region_imbalance`）；`07_patch.js:50` |
| **B · 候选方案 + 打分择优** | **P0** | A（否则无法验证） | **L** | `src/14_plan.js`；`07_patch.js` 抽出可复用的 apply/score/rollback |
| **C · 区域重排（真 `global_relayout`）** | P1 | A + B | **M** | `Geo.reflowRegion`；`06_geometry.js` switch / `evaluate`；删幻影候选 |
| **D · 语义角色层** | P1 | A（用区域 kind） | **M** | `03_ir.js` `n.role`；`04:419` 收窄；`n.importance` 重定义 |
| **E · 设计意图 / 标定域** | P1 | A | **M** | `classify()`；`Analyzer.DEF` 按 intent；`05:107-119` |
| **F · 连线与策略语义** | P2 | — | **S** | `routeEdge` 障碍集；`grow_spacing` 分家 |
| **G · 工程收尾** | P2 | — | **S** | G1–G8，可并行、可独立提交 |

**建议的最小可交付路径**：`A → B → C`。做完这三步，"一键美化"才第一次具备"理解布局 → 评估 → 生成多个方案 → 择优"的能力，也就是你分析里说的从"自动格式化"进入"AI 设计辅助"。

---

## 附录 A · 本次实测探针与原始数据

**探针**：`.svgbuild/onto_probe.cjs`（区域 + 评分 + op 裁决）与 `.svgbuild/comment_probe.cjs`（注释保留性核查）—— 均为 scratch，`.svgbuild/` 已被 `.gitignore` 排除，**不是交付物**。作用是：加载样本 → 剥包装层测区域 → `IR.build`/`Analyzer.run` → 跑一次 `Pipeline.beautify(rule)` → 逐条导出 op 裁决。

```powershell
$env:NODE_PATH=".svgbuild\node_modules"
node .svgbuild/onto_probe.cjs                              # 目标 ui.html
$env:SVGB_TARGET="svgb_beautifier.html"; node .svgbuild/onto_probe.cjs   # 目标产物
node .svgbuild/comment_probe.cjs                           # 注释保留性（A1.4 的依据）
```

**两个目标测量结果逐位相同**：`46.3 → 69.25`、`3/24`、`2 轮`、`683 / 679.5 ms`、`regions 9`、`errs []`。

**探针踩过的两个坑（写进方案以免重犯）**：
1. `Runtime.contentGroup()` 返回 `#svgcontent`，其子元素是 `title/desc/defs/g` —— 必须过滤 `SKIP_INSIDE` 后再"只剩一个 `<g>` 就下钻"，否则整张图会被当成**一个**区域。
2. 区域 `inkDensity` 若直接累加成员面积，**嵌套容器会被重复计入**（因此出现 >1 的值）。阶段 A 的正式实现必须**排除被自己包含的成员**（类似 `Analyzer.collision` 的 `coverRatio ≥ 0.95` 豁免口径，`04:85`）。

**原始汇总**（节选，完整 JSON 可由探针复现）：

```
before.score 46.3  metrics {collision 46, textFit 96, alignment 44, spacing 0,
                           edgeRouting 90, style 0, canvas 0}
beauty.after 69.25 metrics {collision 96, textFit 96, alignment 76, spacing 0,
                           edgeRouting 100, style 0, canvas 93}
counts {occlusion 1, overlap 4, canvas_margin 1, edge_crossing 1, spacing 8,
        text_overflow 4, misalignment 18, style_inconsistency 1, tiny_element 8}
stats  {nodes 39, edges 10, labels 62, groups 1, decorations 8, dialect heuristic}
margins {l -0.5, t -0.5, r -68, b -0.5}   utilization 1.04
spacingCv 5.89   alignError 152.5   spacingGroups 12   alignClusters 18
```

---

## 附录 B · 行号索引（结论 → 证据）

| 结论 | 证据 |
|:---|:---|
| IR 扁平、无区域 | `03_ir.js:134`、`192-199`；实测 `stats.groups = 1` |
| 满版底板口径（用面积比而非 coverRatio） | `03_ir.js:149-152` |
| 小面积优先归属（可复用于区域归属） | `03_ir.js:154-161` |
| `importance` 只是文本字数 | `03_ir.js:169` |
| 7 维评分与权重 | `04_analyzer.js:32-35`、`67` |
| 标定常数（`fillPalette/fontTiers/cvSat`） | `04_analyzer.js:16-30` |
| `canvas` 只做全画布 | `04_analyzer.js:343-358` |
| issue 模型与候选表（策略 id 唯一来源） | `04_analyzer.js:361-428`；`370/376/384/390/396/401/406/411/416/423` |
| `tiny_element` 只看面积 | `04_analyzer.js:419` |
| Laya 职责边界 / 信息量门 / 实测无增益 | `05_laya.js:1-14`、`238-259`、`281-284` |
| `gate = {relayout, safeAll}` | `05_laya.js:301-307` |
| 风格只影响 pad/gap/tier | `06_geometry.js:31-37` |
| `global_relayout` 幽灵（evaluate 桩 / PHASES / 无 case） | `06:20`、`74-79`、`148`、`820-1109`（`default` 在 `1109`）、`1112-1119` |
| `gate.relayout` 从未被 06 读取 | `05:307` 产出；`06:758/774` 只用 `safeAll` |
| `move_apart` 与 `grow_spacing` 同代码 | `06:845-859` |
| owner 独占（反全局） | `06:781-797` |
| 批量 claim 范例 | `06:1073/1080/1086` |
| `canvasTail` 是唯一整幅算子、绕过决策 | `06:526-605`；调用点 `07:214`、`07:284` |
| `alignErrWith`（假想位移→回喂 Analyzer） | `06:1209-1222` |
| `routeEdge` 只把节点当障碍 | `06:1617-1629`（`1622` 只遍历 `ir.nodes`） |
| `wrapText` 上限 5 行 | `06:1784` |
| patch 不可逆、回滚=快照重载 | `07:16-27`、`204`、`242`、`305`、`327` |
| 守卫与两个门 | `07:50`、`51`、`55-64`、`70-79` |
| `preview` 不打分 | `07:86-90`、`151` |
| 批次原子单元 = 一条 issue | `07:196-203` |
| `reject` 每轮重置 | `07:167` vs `07:181/245` |
| `applyAll` 返回值被丢弃 | `07:209` |
| `rec.ops` 语义错 | `07:265` |
| UI 面板全在 ui.html | `ui.html:442`、`361-414`、`1343-1466` |
| 改动清单签名与 deny 流 | `ui.html:1103`、`1105-1109`、`1178`、`796` |
| 新维度需进 `METRIC_KEYS` 才能被 UI 显示 | `ui.html:1320` |
| 装配顺序（06 在 05 之前） | `ui.html:418-431`；`build.py:67-79`、`88-89` |
| README 尺寸过期 | `README.md:130` vs 实测 7 139 行 / 1 615 965 B |
| 测试失败退出码仍为 0 | `edit_e2e.cjs:694` |
| 真实图标注为标定域外 | `src/10_samples.js:363` |

---

*本文档为只读分析产物；未修改任何源码、样例或 SVG。实测数据可由附录 A 的命令原样复现。*
