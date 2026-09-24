# svgedit × Laya · SVG 美化与修正产品实现报告

> 目标：**借助 svgedit 的解析能力和 Laya 的局部判断能力，完成 SVG 图片的美化和修正。**

本报告的全部数字来自真实浏览器（无头 Edge）+ 真实 `@svgedit/svgcanvas@7.4.2` + 真实 Laya 服务（`http://127.0.0.1:8771`，RTX 3080）的端到端跑批，可由 `tests/*.cjs` 重跑复现。无一处估算值。

> **v1.5（本目录独立为子项目）**：`labs/svgb` + `vendor` + `tools` + `svgb_beautifier.html` 已统一迁入本目录，
> 并成为**自带 `.git` 的独立仓库**。下面 §0 的路径已同步为新布局；迁移的完整记录与零回归证据见 **§20**。

## 0. 交付物与复现命令

| 产物 | 路径 | 说明 |
|:---|:---|:---|
| 产品页（源码形态） | `ui.html` | 1 458 行 / 79 569 B，直连 `vendor/svgcanvas.min.js` + `src/*.js`，可调试 |
| **产品页（单文件）** | `svgb_beautifier.html` | 7 425 行 / 1 578 008 B，由 `build.py` 内联全部依赖，双击即用 |
| 核心实现 | `src/01_util.js` … `11_realsvgs.js` | 11 个模块，共 384 990 B，见 §2 |
| 开发验证台 | `dev.html` | 全量矩阵 + 往返 + 锚点探针页 |
| 端到端探针 | `tests/edit_e2e.cjs` / `edit_ux2.cjs` / `edit_multi.cjs` / `edit_cancel.cjs` / `open_probe.cjs` / `smoke_svgb.cjs` / `sweep_rule.cjs` / `contain_audit.cjs` | 无头 Edge 驱动；历史探针归档于 `.svgbuild/`（未入库），可重建 |

```bash
# 重新构建单文件产物（仅需 Python 标准库，不需要 node）
python build.py                 # 产出 svgb_beautifier.html
python build.py --check         # 只校验源是否齐全 / 是否残留外链
python build.py --verify        # 断言产物与磁盘那份逐字节一致（可复现性）

# 重跑全部端到端验证（需 .svgbuild/node_modules 内有 playwright-core）
export NODE_PATH="$PWD/.svgbuild/node_modules"
node tests/edit_e2e.cjs            # 产品内编辑     47/47
node tests/edit_ux2.cjs            # 编辑自由度     15/15
node tests/edit_multi.cjs          # Ctrl 多选      18/18
node tests/edit_cancel.cjs         # 改动清单       14/14
node tests/smoke_svgb.cjs          # 产物冒烟
node tests/sweep_rule.cjs          # 全量 36 样例 × rule，非回归门
node tests/contain_audit.cjs real-01   # 包含性审计  4/62.63px → 0/0px
# 同一份探针验单文件产物
SVGB_TARGET=svgb_beautifier.html node tests/edit_e2e.cjs
# 开发验证台
node tools/run_dev.cjs dev.html
```


> `.svgbuild/st1.json` 与 `st2.json` 是 §8「修复前」对照所引用的历史基线（在应用 §9.2 的两处修复之前跑的同一批 22 例），已随仓库保留；`ui1/ui2`、`rt1`、`dev1..17` 同理，用于追溯每一轮改动的效果。

## 1. 架构与职责边界

```
  原始 SVG ──► [svgedit/svgcanvas] ──► 活 DOM
                    │ 解析/载入/导出/历史/缩放
                    │ (补齐: 世界坐标重建 + 文本测量)
                    ▼
              02 运行时 ──► 03 Diagram IR ──► 04 诊断器+质量评分
                                                      │
                                     ┌────────────────┴───────────────┐
                                     ▼                                ▼
                          05 Laya 决策层(做什么)              06 几何引擎(做多少)
                          · rule / mix / model                · 自由空间/生长锚定
                          · 一次前向回答全部问题               · 确定性数值解算
                          · 绝不输出坐标数值                   · 无决策
                                     └────────────────┬───────────────┘
                                                      ▼
                                       07 Patch 引擎 + 验证器 + 回滚闭环
                                       op级归因 → 重算 → 通过则采纳，否则回滚
                                                      │
                                                      ▼
                                       08 非侵入叠加视图 (Wireframe/诊断/提案)

                          活 DOM ◄── 09 编辑层（产品内直接编辑，§15）
                                     选择/几何/属性/结构 全部经 svgcanvas 语义 API
                                     每次改动 → 重算 IR + 评分 → 记入变更轨迹
```

三条宪法级约束，均在代码注释与验证中落实：

1. **Laya 决策『做什么』，几何引擎计算『做多少』** —— `05_laya.js` 只产出 `choice`（策略枚举/档位/布尔），全部连续数值由 `06_geometry.js` 计算；两者之间只通过枚举值传递。
2. **能用几何解决的问题，不交给 AI** —— 可行性预检（`freeSpace` 封顶、`wouldCollide`、`anchorOf` 锚定、`separation` 空解返回 `null`）全在几何层，模型无权参与。
3. **Wireframe 是 View，不是 Mutation** —— 全部叠加画在独立的 `<svg class="svgb-ovl">` 上，内容 DOM 一个字节不改（§5 有可执行断言）；编辑层是**唯一**允许改内容 DOM 的入口（§15），且它不改叠加层。

## 2. 模块清单

| 模块 | 职责 |
|:---|:---|
| `01_util.js` | 纯函数：矩阵 / 矩形 / 折线采样 / 可复现随机 / SHA-256（编辑轨迹与视图层共用） |
| `02_runtime.js` | SVG 运行时（包 svgcanvas）+ 世界坐标 + 文本测量 + 叠加层坐标映射 |
| `03_ir.js` | Diagram IR：节点 / 边 / 自由文本 / 容器分组 / 方言识别 |
| `04_analyzer.js` | 7 维诊断（碰撞/文本/对齐/间距/连线/样式/画布）+ 质量评分 + Issue 模型 |
| `05_laya.js` | Laya 客户端 + 规则引擎 + 问句构造 + 决策合成（rule/mix/model） |
| `06_geometry.js` | 确定性几何/布局引擎：op 构造器 + 画布收尾 + 策略顺位回退 |
| `07_patch.js` | Patch 引擎 + 验证器（整轮门 + op 门）+ 回滚闭环 |
| `08_ui.js` | 非侵入叠加视图：wireframe(三级/zoom-aware) / diagnostic / proposed |
| **`09_editor.js`** | **产品内直接编辑：输入守卫 / 能力探测 / 语义操作封装 / 变更轨迹与实时重评分（§15）** |
| `10_samples.js` | 缺陷注入式样例集（模型层注入 → 真值精确） |
| `11_realsvgs.js` | 真实产出图内联（由 `.svgbuild/gen_realsvgs.py` 生成） |


## 3. 质量评分模型（设计文档 §14）

`score = 0.25·collision + 0.20·textFit + 0.15·alignment + 0.15·spacing + 0.10·edgeRouting + 0.10·style + 0.05·canvas`

## 4. 打分器自洽性锚点

干净样例（等宽列 + 等距行 + 两档字号）必须**恰好 100 分、零 issue** —— 否则说明打分器本身有 bug，而不是图有缺陷。

| 样例 | 得分 | issue 数 | 判定 |
|:---|---:|---:|:---:|
| `raw-layered-clean-s1` | 100 | 0 | ✅ |
| `raw-grid-clean-s2` | 100 | 0 | ✅ |
| `raw-hub-clean-s3` | 100 | 0 | ✅ |
| `raw-pipeline-clean-s4` | 100 | 0 | ✅ |
| `semantic-layered-clean-s31` | 100 | 0 | ✅ |

## 5. 「Wireframe 是 View，不是 Mutation」的可执行证明

对同一张图依次切换 原图 → Wireframe → 诊断 → 提案 → 再回原图 → Wireframe → 原图，每一步都取 `rt.exportString()` 的 SHA-256：

```
切换前 : d2e13403e582edbd34d1aa233e60a07169410c18e2ec93d644734649d82dd3c1
切换后 : d2e13403e582edbd34d1aa233e60a07169410c18e2ec93d644734649d82dd3c1
一字不变: 是 ✅
```

四视图各自的绘制结果（`drawn` = 叠加图元的逻辑计数，`ovlNodes` = 叠加层实际 DOM 节点数）：

| 视图 | drawn | 层级 | 叠加层 DOM 节点 | 说明 |
|:---|---:|---:|---:|:---|
| original | 0 | 0 | 0 | 不画任何东西 |
| wireframe | 12 | 2 | 24 | 节点框 + 连线骨架 |
| diagnostic | 3 | — | 18 | issue 落点 + 优先级配色 + 序号气泡 |
| proposed | 0 | — | 0 | 待执行 op 的 before/after |

`original` 视图叠加层节点数为 0 —— 视图层被完全清空，不存在残留装饰。

## 6. zoom-aware 三级 Wireframe（v1.1 §3）

| 缩放 | 期望层级 | 实测层级 | 判定 | 绘制图元 |
|---:|:---:|:---:|:---:|---:|
| 0.4（实际 0.4） | L1 | L1 | ✅ | 6 |
| 1（实际 1） | L2 | L2 | ✅ | 12 |
| 2.5（实际 2.5） | L3 | L3 | ✅ | 12 |
| fit（实际 1.9） | L2 | L2 | ✅ | 12 |

低倍（<0.5）只画节点框（6 个），中倍（0.5~2.0）补连线骨架（12 个），高倍（>2.0）再加 glyph。低倍下细节是噪声，所以主动不画。

## 7. 提案视图与「仅预览」

- 待执行 op 数：**4**，覆盖 issue 类型：text_overflow, overlap
- 提案视图绘制图元：**4**，叠加层 DOM 节点：**8**
- `dryRun` 标志：`True` —— 仅预览不落盘，`after == before`，返回 `finalSvg === beforeSvg`

## 8. 三策略对照（rule / mix / model）

| 样例 | rule | mix | model |
|:---|---:|---:|---:|
| `raw-layered-overlap-s11` | 95 → 100 (Δ+5.00) | 95 → 100 (Δ+5.00) | 95 → 100 (Δ+5.00) |
| `raw-grid-overlap-s12` | 85 → 100 (Δ+15.00) | 85 → 100 (Δ+15.00) | 85 → 100 (Δ+15.00) |
| `raw-layered-text_overflow-s13` | 93.2 → 100 (Δ+6.80) | 93.2 → 100 (Δ+6.80) | 93.2 → 100 (Δ+6.80) |
| `raw-grid-text_overflow-s14` | 96.4 → 100 (Δ+3.60) | 96.4 → 100 (Δ+3.60) | 96.4 → 100 (Δ+3.60) |
| `raw-grid-misalignment-s15` | 89.25 → 100 (Δ+10.75) | 89.25 → 100 (Δ+10.75) | 89.25 → 100 (Δ+10.75) |
| `raw-pipeline-misalignment-s16` | 95.25 → 100 (Δ+4.75) | 95.25 → 100 (Δ+4.75) | 95.25 → 99.9 (Δ+4.65) |
| `raw-grid-spacing-s17` | 92.3 → 100 (Δ+7.70) | 92.3 → 100 (Δ+7.70) | 92.3 → 100 (Δ+7.70) |
| `raw-pipeline-spacing-s18` | 93.65 → 100 (Δ+6.35) | 93.65 → 100 (Δ+6.35) | 93.65 → 99.95 (Δ+6.30) |
| `raw-layered-edge_crossing-s19` | 96.4 → 98.6 (Δ+2.20) | 96.4 → 98.6 (Δ+2.20) | 96.4 → 98.6 (Δ+2.20) |
| `raw-grid-edge_crossing-s20` | 97.1 → 100 (Δ+2.90) | 97.1 → 100 (Δ+2.90) | 97.1 → 100 (Δ+2.90) |
| `raw-layered-style_noise-s21` | 91.6 → 100 (Δ+8.40) | 91.6 → 100 (Δ+8.40) | 91.6 → 100 (Δ+8.40) |
| `raw-grid-style_noise-s22` | 94.2 → 100 (Δ+5.80) | 94.2 → 100 (Δ+5.80) | 94.2 → 100 (Δ+5.80) |
| `raw-layered-tiny_element-s23` | 86.8 → 100 (Δ+13.20) | 86.8 → 100 (Δ+13.20) | 86.8 → 100 (Δ+13.20) |
| `raw-grid-tiny_element-s24` | 98.8 → 100 (Δ+1.20) | 98.8 → 100 (Δ+1.20) | 98.8 → 100 (Δ+1.20) |
| `raw-layered-canvas_margin-s25` | 97.9 → 100 (Δ+2.10) | 97.9 → 100 (Δ+2.10) | 97.9 → 99.95 (Δ+2.05) |
| `raw-pipeline-canvas_margin-s26` | 97.9 → 100 (Δ+2.10) | 97.9 → 100 (Δ+2.10) | 97.9 → 99.95 (Δ+2.05) |
| `raw-layered-overlap+text_overflow+misalignment+spacing-s21` | 92.7 → 92.7 (Δ+0.00) | 92.7 → 92.7 (Δ+0.00) | 92.7 → 92.7 (Δ+0.00) |
| `raw-grid-text_overflow+edge_crossing+style_noise-s22` | 87.7 → 100 (Δ+12.30) | 87.7 → 100 (Δ+12.30) | 87.7 → 100 (Δ+12.30) |
| `raw-pipeline-overlap+spacing+canvas_margin-s23` | 82.95 → 100 (Δ+17.05) | 82.95 → 100 (Δ+17.05) | 82.95 → 100 (Δ+17.05) |
| `raw-grid-overlap+text_overflow+misalignment+spacing+edge_crossing+style_noise-s24` | 70.85 → 95.75 (Δ+24.90) | 70.85 → 95.75 (Δ+24.90) | 70.85 → 94.35 (Δ+23.50) |
| `semantic-layered-overlap+text_overflow+spacing-s32` | 91.7 → 93.2 (Δ+1.50) | 91.7 → 93.2 (Δ+1.50) | 91.7 → 93.2 (Δ+1.50) |
| `semantic-grid-misalignment+edge_crossing+style_noise-s33` | 85.85 → 98.6 (Δ+12.75) | 85.85 → 98.6 (Δ+12.75) | 85.85 → 98.6 (Δ+12.75) |

**汇总（22 例缺陷样例，当前冻结版本）**

| 策略 | n | After 均值 | Δ均值 | 提升 | 持平 | 劣化 | 平均耗时 |
|:---|---:|---:|---:|---:|---:|---:|---:|
| rule | 22 | 99.04 | +7.56 | 21 | 1 | 0 | 13.6 ms |
| mix | 22 | 99.04 | +7.56 | 21 | 1 | 0 | 140.0 ms |
| model | 22 | 98.96 | +7.49 | 21 | 1 | 0 | 155.4 ms |

**本次两处修复带来的变化（st1.json → st3.json，同一批 22 例）**

| 策略 | 修复前（After均值 / Δ均值） | 修复后 | 变化 |
|:---|:---|:---|---:|
| rule | 99.04 / +7.56（21提升 1持平） | 99.04 / +7.56（21提升 1持平） | 不变 |
| mix | 98.97 / +7.49（21提升 1持平） | 99.04 / +7.56（21提升 1持平） | +0.07 |
| model | 96.79 / +5.31（15提升 7持平） | 98.96 / +7.49（21提升 1持平） | +2.18 |

`rule` 完全不受影响（**+7.56 / 0 劣化，无回归**）—— 这是回归基线；`mix` 与 `model` 的提升说明两处修复只作用于「模型参与」的路径，不污染确定性路径。

**结论**

1. **rule 最快且当前最优**（13.6 ms，Δ 均值 +7.56）。**生产默认应为 rule。**
2. **model 原样使用在修复前显著更差**（+5.31，提升数只 15、持平 7）；经 §9.2 的策略顺位回退修复后追到 +7.49（提升 21 / 持平 1），仍略低于 rule —— 根因是模型的 `style` / `fix_order` / `severity` 近均匀、不携带信息（§9.1）。
3. **mix 修复后与 rule 完全同效**（99.04 / +7.56，逐例 delta 一致）：信息量门把噪声答案全部退回 rule，只让有信号的答案接管。代价是 **140 ms vs 13.6 ms（10.3×）**。
4. **零劣化**在三种决策来源下全部成立 —— 验证器（整轮门 + op 门）在 rule / mix / model 下都成功拦住了所有劣化。

## 9. Laya 的真实输出与它的问题

### 9.1 单次前向的原始响应（设计文档 §21：一次前向回答全部问题）

- 问题数 **7**，服务端耗时 **19.4 ms**（2.77 ms/问），端到端 **32 ms**
- `forward_passes = 1`（设计要求的 1 次）
- 输入 458 tokens，marker 数 22，截断 = `False`
- tokenizer：`tokenizer.json/BPE`，faithful = `True`
- 数值健康：has_nan = `False`，has_inf = `False`，hidden absmax = 919.0489501953125

| 问题 | 类型 | 回答 | 置信 | logit spread | 熵 | 判定 |
|:---|:---|:---|:---|:---|:---|:---|
| `dominant_issue` | choice | canvas_margin | 0.872 | 5.762 | — | **真信号** |
| `fix_order` | choice | global_relayout | 0.283 | 0.624 | — | 近均匀 |
| `style` | choice | minimal | 0.211 | 0.482 | — | 近均匀 |
| `severity` | score | — | — | — | 0.993 | — |
| `should_relayout` | noul | — | — | — | — | — |
| `safe_to_auto_fix` | noul | — | — | — | — | — |
| `strategy_canvas_margin` | choice | keep_canvas | 0.522 | 0.26 | — | 近均匀 |

**关键观察**：只有 `dominant_issue` 有明确信号（conf 0.872 / spread 5.76）；`style` 是 5 路近均匀（0.179~0.211）、`fix_order` 是 4 路近均匀（0.230~0.283）、`severity` 的 0~4 档概率 0.142~0.222（归一化熵 0.993）—— **这三项当前不携带信息**。

### 9.2 由此产生的两处缺陷与修复

| # | 缺陷 | 现象（实测） | 修复 | 修复后效果 |
|:--|:---|:---|:---|:---|
| ① | `mix` 照单全收「等于没说的答案」 | `style`/`fix_order` 这类近均匀分布被直接采纳 → mix 均值 98.97 < rule 99.04 | `LayaDecide.run` 加信息量门：`choice` 要求 `logit_spread ≥ mixMinSpread(0.5)`，`noul` 要求 `|p−0.5| ≥ noulMargin(0.25)`，否则回退 rule（**只作用于 mix；model 保持原样以充当对照臂**） | mix **98.97 → 99.04**，追平 rule |
| ② | 策略几何不可行时直接 0 op | s14 选 `reduce_font` 但字号已最低档 → op 为 `null`；s11 选 `keep_canvas` → 0 op → 整轮零修复 | `Geo.plan` 增加**策略顺位回退**：某策略本次迭代既无 op 也无 skip 时，沿 `dec.plan.__strategies[type]` 的顺位再试一格（**不增加任何模型调用**） | model **96.79 → 98.96**（+2.17），提升数 15 → 21 |

### 9.3 阈值定标（sweep，非拍脑袋）

`mixMinSpread` 扫描（mix 策略，22 例）：

| mixMinSpread | After 均值 | Δ均值 | 提升 | 持平 | 劣化 | 模型采纳数 |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 98.968 | +7.491 | 21 | 1 | 0 | 46 |
| 0.25 | 99.039 | +7.561 | 21 | 1 | 0 | 27 |
| 0.5 | 99.039 | +7.561 | 21 | 1 | 0 | 18 |
| 0.75 | 99.039 | +7.561 | 21 | 1 | 0 | 3 |
| 1 | 99.039 | +7.561 | 21 | 1 | 0 | 3 |
| 1.5 | 99.039 | +7.561 | 21 | 1 | 0 | 3 |
| 2 | 99.039 | +7.561 | 21 | 1 | 0 | 3 |
| 3 | 99.039 | +7.561 | 21 | 1 | 0 | 1 |
| 5 | 99.039 | +7.561 | 21 | 1 | 0 | 1 |
| 99 | 99.039 | +7.561 | 21 | 1 | 0 | 0 |

**门只要非零就登顶**：0.25 起 Δ 均值锁定 +7.561（平台），只有完全不筛（0）时被噪声拖到 +7.491。默认取 **0.5** —— 在平台上留一半余量，同时保住模型的实际参与度（采纳 18 次而非 0 次）。

`noulMargin` 扫描：0 / 0.1 → +7.561（采纳 55/52），≥0.2 起同样 +7.561（采纳 3）。同样平坦，默认取 0.25。

> ⚠ **必须诚实记录**：在这 22 例上，模型 choice「采纳」与「不采纳」的**最终质量相同**（99.039 vs 99.039）。门的作用是**防止噪声拖累（−0.071）**，而不是**带来增益**。要证明质量增益需要更难的基准或走 finetune 路线。本决策层当前的可交付价值是**架构性的**：一次 20~30 ms 前向替代多轮 LLM 调用、决策可审计、`gate` 约束动作空间、可对 critical 项行使 veto。

### 9.4 决策来源分布与 gate 实测

22 例 × 3 策略共产生决策：`{'rule': 387, 'mix': 18, 'model': 176}`（rule / mix / model 各自采纳数）。

| gate 取值 | 出现次数 |
|:---|---:|
| `relayout=False safeAll=True` | 44 |
| `relayout=True safeAll=True` | 29 |
| `relayout=False safeAll=False` | 4 |

`gate.relayout=false` 时，`global_relayout` 会从策略候选里被剔除（决策层直接约束几何层可行动作集）；`gate.safeAll=false` 时 critical 级 issue 被排除在自动修复之外。

### 9.5 后端不可用时的降级（必须可用）

强制 `Laya.ok = false`（模拟后端挂掉）后，把策略设为 `model` 跑 6 例，结果必须与 `rule` **逐例完全一致**：

| 样例 | 离线结果 | 离线 Δ | rule Δ | 决策来源 | 判定 |
|:---|---:|---:|---:|:---|:---:|
| `raw-layered-overlap-s11` | 95 → 100 | Δ+5.00 | Δ+5.00 | {'rule': 7} | ✅ 一致 |
| `raw-grid-overlap-s12` | 85 → 100 | Δ+15.00 | Δ+15.00 | {'rule': 7} | ✅ 一致 |
| `raw-layered-text_overflow-s13` | 93.2 → 100 | Δ+6.80 | Δ+6.80 | {'rule': 7} | ✅ 一致 |
| `raw-grid-text_overflow-s14` | 96.4 → 100 | Δ+3.60 | Δ+3.60 | {'rule': 7} | ✅ 一致 |
| `raw-grid-misalignment-s15` | 89.25 → 100 | Δ+10.75 | Δ+10.75 | {'rule': 7} | ✅ 一致 |
| `raw-pipeline-misalignment-s16` | 95.25 → 100 | Δ+4.75 | Δ+4.75 | {'rule': 7} | ✅ 一致 |

**结论**：后端不可用时 `LayaDecide` 完全不发起请求，决策来源全部为 `rule`，结果与纯 rule 路径逐位相同 → 产品在离线环境可完整交付。

## 10. 导出往返保真度与回滚等价性

### 10.1 往返幂等性

`e1 = export(load(X))`，`e3 = export(load(e1))`，`e4 = export(load(e3))`，`e5 = export(load(e4))`。这是回滚路径正确性的前提 —— 回滚正是 `rt.load(preSvg)`。

| 样例 | 输入字节 | e1 字节 | 同输入确定性 | e1→e3 收敛 | 不动点 | e1 得分 |
|:---|---:|---:|:---:|:---:|:---:|---:|
| `raw-layered-overlap-s11` | 3477 | 3937 | ✅ e1=e2 | ✅ | ✅ e3=e4=e5 | 95 |
| `raw-grid-overlap-s12` | 3225 | 3784 | ✅ e1=e2 | ✅ | ✅ e3=e4=e5 | 85 |
| `raw-layered-text_overflow-s13` | 3487 | 3947 | ✅ e1=e2 | ✅ | ✅ e3=e4=e5 | 93.2 |
| `real-01_知识中台定义与本体关系` | 7027 | 7903 | ✅ e1=e2 | ✅ | ✅ e3=e4=e5 | 67.95 |
| `real-02_知识如何长出来` | 6312 | 6645 | ✅ e1=e2 | ⚠ 1 字符 | ✅ e3=e4=e5 | 67.85 |
| `raw-layered-clean-s1` | 3469 | 3929 | ✅ e1=e2 | ✅ | ✅ e3=e4=e5 | 100 |
| `raw-grid-clean-s2` | 3219 | 3778 | ✅ e1=e2 | ✅ | ✅ e3=e4=e5 | 100 |

全部 7 例 `e1 === e2`（同输入 → 同输出，无隐藏状态）且收敛到不动点。`real-02` 的 `e1→e3` 差 **1 个字符**，定位结果是 `<style>` 之后的**空白文本节点被折叠**，内容与几何完全等价（`.svgbuild/diff_probe.cjs` 定位到 firstDiff=820）。

根 `<svg>` 的 `width / height / viewBox` 在三轮导出中逐字保留：

- `raw-layered-overlap-s11` → `<svg width="456" height="442" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">`
- `raw-grid-overlap-s12` → `<svg width="674" height="330" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">`
- `raw-layered-text_overflow-s13` → `<svg width="456" height="442" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">`

### 10.2 导出与当前 zoom 无关

| zoom | 导出根元素 |
|---:|:---|
| 0.4 | `<svg width="456" height="442" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http…` |
| 1 | `<svg width="456" height="442" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http…` |
| 2.5 | `<svg width="456" height="442" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http…` |

三个缩放档位下导出的 `width/height` 完全一致 —— 排除了 `svgToString` 里 `width / getZoom()` 可能带来的缩放耦合。

### 10.3 回滚等价性（设计文档 §20 的正确性基础）

对 `raw-layered-overlap+text_overflow+misalignment+spacing-s21`：`load(X) → 记录 pre → 跑一轮 beautify → load(pre)`，比较回滚前后的分数、7 项指标与导出的字符串。

```
回滚前得分 : 92.7
回滚后得分 : 92.7
字符串相同 : 是 ✅  (3965 → 3965 字节)
回滚前指标 : {'collision': 98, 'textFit': 66, 'alignment': 100, 'spacing': 100, 'edgeRouting': 100, 'style': 100, 'canvas': 100}
回滚后指标 : {'collision': 98, 'textFit': 66, 'alignment': 100, 'spacing': 100, 'edgeRouting': 100, 'style': 100, 'canvas': 100}
```

## 11. 真实产出图回归（「不得越改越丑」）

`svg/*.svg`（6 张 1920×1080 目标图）与 `assets/*.svg`（3 张报告配图）经 `tests/gen_realsvgs.py` 内联进样例表，共 9 件。

| 真实图 | Before | After | Δ | issue 数 | 轮数 | 耗时(ms) | 判定 |
|:---|---:|---:|---:|---:|---:|---:|:---:|
| `real-01_知识中台定义与本体关系` | 67.95 | 67.95 | +0.00 | 25 → 25 | 1 | 113.8 | ✅ |
| `real-02_知识如何长出来` | 67.85 | 67.85 | +0.00 | 12 → 12 | 1 | 165.4 | ✅ |
| `real-03_AI如何工作与职责边界` | 68.55 | 68.55 | +0.00 | 12 → 12 | 1 | 93.5 | ✅ |
| `real-04_高速案例可验证价值` | 59.05 | 59.05 | +0.00 | 25 → 25 | 1 | 91.5 | ✅ |
| `real-05_制造业AI数据建设建议` | 70.25 | 75.25 | +5.00 | 11 → 4 | 2 | 88.6 | ✅ |
| `real-onto_platform_architecture` | 58.8 | 58.8 | +0.00 | 46 → 46 | 1 | 431.3 | ✅ |
| `real-laya-arch-overview` | 99.25 | 99.25 | +0.00 | 2 → 2 | 1 | 28.8 | ✅ |
| `real-laya-capability-boundary` | 79.4 | 81.1 | +1.70 | 5 → 5 | 2 | 36.6 | ✅ |
| `real-laya-marker-scorer` | 68.5 | 89.5 | +21.00 | 11 → 7 | 3 | 161 | ✅ |

**9/9 通过**（Δ ≥ −0.05）：6 张保持原状（Δ=0，几何无解时正确降级为「不动」），3 张取得真实提升。

其中两例值得单独看：

| 真实图 | Before → After | 关键动作 | 被否决的动作 |
|:---|:---|:---|:---|
| `real-laya-marker-scorer` | **68.5 → 89.5（Δ+21）** | `spacing/distribute_equal` +5 与 +15、`misalignment/snap_edges` +0.6、`text_overflow/move_text` +0.4 | `resize_container`（对齐 −34）、`wrap_text`（对齐 −42）、`normalize_style`（对齐 −20）、`snap_centers`（间距 −68.3）—— 全部被 op 级门拦下 |
| `real-05_制造业AI数据建设建议` | 70.25 → **75.25（Δ+5）** | `text_overflow/move_text` +1.7、`style_inconsistency/normalize_style` +1.8、`misalignment/snap_edges` +1.5 | `distribute_equal` / `distribute_weighted`（碰撞 −4.0） |

> ⚠ **标定域说明（诚实记录）**：6 张 1920×1080 幻灯片式图的分数只有 58.8~70.25、issue 有 12~46 条。这不是修复失败，而是**打分器标定域外**：它们是「标题/副标题/正文/脚注」多级字号 + 绝对定位装饰块的幻灯片排版，天然违反本打分器的 `fontTiers ≤ 2` 与等距行列模型（所以 `style` 与 `spacing` 直接归零）。本产品对这类图**只承诺「不越改越丑」**，不承诺把它们修到高分。要真正覆盖幻灯片域需要重新标定 `styleSat / fontTiers / rowTol`，属下一轮工作（见 §15 P1）。

## 12. dev.html 全量矩阵交叉校验

- 探针阶段：`done`；页面错误：无
- 往返一致性：4/4 例 `dScore = 0`
- 干净样例锚点：5/5 例恰好 100 分
- 缺陷矩阵（22 例）：均值 **91.48 → 99.04**，提升 **21** / 劣化 **0**

| 样例 | 注入缺陷 | Before | After | Δ | 轮数(采纳/否决) |
|:---|:---|:---|:---|:---|:---|
| `raw-layered-overlap-s11` | overlap | 95 | 100 | +5.00 | 2（2/0） |
| `raw-grid-overlap-s12` | overlap | 85 | 100 | +15.00 | 2（2/0） |
| `raw-layered-text_overflow-s13` | text_overflow | 93.2 | 100 | +6.80 | 2（2/0） |
| `raw-grid-text_overflow-s14` | text_overflow | 96.4 | 100 | +3.60 | 2（2/0） |
| `raw-grid-misalignment-s15` | misalignment | 89.25 | 100 | +10.75 | 2（2/0） |
| `raw-pipeline-misalignment-s16` | misalignment | 95.25 | 100 | +4.75 | 2（2/0） |
| `raw-grid-spacing-s17` | spacing | 92.3 | 100 | +7.70 | 2（2/0） |
| `raw-pipeline-spacing-s18` | spacing | 93.65 | 100 | +6.35 | 2（2/0） |
| `raw-layered-edge_crossing-s19` | edge_crossing | 96.4 | 98.6 | +2.20 | 2（1/1） |
| `raw-grid-edge_crossing-s20` | edge_crossing | 97.1 | 100 | +2.90 | 2（2/0） |
| `raw-layered-style_noise-s21` | style_inconsistency, style_inconsistency, style_inconsistency, style_inconsistency, style_inconsistency | 91.6 | 100 | +8.40 | 2（2/0） |
| `raw-grid-style_noise-s22` | style_inconsistency, style_inconsistency, style_inconsistency, style_inconsistency, style_inconsistency | 94.2 | 100 | +5.80 | 2（2/0） |
| `raw-layered-tiny_element-s23` | tiny_element | 86.8 | 100 | +13.20 | 2（2/0） |
| `raw-grid-tiny_element-s24` | tiny_element | 98.8 | 100 | +1.20 | 2（2/0） |
| `raw-layered-canvas_margin-s25` | canvas_margin | 97.9 | 100 | +2.10 | 2（2/0） |
| `raw-pipeline-canvas_margin-s26` | canvas_margin | 97.9 | 100 | +2.10 | 2（2/0） |
| `raw-layered-overlap+text_overflow+misalignment+spacing-s21` | overlap, text_overflow, misalignment | 92.7 | 92.7 | +0.00 | 1（0/1） |
| `raw-grid-text_overflow+edge_crossing+style_noise-s22` | text_overflow, edge_crossing, style_inconsistency, style_inconsistency, style_inconsistency, style_inconsistency, style_inconsistency | 87.7 | 100 | +12.30 | 2（2/0） |
| `raw-pipeline-overlap+spacing+canvas_margin-s23` | overlap, spacing, canvas_margin | 82.95 | 100 | +17.05 | 2（2/0） |
| `raw-grid-overlap+text_overflow+misalignment+spacing+edge_crossing+style_noise-s24` | overlap, text_overflow, misalignment, spacing, edge_crossing, style_inconsistency, style_inconsistency, style_inconsistency, style_inconsistency, style_inconsistency | 70.85 | 95.75 | +24.90 | 2（2/0） |
| `semantic-layered-overlap+text_overflow+spacing-s32` | overlap, text_overflow | 91.7 | 93.2 | +1.50 | 2（1/1） |
| `semantic-grid-misalignment+edge_crossing+style_noise-s33` | misalignment, edge_crossing, style_inconsistency, style_inconsistency, style_inconsistency, style_inconsistency, style_inconsistency | 85.85 | 98.6 | +12.75 | 2（1/1） |

## 13. 单文件产物冒烟测试

`python build.py` → `svgb_beautifier.html`（内联 **12 段**脚本，含 svgcanvas 1 113 445 B，产物 **1 535 104 B / 6 724 行**；v1.2 编辑层落地时是 1 467 926 B / 5 647 行，v1.3 编辑自由度增强后为当前值）。

```
载入阶段       : ready   (707 ms)
页面错误       : 无 ✅
失败请求       : 无 ✅
imgPath 生效   : vendor  (应由构建期注入为 'vendor')
样例数         : 36
四视图遍历后内容不变 : True
一键美化       : raw-layered-overlap+text_overflow+misalignment+spacing-s21  92.7 → 92.7 (Δ0)
```

## 14. 打开本地 SVG 文件（文件选择 / 多选 / 拖拽 / 快捷键）

产品页不只是「看内置样例」——`ui.html` 顶栏的 **打开 SVG…** 支持四种入口，四条路最终都汇聚到 `UI.openFiles()` → `UI.addLocal()` → `UI.select()`，即与内置样例**完全同一条**通路，因此本地文件在分析、四视图、Laya 决策、Patch 闭环、导出各环节上不可区分。

| 入口 | 触发 | 实现要点 |
|:---|:---|:---|
| 按钮 | `#btnOpen` | `pickLocal()` 先 `value=''` 再 `click()`，保证「同一个文件连开两次」也会触发 `change` |
| 文件选择器 | `#fileInput`（`.hidden` + `multiple`） | `accept=".svg,image/svg+xml,text/xml,application/xml"`；隐藏输入框仍可被程序化投喂 |
| 拖拽 | `#stage` 上的 `dragenter/dragover/dragleave/drop` | `hasFiles()` 用 `dataTransfer.types` 判分支：有 `Files` 走文件、否则读 `text/plain`（可从编辑器直接拖一段 SVG 源码）；`#drop` 覆盖层 `pointer-events:none` 不挡拖拽 |
| 快捷键 | `document` 上的 `keydown` | `Ctrl/Cmd+O` → `preventDefault()` + `pickLocal()` |
| 兜底 | `window` 上的 `dragover/drop` | `preventDefault()`，避免拖到窗口空白处导致浏览器导航走 |

入口自检：`#btnOpen`=True · `#fileInput`=True（display:none=True，multiple=True） · `accept`=`.svg,image/svg+xml,text/xml,application/xml` · `#drop`=True

### 四条入口的实测断言

探针 `.svgbuild/open_probe.cjs` 在真实无头 Edge 上跑出 **31/31 全通过**，零 pageerror、零 console error、零失败请求（`errs=0`，`failed=0`）。

| # | 断言 | 实测 |
|:---|:---|:---|
| B1 | 单选一件真实 SVG → 新增 1 条 local 条目并自动选中 | `local-onto_platform_architecture`，样例总数 36 → 37 |
| B1 | 打开后立即可分析 | 分数 58.8 · 46 issue · 1920×1080 · 39 节点 / 10 边 |
| B1 | 四视图均可渲染 | wireframe drawn=49 · diagnostic drawn=44 |
| **B2** | **打开不改内容：条目内 svg 与磁盘原文逐字节相同** | `diskSame=True`，17796 B == 磁盘 17796 B |
| B3 | 一次多选 3 件 → 3 条 local 条目，最后一件被选中 | nLocal=3，ids=`local-onto_platform_architecture, local-laya-marker-scorer, local-02_知识如何长出来`，下拉 39 项 = 样例总数 |
| B3 | 三条条目字节数与磁盘逐一相符 | `[17796, 6068, 6312]` |
| B4 | 重复打开同名文件 → 原地覆盖，不产生重复条目 | nLocal 仍为 3 |
| C1 | 拖入 File → 新增条目且被选中 | `local-dropped-by-drag`，nLocal=4，投放层已收起（`.dropping`=False） |
| C2 | 拖入**纯文本 SVG**（无 Files）→ 也能新增条目 | `local-dropped`，nLocal=5 |
| C3 | 非 SVG 文本被拒绝且留痕 | nLocal 5 → 5（不变），日志出现「不是 XML 文本，已跳过」 |
| D | `Ctrl+O` 确实触发 `#fileInput.click()` | clicks=1 |
| E | 美化只改内存工作副本：1920×1080 真实图经「打开」入口美化后 | 58.8 → 58.8（Δ0），条目内原文 17796 B 仍等于磁盘原文=True |
| **F** | **本地缺陷件走完整「打开 → 一键美化」，必须有可测量提升** | `raw-grid-overlap+text_overflow+misalignment+spacing+edge_crossing+style_noise-s24` 源分 70.85（6 issue）→ **95.75，Δ+24.90**（2 轮 / 8 op），美化后磁盘原文 3356 B 未被写回 |

同一份探针把目标切到单文件产物（`SVGB_TARGET=svgb_beautifier.html node open_probe.cjs`）同样 **31/31 全通过**，F 段数字与 `ui.html` 逐位一致（70.85 → 95.75，Δ+24.90），说明「打开本地文件」在 `svgb_beautifier.html` 里同样可用。

### 「不写回原文件」的机制

打开动作只做 `FileReader.readAsText(f, 'utf-8')`，文本进 `UI.samples[i].svg`；`Pipeline.beautify` 在**工作副本**上跑，全程只有 `Runtime.load()` / DOM 操作，没有任何 `File`/`Blob` 写出路径。要留存结果只能显式点「导出 SVG」（`data:image/svg+xml` + `a.download`，文件名沿用它原来的文件名）。因此 B2 / E / F 三条断言测的是同一件事：**打开与美化都不会改动用户磁盘上的文件**。

## 15. 产品内直接编辑（P0「闭环优先」）

参考件：`https://unpkg.com/svgedit@7.4.2/dist/editor/index.html`。要求是「参考这个网页，实现 svg 编辑能力」。

### 15.1 为什么不需要引入 svg-edit 的编辑器

先把参考件量清楚（`.svgbuild/ref/`，数字全部实测）：

| 项 | 实测 |
|:---|:---|
| 参考页 `dist/editor/index.html` | **1 793 B**（本地副本 1 796 B，多 3 B UTF-8 BOM）—— 只是个壳：一个 `<div id="container">` + `<link href="./svgedit.css">` + `import Editor from './Editor.js'` + `setConfig/init()` |
| `svgedit@7.4.2` tarball | 10 265 698 B，sha1 `1a18fb12e6c9514c0bbc1e5045c752b6fee9d397`；解包 **50 341 927 B / 1 771 文件** |
| `dist/`（即 `dist/editor/`） | **481 文件 / 22 394 109 B** |
| 其中 `Editor.js` / `iife-Editor.js` | 2 758 203 B / **2 222 000 B** |
| 其中 `images/` / `extensions/` / `tests/` | 261 文件 / 277 610 B；152 文件 / 694 839 B；45 文件 / 5 868 235 B |

关键结论：**`iife-Editor.js` 这个 2.22 MB bundle 的内核，就是本仓库早已 vendor 的 `@svgedit/svgcanvas@7.4.2`**（`vendor/svgcanvas.min.js`，1 113 445 B）。也就是说**编辑能力本身我们早已具备**，缺的只是接线与产品化。因此本层**零新增依赖**，没有引入 2.22 MB + 277 KB 图标 + 695 KB 扩展。

### 15.2 与官方 svg-edit 的三点差别（也就是它做不到的）

1. **每一步都重算质量分**。官方编辑器没有质量模型，改完不知道是变好了还是变丑了。本产品每次改动后立刻重算 IR + Analyzer，把「这一步改了多少分」记进变更轨迹（右栏「编辑」面板逐条列出：标签 → 分数 → 单步 Δ）。
2. **选中元素即可看到它命中的诊断 issue**，把「手改」与「自动美化」放进同一个闭环 —— 同一个 DOM、同一份 IR、同一个 7 维评分。
3. **输入守护**：不进编辑模式时，画布上的指针事件被拦下，**不会产生任何选中或误拖**。

### 15.3 输入守卫为什么必须挂在父节点

未压缩源码里是 `container.addEventListener('mousedown', this.mouseDownEvent)` —— svgcanvas 把处理器注册在 **`container`（我们传进去的 `#host`）自身**上。同一节点上的监听器之间用 `stopPropagation` **无法互相阻断**（需要 `stopImmediatePropagation`，且受注册顺序决定，而 svgcanvas 注册早于我们）。

因此守卫挂在父节点 `#stage` 的**捕获阶段**（`{capture:true}`）：捕获先于目标阶段，事件根本到不了 `#host`。守卫只 `stopPropagation`、不 `preventDefault`，所以非编辑模式下原生滚动条仍可拖动 —— **只是不能编辑，不是不能用**。

### 15.4 svgcanvas 的真实 API（与官方 `.d.ts` 不一致）

官方 `svgcanvas.d.ts`（225 行）在这里**不可信**，一律以未压缩源码与运行时实测为准。探针把这件事做成自证断言（`Editor.probe()`）：

| 事实 | 证据 |
|:---|:---|
| `.d.ts` 声明的 `canvas.undo()` / `redo()` 在 IIFE 构建里是 `undefined` | 实测 `hasUndoOnCanvas=false`；真实入口是 `canvas.undoMgr.undo()/.redo()`，配 `getUndoStackSize` / `getRedoStackSize` / `getNextUndoCommandText` / `getNextRedoCommandText` |
| `.d.ts` 完全没写 `setRotationAngle` / `flipSelectedElements` / `alignSelectedElements` / `setStrokeWidth` / `setFontSize` / `setTextContent` / `setColor` / `setPaint` / `getText` / `getBold` / `getItalic` | 这些都在源码里挂到了 canvas 上，实测全部可用 |
| 事件名是 `selected` / `changed` / `transition` / `zoomed` / `contextset` / `sourcechanged`，不是 `.d.ts` 里那套命名 | 源码 `svgCanvas.call('...')` |
| **`setTextContent` 存在但本宿主里不可用** | 见 §15.6 —— 这条是探针查出来的，不是猜的 |
| 编辑**辅助 DOM 不污染分析器** | `#selectorParentGroup` 是 `#svgroot` 的直接子节点、与 `#svgcontent` **平级**；实测选中前后 `score / nodes / edges / labels / decorations / preserved` 全不变，进 IR 的 grip 元素数 **0** |

两处非显然的 API 语义（都写进了 `09_editor.js` 的行内注释）：

- **`moveSelectedElements(dx, dy)` 的单位取决于入参形态**：源码里是 `if (!Array.isArray(dx)) { dx /= zoom; dy /= zoom }`，即**标量入参是屏幕像素**、**数组入参是 SVG 用户单位**（数组长度须等于选中元素数）。要「精确移动 N 个用户单位」必须走数组形式，否则位移会随当前缩放漂移。探针 B2 专测这条：位移 2 单位 → `geomBox.x` 258 → 260，`dx=2 / dy=0`，`transform="translate(2 0)"`。
- **`setRotationAngle(val)` 只作用于 `selectedElements[0]`**，`#eRot` 的 tooltip 里明确标注；且它是在**变换后的中心**插入 `rotate`，所以与已有 `translate` 共存：`translate(2 0)` → `rotate(30 339 362) translate(2 0)`。

### 15.5 断言的实测结果

`ui.html` 与单文件产物 `svgb_beautifier.html` 各跑一遍同一份探针（`SVGB_TARGET` 切换），**43/43 全通过**，零 pageerror、零 console error、零失败请求。样例：`raw-layered-overlap+text_overflow+misalignment+spacing-s21`（进编辑时 92.70 分）。

| 组 | 断言 | 实测 |
|:---|:---|:---|
| F | 能力探测：`.d.ts` 与构建不符可自证 | `missing=[]`（31 个必需 API 全部为 function）· `hasUndoOnCanvas=false` · `undoMgr.undo=function` · `history.BatchCommand`/`ChangeElementCommand` 均可用 |
| A | UI 元素齐备 | `#btnEdit`/`#editbar`/`#editPanel` 存在，26 个控件一个不缺，初始 `display:none` |
| A | 非编辑模式点击 → 未选中、无手柄、内容不变 | `sel=0 · canvasSel=0 · grips=0 · sha 逐位不变` |
| A | **进入/退出编辑本身不改内容** | 进入前后 `sha256` 相同（编辑模式的开启是纯 UI 状态变更） |
| A | 编辑模式点击 → 选中 + 手柄 | 点到 `g#svg_22`，`grips=9`，面板文案 `g#svg_22 · 可见手柄 9` |
| B1 | 填充 | DOM 变、导出串含 `#ff5500`、轨迹 +1 条且带 `score`/`total` |
| B2 | 位移精确 2 用户单位 | 见 §15.4 的数组语义 |
| B3 | 字号 14 → 23 | `font-size` 落到元素属性；**字号与文本各落一条轨迹**（`t0→t1→t2` = +1/+1，无静默丢失） |
| B3b | 非文本作用域被拒 | 三个文本操作全部 `ok:false` 且给出可读原因，**DOM 零改动**（`domUntouched=true`，子元素数不变） |
| B3d | 文本对齐 `middle → start` | 内容变、轨迹 +1、撤销栈 +1，标签 `对齐方式 start` |
| B4 | 旋转 30° | `rotate(30 339 362)`，`Editor.rotation()` 读回 30 |
| B5 | 翻转/置顶/复制/删除/成组/解组/对齐 | 7 项逐条改变 DOM；元素数 33 →(副本)37 →(删除)33 →(成组)34 →(解组)**回到 33** |
| B5 | 11 类操作全部进轨迹 | `["填充 #ff5500","位移 2,0 单位","字号 23","文本内容","对齐方式 start","旋转 30°","翻转 水平","置顶","复制副本","删除","成组","解组","对齐 l"]` |
| C1/C2 | 撤销 / 重做 | 撤销改变内容且重做栈 +1；重做后 `sha` 逐位回到撤销前 |
| **C3** | **一路撤回到进入编辑时的内容** | 13 步撤销 → `sha` 与进编辑时**逐位相同**，分数 **92.70 = 92.70**；逐行 diff `len 3980 → 3980`，结构签名 `{els:36, nodes:6, texts:12}` 两侧一致 |
| D | 「切视图不改内容」在编辑模式下仍成立 | 四视图（wireframe drawn=12 / diagnostic drawn=3 / proposed 0 / original 0）切换后 `sha` 与基准相同 |
| E | 编辑结果进入导出 | 导出串含新色 `#0d9488` |
| E | 退出编辑：内容保留、选择清空、手柄消失、面板收起 | `sha` 不变 · `sel=0` · `canvasSel=0` · `grips=0` · 两面板均收起 |
| E | 退出后守卫重新生效 | `pt` 命中 `text#svg_25` 但 `sel=0 / canvasSel=0 / grips=0 / sha` 不变 |
| E | 退出后再跑「一键美化」正常 | `ok=true`（编辑成果可继续交给自动优化） |

回归（改动前后逐字段比对，忽略耗时）：`open_probe.cjs` **完全一致**（31/31）、`smoke_svgb.cjs` 只差 `loadMs`（858 → 2830 ms，机器噪声）、`ui_probe.cjs` 只差两条内嵌毫秒字符串（`26ms→28ms`、`msWall 59→63`）。

### 15.6 修掉的三个真缺陷（都是探针查出来的，不是设计出来的）

**(1) `canvas.setTextContent()` 在本宿主必然抛异常，且「先改 DOM 再抛」**

压缩源里 `setTextContent` 是 `JS = t => { changeSelectedAttribute('#text', t), textActions.init(t), textActions.setCursor() }`。末尾的 `setCursor()` 依赖 svgcanvas 自带编辑器的光标输入框，本宿主没有 → 抛 `Cannot read properties of null (reading 'value')`。实测对照（`.svgbuild/text_diag3.cjs`，每个用例独立重载页面）：

| 写法 | 不抛异常 | DOM 改动 | undo 栈增长 | 可撤销 |
|:---|:---|:---|:---|:---|
| `canvas.setTextContent('T1')` | ❌ 抛 | ✅ 已改成 T1 | ❌ 2→2 | ❌ |
| `canvas.changeSelectedAttribute('#text','T2')` | ✅ | ✅ 已改成 T2 | ❌ 2→2 | ❌ |
| `BatchCommand + ChangeElementCommand`（svgcanvas 官方撤销类） | ✅ | ✅ | ✅ 2→3 | ✅ undo 精确还原、redo 重放 |

第二行为什么不入栈：`changeSelectedAttribute`（压缩源 `jC`）走 `beginUndoableChange(attr, elems)` → `finishUndoableChange()` → `isEmpty() || addCommandToHistory()`，而它取旧值的方式是 `getAttribute('#text')` —— **文本节点上这个属性恒为 `null`**，于是判不出「变了」，命令为空。

⇒ `Editor.setText()` 改为自己改 `textContent`，但**入栈用 svgcanvas 官方的 `BatchCommand` / `ChangeElementCommand`**，保证与其它操作同源、同栈、标签可读（`Change Text`）。这是全层唯一一处偏离「只走语义 API」的写法，理由与实测证据都写在代码注释里。

**(2) `run()` 失败时跳过 flush → 「DOM 已变、轨迹没记、撤销栈不同步」**

因为 (1) 是「先改 DOM 再抛」，原来的 `run()` 在 `catch` 里直接 `return`，把已经发生的改动从轨迹里漏掉了 —— 于是面板上分数没动，画布上字已经改了。改成**无论成败都冲刷一次**（`flushNow()`），失败时返回 `{ok:false, err, changed}`，让「有没有真的改到」可判定。

**(3) 文本守卫下钻 `<g>` → 反向把内容改坏**

最初的 `_textEls()` 会下钻组内文本，于是「选中一个装着 text 的 `g` 去改字号」被放行；svgcanvas 对 `g` 执行 `changeSelectedAttribute('#text')` 就是 `g.textContent = val` —— **一次性抹掉该 `g` 的全部子元素**，然后 `setCursor()` 才抛。探针的逐行 diff 直接拍到了现场（进编辑时是 `<rect id="svg_23">`，全撤销后变成 `不该生效</g>`）。

⇒ 守卫改为与 svgcanvas 的 `gi()` **同语义：只看顶层选中元素、绝不下钻**。断言 `B3b` 从此不只检查「返回了错误」，而是检查 **`domUntouched === true` 且子元素数不变** —— 拒绝必须等于零改动。

另外两处小修：`Editor.grips()` 的判据（见 §15.7）、以及面板手柄数的同帧陈旧（svgcanvas 的手柄在 `selected` 事件**之后**才渲染，同帧量渲染盒得到 0，面板曾显示「可见手柄 0」而画面上有 9 个；改为下一帧补画一次，断言 `A5b` 比对面板数字与真实渲染盒）。

### 15.7 「可见手柄」的正确判据

`s#selectorParentGroup` 里共 10 个 `selectorGrip*`。**未选中时它们的 `visibility` 全是 `visible`、`display` 全是 `inline`，但渲染盒全是 0×0**（svgcanvas 把几何整个置零）。所以按样式判会**恒报 10**，于是「未选中却显示可见手柄 10」这种假阳性会一路误导属性面板。

正确判据是 `getBoundingClientRect()` 非零：未选中 `boxSaysVisible=0`（而 `styleSaysVisible=10`），选中后 **9** —— 8 个 resize 角/边柄 + 1 个 rotate 柄（`rotateconnector` 是条 `width=0` 的连线，本就不算手柄，被自动排除）。探针 `A3b` + `A5b` 把这条判据钉住。

### 15.8 工具条与画布的关系（一条探针契约）

工具条放在 `#mid` 的流里、`#stage` 之前（与官方 svg-edit 同构：工具条在上、画布让位）。代价是**进出编辑模式 `#stage` 会移动**：实测 `y 128 → 204`、高度 `862 → 786`，**位移与高度损失都是 76 px**（`#editbar` 本身 68 px、2 行，加 8 px 间距）。

这条**不是 bug，但会咬人**：任何在 `toggleEdit()` 之前算好的、指向画布的屏幕坐标，之后都会偏 76 px，点击落到空白处（本轮探针最初就是这么崩的）。所以：

- 探针契约：**屏幕坐标一律在切换编辑模式之后重算**；
- 产品侧：`Editor.stats()` 暴露 `entrySha` / `atEntry`，进/出编辑的净 Δ 与基线都可查。

曾尝试把工具条改成浮在 `#stage` 内侧的浮层来消除位移，**已否决**：`#host` 与 svgroot 同尺寸时无法滚动，被盖住的那 68 px 会变成**永久不可达**的盲区 —— 代价比一次位移大。

### 15.9 本层的已知边界

| # | 边界 | 证据 | 分级 |
|:--|:---|:---|:---|
| 1 | ~~文本类属性（字号/字体/内容/加粗/斜体/对齐方式）只作用于**直接选中**的 `text`/`tspan`，不支持下钻 `group` 内部~~ → **已在 v1.3 解决**（§18.1）：选中卡片底板（`rect`）时按 IR 标签关联**反查文字节点**，字号/加粗/斜体/对齐均已生效 | 探针 `edit_ux2` V1/V3：字号 54/24/30 → 37/37/37、subtree 全 29，**15/15** 通过；仅 `setText` 仍只作用于直接选中的 `text`/`tspan`（零改动守卫，§15.6-3） | ✅ 已解决 |
| 2 | 选中 `g` 时属性面板回填的是**组自身**的计算样式 | 实测：给 `g#svg_22` 设填充后，`#ff5500` 落在子元素上，而 `g` 的 computed fill 仍是 `rgb(0,0,0)` → 面板色块显示黑色 | **P1** |
| 3 | 绘制工具（矩形/圆/线/路径/文本/图片）与路径节点编辑未接入 | `setMode` 支持 `rect/square/ellipse/circle/line/polyline/path/text/image/zoom/pan/rotate` 等模式（实测全部 `ok`），但 P0 只做了「选择/移动/缩放/旋转/属性/结构」这批闭环操作 | **P1** |
| 4 | 图层（layer）面板、图层级可见性/锁定未接入 | svgcanvas 有 `Layers` 对象与 `setCurrentLayer` 等，但本产品只用 `g` 级成组/层级，没有图层面板 | **P2** |

## 16. 已知边界与下一轮工作

### 16.1 已确认的边界

| # | 边界 | 证据 | 当前行为 | 分级 |
|:--|:---|:---|:---|:---|
| 1 | 打分器标定域限于「图谱式排版」，不含 1920×1080 幻灯片式排版 | 6 张真实幻灯片图得分仅 58.8~70.25，`style`/`spacing` 归零 | 对该域只承诺「不越改越丑」，不承诺高分 | **P1** |
| 2 | 存在几何无解的实例（列被两侧夹死 + 行内被兄弟占满） | `s21`：4 条候选（`move_text` Δ0 / `reduce_font` 样式 −42 / `resize_container` Δ0 / `wrap_text` 对齐 −32）+ `move_apart` 无净空位，5 个 gateKey 全进黑名单 | 保持原状 + 台账留痕（设计的正确降级） | **P1** |
| 3 | Laya 的 `style` / `fix_order` / `severity` 三项当前不携带信息 | 近均匀分布（spread 0.48 / 0.62，熵 0.993） | 用信息量门拦在 `mix` 之外；`dominant_issue` 作为唯一有效信号 | **P0** |
| 4 | 模型 choice 在本基准上无正向质量增量 | sweep：采纳 0 次与 18 次结果同为 99.039 | 以 rule 为生产默认；mix 作为「模型在位但不越界」的形态保留 | **P0** |
| 5 | 导出首轮有 1 字符空白规范化 | `real-02`：`e1` 6645 → `e3` 6644 | 内容等价、一轮后稳定；回滚路径所依赖的快照已在不动点上 | **P2** |
| 6 | `.svgz`（gzip 压缩的 SVG）不会被解压 | `openFiles` 用 `readAsText` 把二进制读成乱码，命中「不是 XML 文本，已跳过」分支并留痕（不静默失败） | 只接受未压缩的 `.svg`/XML 文本；要支持 `.svgz` 需接 `DecompressionStream('gzip')` | **P2** |

### 16.2 下一轮（按优先级）

**P0 —— 让 Laya 真正产生增益**

1. 提高 `style` / `fix_order` 的可分性：当前问句把「全图风格」与「修复顺序」放在同一批marker 里，模型分不开。改为**按 issue 类型分问**（每类单独一次前向，代价仍是 ~3 ms/问），或直接在 finetune 里加入这两项的监督信号。
2. 引入「模型 vs 规则决策分歧」的**在线记录**：分歧样本自动落盘，作为 finetune 数据（`mix` 已能识别分歧，只需把 `fallback`/`noisy` 的样本导出）。

**P1 —— 扩大标定域与解空间**

3. 重标定 `styleSat / fontTiers / rowTol`，把 1920×1080 幻灯片式排版纳入可评域（当前 6 张真实图因此被误判）。
4. 为 §16.1-边界 2 的几何无解实例增加一条**降级策略**：`wrap_text` 在无可行换行点时，退化为「缩小字号并同步放大容器」（两个 op 成组），而非各自单独被否决。

**P2 —— 工程收尾**

5. `labs/verify_frontend.mjs` 仍是 macOS 硬编码路径（`/Users/wanglongzhen/Downloads/jev`），本机跑不通。它服务的是 laya 小游戏那条线，与 svgb 无耦合，本轮未改动以免混淆。
6. `10_samples.js` 的样例生成依赖 `Runtime.ready` 做文本测量（`Sampler.tw`），在没有 DOM 的纯 Node 环境下会退化为字符数估算 —— 若要做 CI 必须补一个测量桩。

## 17. 结论

**产品可交付。**

| 能力 | 状态 | 关键数字 |
|:---|:---|:---|
| svgedit 解析 → Diagram IR | ✅ | 节点/边/自由文本/容器/方言识别；导出往返 7/7 幂等 |
| 几何诊断 + 质量评分 | ✅ | 干净样例 **5/5 恰好 100 分、0 issue**（打分器自洽） |
| 确定性几何修复 | ✅ | 22 例缺陷 **21 提升 / 0 劣化**，均值 **91.48 → 99.04** |
| Patch + 验证 + 回滚 | ✅ | 零劣化；回滚等价性 `strEq = true`、7 项指标逐项相同 |
| Laya 决策层 | ✅（架构级） | 单次前向 **19.3 ms / 7 问**；离线回退与 rule 逐位一致；但质量增益为 0（§9.3 已诚实记录） |
| 四视图非侵入叠加 | ✅ | 四视图 + 反复切换后导出 SHA-256 **一字不变** |
| zoom-aware 三级 wireframe | ✅ | 0.4→L1 / 1.0→L2 / 2.5→L3 三档全部符合 |
| 真实图回归 | ✅ | 9/9 未劣化（Δ ≥ −0.05），3 例真实提升（最高 Δ+21） |
| 产品内直接编辑（P0 闭环优先） | ✅ | **43/43**（`ui.html` 与 `svgb_beautifier.html` 各一遍）· 13 步撤销**精确**回到进编辑时的 sha 与分数 · 编辑辅助 DOM 进 IR 元素数 **0** · 零新增依赖 |
| 编辑自由度（改字号生效 / 切换选择 / 删除 / 清单勾选 / 轨迹撤销） | ✅ | **`edit_ux2` 15/15 + `edit_e2e` 47/47**（`ui.html` 与产物各一遍）· 字号 54/24/30 → 37/37/37 · 撤销栈/内容双验证 |
| 四缺陷几何闭环（同族统一放大 + 对齐感知生长） | ✅ | 全量 36 样例 sumDelta 204.65 → **209.95**、**0 回归** · real-01 越界 4→2 处、62.63px→**2.22px** |
| 单文件交付 | ✅ | `svgb_beautifier.html`（**1 535 104 B / 6 724 行**），零页面错误、零失败请求 |

**一句话**：svgedit 负责「看懂」，几何引擎负责「算准」，Laya 负责「指路」，编辑层让人「亲手改」；验证器保证「绝不越改越丑」。四者中**几何引擎是质量的实际来源**，Laya 当前提供的是可审计、低成本、可否决的决策通道 —— 它要变成质量来源，需要 §16.2 的 P0 两项工作。

编辑层是这份产品与官方 svg-edit 的分界线：**同一份 DOM、同一份 IR、同一个评分模型**，所以「手改」与「自动美化」不是两个工具，而是同一个闭环的两端 —— 手改一步，分数与 issue 立刻跟着动；撤销到底，分数精确回到进入编辑时的值（实测 92.70 → 92.70）。

v1.3 把「手改」这一端补到与开源实现同等自由度：**选中卡片底板即可改字号并真正生效**（IR 标签反查 + 属性/内联样式双写，绕过作者样式表的层叠压制）、**选中切换与层级下钻/上钻**、**选中删除**、**变更轨迹行点击即回退该步**；同时给「自动美化」端加了**可勾选的改动清单**（勾掉即不执行，不是执行后回滚）。几何侧新增的**同族统一放大 + 对齐误差感知择优**，让「背景框不适配文字 / 文字越出容器」这类缺陷在真实图上从 62.63px 收到 2.22px，且全量 36 样例 **0 回归**。

## 18. 编辑自由度增强（v1.3）+ 同族对齐感知放大

**需求（原话）**：`编辑模式自由度不如开源实现，选中一个元素无法修改字号大小并生效；选中一个元素无法点击另一个元素继续修改；一键美化的修改项目应该提供一个列表，可检查可取消；选中元素支持删除；操作变更列表支持点击撤销；`

### 18.1 五项编辑能力（`09_editor.js` 25 856 B → 44 746 B）

| # | 需求 | 实现 | 探针断言 |
|:--|:---|:---|:---|
| V1 | 选中元素改字号**真生效**（含卡片） | `fontTargets()` 三重取文：DOM 下钻 `text,tspan` + **IR 标签关联回找**（`_irLabelElems`）；`_textProp()` 统一通道，被作者样式表压过时**属性 + 内联 style 双写**；`effFontSize()` 取字体目标**多数派**字号 | `edit_ux2` V1：100% 命中，54/24/30 → 37/37/37（点卡片**底板**也能改） |
| V2 | 点另一个元素继续改 | 选中切换（svgcanvas 原生）+ 层级 `selectDeeper()`/`selectParent()` + UI「下钻/上钻」 | V2：选择切换 + 层级往返，选中项与面板同步 |
| V3 | 下钻到 `text` 改字号 | 同上，下钻优先落 `text`/`tspan` | V3：子树全 29 生效 |
| V4 | 选中元素**删除** | `del()` 重写：可读标签「删除 text#svg_11,g#svg_9（含 15 个子元素）」，删后清空 `sel` | V4：DOM 真移除 + 轨迹与撤销栈同步 |
| V5 | 变更列表**点击撤销** | `undoTo(n)`/`canUndoTo(n)`：按 undo 栈深回退到轨迹第 n 步、截断 `track`、走 `undoMgr.undo`；轨迹行仅在可回退时加 `.clickable` + `↶` | V5：点轨迹行 → 撤销栈真的减小、内容真的变 |
| V6 | 美化改动**可勾选清单** | `beautify()` 接 `opAllow` 回调，**组装 batch 前**过滤（不是先执行再回滚，避免抖动）；UI `#opPanel` 按 strategy 分组、每行带「为什么改」 | V6：15/32 已勾选 → 应用日志「已按清单取消 17 项」 |

**「改字号不生效」的两层根因**（都是探针查出来的，不是设计出来的）：

1. 点卡片**底板**命中的是 `rect`，文字是它的**兄弟节点** —— 纯 DOM 下钻够不到 ⇒ 用 IR 的 `node.labels` 反查元素。
2. Illustrator 导出件把 `font-size` 写在**作者 `<style>` 类规则**里，只写表现属性会被**层叠压过**（作者样式 > 内联 style > 表现属性）⇒ `_needInline()` 试写 + 还原比对 computed 值，被压过则**属性 + 内联 style 双写**；撤销用 `BatchCommand + ChangeElementCommand({attr, style})`，把旧 style（含「原本无 style」的 null）一并记入 ⇒ 精确还原。

### 18.2 四缺陷的几何闭环（`06_geometry.js` → 91 762 B）

- `evResize`：从「总尺寸」口径改为**逐边缺口 + 自由空间逐边 min**（旧口径高估可行性 → 决策选错策略）。
- `evMoveText`：从固定 92 分改为**覆盖率计分** `25 + 67·cov`（`cov` = 可安全居中的标签数 / 总项数）。
- 新增 `rowFamily(ir,n,st)`：同形状 / 等宽(±2) / 等高(±2) / 同顶(±3) 且**自身也有 textFit issue** 的兄弟节点成一族（刻意**不要求等距**）；**同族按族内最大需要取统一宽高** —— 否则各自放大 → 不齐 → 对齐劣化 → 整批被 op 级门回滚。
- 新增 `alignErrWith(ir,moved)`：把候选位移喂回 `Analyzer.alignment` 重算误差（只改 JS 对象、**不碰 DOM**），各方向（right/left/sym × bottom/top/sym）取**对齐误差最小者**。
  **关键坑**：`Analyzer.alignment()` 只把 `spread>0.5 && <=alignTol` 的组收进 clusters，**完全对齐（spread≈0）的组反而查不到** ⇒ 不能靠 clusters 判，必须用 analyzer 的原始误差口径。

### 18.3 实测数字

| 口径 | 指标 | Before | After |
|:---|:---|:---|:---|
| 全量 36 样例 × rule | sumDelta | 204.65 | **209.95** |
| 全量 36 样例 | 基线回归 | — | **0**（vs 会话起点快照），改善 4 项 |
| real-01 包含性审计 | 越界数 / 最大越界 | 4 / 62.63px | **2 / 2.22px** |
| real-05 包含性审计 | 越界数 / 最大越界 | 2 / 15.99px | **1 / 15.98px**（`svg_53` 的 10.77px 已消除） |
| real-01 分数 | before→after | 67.95 | 69.65（Δ+1.70） |
| real-02 分数 | before→after | 67.85 | 72.15（Δ+4.30） |
| real-03 分数 | before→after | 68.55 | 69.95（Δ+1.40） |
| real-05 分数 | before→after | 70.25 | 72.55（Δ+2.30） |
| 编辑能力验收 | `edit_ux2` | — | **15/15**（`ui.html` 与产物各一遍） |
| 编辑 E2E | `edit_e2e` | 46/46 | **47/47**（新增 B3c 守「无文字选中项仍被拒、零改动」） |
| 冒烟 | `smoke_svgb` | — | stage=ready、errs=[]、failed=[] |

- **非回归口径**：相对**本会话起点快照** `sw_now.json`（sum 204.65）为 **0 回归**（`st3.json` 更早基线里 `s23=100`，本轮开工前就已经是 99.6，**不是本轮引入**）。⇒ 非回归判据必须钉会话起点，不能拿更早的历史基线当「回归」。
- 残留 **<2.3px** 越界属亚像素噪声（real-01 的 2.22 / 1.86px，肉眼不可辨）；real-05 的 `svg_16` 剩 15.98px 是**刻意取舍**（原图文字本就缺 11–16px 内边距、又被等距排版锁住，强行放大只多 1px 却破坏等距）—— **对齐优先于该处包含性**。
- 前后对照图：`assets/evidence_real-01.png`、`assets/evidence_real-05.png`（固定 1200×675 同框渲染，由 `.svgbuild/_evidence_pair.cjs` 生成）。

### 18.4 新增/改动文件

- `src/09_editor.js`（25 856 B → 44 746 B）：`fontTargets` / `_textProp` / `_needInline` / `effFontSize` / `undoTo` / `canUndoTo` / `selectDeeper` / `selectParent`，`del` 重写。
- `src/06_geometry.js`（→ 91 762 B）：`rowFamily` / `alignErrWith`，`evResize` / `evMoveText` 口径重写。
- `src/07_patch.js`：`beautify()` 接 `opAllow` 回调，批次组装前过滤。
- `ui.html`：`eDown1`/`eUp1` 按钮、`#opPanel`（改动清单：全选/全不选/应用勾选项）、轨迹行可点击回退、属性面板可用性判据改为 `!hasSel || !st.nFontTgt`、字号回填用 `st.effFontSize`、`draw()` 只画已勾选项。
- 产物 `svgb_beautifier.html`：**6 724 行 / 1 535 104 B**。
- 探针新增：`edit_ux1.cjs` / `edit_ux2.cjs` / `fit_probe.cjs` / `contain_audit.cjs` / `dim_ab.cjs` / `_evidence_pair.cjs`。

## 19. 三项反馈落地（v1.4）：正文偏右 · 编辑改动清单 · Ctrl 多选

### 19.1 「标注区域文字过于偏右」的根因与新策略 `reflow_body`

反馈：real-01 三张图标卡片（业务语义 / 业务规则 / 业务经验）里的正文被硬缩进到卡片右侧。

根因链（三条各自成立，叠加起来才让问题在旧规则下**不可见**）：

1. 原图正文本来就带一个大左缩进（实测 **93px**，而卡片左内边距只有 **23px**）—— 是设计稿里的手工换行/对齐残留。
2. `Analyzer.textFit` 用**标签并集**算 `pad`：卡片内的图标字形（如 `语` @ x=589）被并进同一容器 → 把 `pad.l` 拉到 **36px**。于是「正文左缩进 93px」在评分里**没有对应扣分项**，属于隐形缺陷。
3. 旧候选里唯一的几何手段是 `resize_container`：它只会把容器往右撑，正文仍缩在 93px —— 越修越宽、越修越偏。

新增策略 `text_overflow:reflow_body`（`06_geometry.js`，候选位排第一）：

- `bodyReflow(ir,n,st)`：以**容器内贴左的非文本形状**推断基线内边距 `basePad`（不用容器自身的 pad，因为后者被图标污染）；把正文块按「**左缘 ±1px 且字号一致**」分组，取最大一组为正文；再把正文**左归位到 `basePad`、必要时下移让开左侧图标**，**完全不改容器尺寸**。
- **为什么必须加「字号一致」判据**：同一条 real-01 上，`Runtime.load`（fresh）与 `UI.select`（DOM 态）两条路径的文本测量差 ±1px，标题(650)与正文(648)只差 2px；纯按 x 分组会随机把标题并进正文，块高从 82 涨到 129、下移后顶出容器，策略直接失效。加上「标题 30px / 正文 19px」的字号判据后彻底消抖。
- 硬校验用 `Analyzer.minPad`(=6px) 而非 `st.pad`(=16px)：该卡内容竖向需要 176px、卡高只有 190px，16px 内边距下永远无解。
- 障碍判定必须用**纵向重叠**（`bottom(obst) > bb.y && top(obst) < bottom(bb)`）而不是矩形相交：图标整块在正文左侧，矩形不相交但纵向压住首行。
- 计分 `clamp(35 + 85·cov, 0, 100)`：覆盖率高的地方必须压过 `resize_container` 的 85.31，否则永远选不中；`cov` 低时自动退回 resize。

### 19.2 编辑改动清单：可取消、可回退

编辑模式此前只有「撤销 / 重做」与「点轨迹行回退」，用户要的是**逐条**清单式管理。

- `diffSvg(a,b)`：把两步之间的 SVG 文本比成属性级差量 `{id,tag,attr,from,to}`（外加 `{add}` / `{remove}`）。
  **为什么必须存差量而不是只存快照**：`undoMgr` 的撤销栈是**线性**的，「取消第 k 步」若走 `undoTo` 会把 k+1..n 一起回退；有差量才能**定向还原**（把该步写过的值改回旧值，后续步骤原地不动）。
- `canCancel(n)` → `{mode:'targeted'|'rollback', later}`；`cancelStep(n)`：
  - **targeted**：只还原「当前值仍等于该步写入值」的属性；若属性已被后续步骤改写则**跳过并如实报告**（宁可不改，不可改错）。
  - **rollback**：含结构变更（增/删元素）的步骤无法定向还原 → 整段回退到该步之前，并报告牵连步数。
- `cancelAll()` → 退到 `entryUndo`（进编辑时的栈深），清单清空。
- UI：清单每行加**勾选框**（= 取消该步）+ 汇总「X 项已应用 · Y 项已取消」+ 顶部「↺ 全部回退」；点行仍是「回退到该步」。

两个把「代码看着对、实测不对」暴露出来的坑：

| 坑 | 现象 | 修法 |
|:---|:---|:---|
| 取消本身被记进清单 | 取消 #2 之后清单变成 4 行，多出「取消 #2（…）」，行号与用户认知错位，汇总还写着「3 项已应用」 | 引入 `_noTrack`：取消/回退期间 `flush()` 仍更新 `_sha/_lastSvg/ir/an/score`，但**不 push 记录** |
| 「回到基线」用 sha 判定恒为 false | 全部回退后分数与结构都回到基线，`sha` 却不相同 —— `undo` 走 `ChangeElementCommand.unapply` 会**替换 DOM 元素**，往返一次后属性顺序/空白被规范化 | `sameAsEntry()` 改用「**结构计数 + 分数**双等」的语义判据，并把 `shaSame` 如实报出，让「文本层差异」与「语义差异」可区分 |

### 19.3 Ctrl 多选与批量调整

诉求：同类元素要能 Ctrl 多选后**同时**改颜色 / 字号 / 位置。

- **内核事实**（读 `vendor/svgcanvas.min.js` 的 `select` 分支）：`A.includes(B) || (t.shiftKey || clearSelection(!0), addToSelection([B]), …)` —— 累加选择**只认 Shift**，Ctrl / Meta 根本没被绑定；且命中元素已在选择里时直接 `return`（为了支持"拖拽整组"），不会取消。
- **实现选型：就地改写事件为 Shift 语义**，而不是自己重写选择逻辑 ——
  `Object.defineProperty(e,'shiftKey',{value:true})`。事件对象沿 捕获→目标→冒泡 是**同一条实例**，svgcanvas 的处理器读到 `true` 后走它自己的 `addToSelection` 全链路（选择框、`justSelected`、多选拖拽、`selectionChanged` 全部一致），零重实现、零状态耦合。
- 命中判定直接用内核的 `getMouseTarget(e)`：实测（`.svgbuild/_mt.cjs`）3/3 个采样点与真实点击后的 `Editor.sel[0]` **完全一致**（点 `text#svg_12` → 选中 `g#svg_9`），空白点稳定返回 `svg#svgroot` ⇒ 不必自己猜选择粒度。
- 内核没有的两个 Ctrl 语义由本层补：
  - Ctrl+点**已选中**元素 = 取消它（内核只会 `return`）→ 拦下 mousedown，在 mouseup 调 `removeFromSelection([el])`；
  - Ctrl+点**空白** = 保持选择（内核在 shift 语义下会 `addToSelection([svgroot])`，把整张画布选进来）。
- 手势状态机有两个非显然边界：**任何 mousedown 都先清 `_ctrl`**（Ctrl+按下后拖到画布外松开时 `#stage` 收不到 mouseup，残留状态会被下一次普通 mouseup 误当成"取消该元素"）；**mouseup 分支必须在 Ctrl 判定之前**（用户可能先松 Ctrl 再松鼠标，此时 `ctrlKey` 已是 false）。且 **mouseup 一律放行、不拦**：`mode='add'` 时内核自己 `setStarted(true)` 了，mouseup 还要做多选 selector 的 resize 收尾；`mode='remove'/'blank'` 时内核从未 `setStarted`，它的 `mouseUpEvent` 开头自己就会 `return`。
- 批量写入：`fontTargets()`（含 `<g>` 下钻 + IR 标签回找）本就遍历全部选中项，`_textProp` 因此天然是批量；`move()` 用 `new Array(this.sel.length).fill(...)`；填充/描边走内核 `setColor`。三者都只产生**一条**撤销命令。
- UI 如实标注多值：`mixed()` 返回各项一致性，不一致的输入框加 `.mixed` 虚线态（颜色 / 线宽 / 字号），元素框显示**选区并集**而不是 `sel[0]` 的框。
- 已知行为（如实记录，不是缺陷）：**撤销会替换 DOM 元素 → 选择被清空**，需要重新选择。

### 19.4 实测数字（v1.4）

| 口径 | 指标 | Before | After |
|:---|:---|:---|:---|
| 全量 36 样例 × rule | sumDelta | 204.65 | **210.85**（+6.20） |
| 全量 36 样例 | 回归条数 | — | **0**（改善 4 项：real-01 +2.20 / real-02 +2.80 / real-03 +0.40 / real-05 +0.80） |
| real-01 包含性审计 | 越界数 / 最大越界 | 4 / 62.63px | **0 / 0px** |
| real-05 包含性审计 | 越界数 / 最大越界 | 2 / 15.99px | 1 / 15.98px（`svg_16`，**与 reflow_body 无关**，见下） |
| `reflow_body` 对照（real-01） | 越界数 | 禁用 = **2 / 2.22px** | 启用 = **0 / 0px**（picked=1；分数 69.65 → 70.55） |
| `reflow_body` 对照（real-05） | 越界数 | 禁用 = 1 / 15.98px | 启用 = 1 / 15.98px（picked=0 ⇒ 未参与，无影响） |
| 编辑改动清单验收 | `edit_cancel`（新增 14 项） | — | **14/14**（`ui.html` 与产物各一遍） |
| Ctrl 多选验收 | `edit_multi`（新增 18 项） | — | **18/18**（`ui.html` 与产物各一遍） |
| 编辑能力验收 | `edit_ux2` | 15/15 | **15/15**（双目标） |
| 编辑 E2E | `edit_e2e` | 47/47 | **47/47**（双目标） |
| 冒烟 | `smoke_svgb`（产物） | — | stage=ready、errs=[]、failed=[]、36 样例 |

- real-05 的 `svg_16`（15.98px）经**禁用对照实验**确认与 `reflow_body` 无关（启用 / 禁用两次美化结果逐项相同），沿用 §18.3 的取舍：原图文字本就缺 11–16px 内边距、又被等距排版锁住，**对齐优先于该处包含性**。
- real-01 的越界则是本轮**正向改善**：禁用 `reflow_body` 时剩 2 处（2.22 / 1.86px），启用后归零。

### 19.5 新增/改动文件（v1.4）

- `src/06_geometry.js`：`LABEL.reflow_body`、`evaluate` 分支、`plan` 分支、`bodyReflow`、`evReflowBody`、`opReflowBody`。
- `src/04_analyzer.js`：`text_overflow` 候选清单加入 `reflow_body`（置于首位）。
- `src/09_editor.js`（44 746 B → **54 219 B**）：`diffSvg` / `canCancel` / `cancelStep` / `cancelAll` / `sameAsEntry` / `_noTrack` / `entryNodes` / `hitTest` / `_multiSelEv` / `addSelEl` / `removeSelEl` / `mixed` / `_effStr` / `_glog`。
- `ui.html`：`#eClr` / `#eSum` / 轨迹行勾选框、`.mixed` 虚线态、多选提示与选区并集、`#selInfo` 的 `title` 能力说明。
- 产物 `svgb_beautifier.html`：**7 294 行 / 1 573 268 B**（v1.4 轮末快照）。
- 探针新增：`edit_multi.cjs`（18 项）、`edit_cancel.cjs`（14 项）、`_api_scan.cjs` / `_mt.cjs` / `_ref_cmp.cjs`（事实探测与对照实验）。

> 上述 §18.4 / §19.5 的体积与行数是**各轮结束时的快照**，用于追溯每轮增量；**当前值见 §20**。
> 探针文件在 v1.5 迁移后由仓库根 `.svgbuild/` 移入 `tests/`，名称与断言数不变。

## 20. v1.5：目录独立为子项目（含零回归证据）

### 20.1 迁移内容

原来的目录是**散在仓库各处的**，`labs/svgb/`（源码+页面+报告）、根 `vendor/`、根 `tools/`、
根 `svgb_beautifier.html` 四份东西要一起改，且 `ui.html` 里的相对路径带 `../../` 前缀。
本轮把它们**统一收进 `svgedit/`**，并让该目录成为**自带 `.git` 的独立仓库**：

| 迁移前 | 迁移后 |
|:---|:---|
| `labs/svgb/ui.html` / `dev.html` / `report.md` / `src/` | `svgedit/{ui.html,dev.html,report.md,src/}` |
| `vendor/`（svgcanvas IIFE 包 + 许可 + 图标） | `svgedit/vendor/` |
| `tools/`（`build_vendor.py` / `run_dev.cjs`） | `svgedit/tools/` |
| 根 `svgb_beautifier.html` | `svgedit/svgb_beautifier.html` |
| 根 `.svgbuild/`（工作台） | `svgedit/.svgbuild/`（未入库） |
| `report/assets/evidence_real-*.png` | `svgedit/assets/` |
| `report/assets/laya-*.svg`（3 张，gen 脚本的输入） | `svgedit/assets/` |
| `.svgbuild/` 里的核心验收脚本 | `svgedit/tests/`（10 个，正式化） |

新增/重写的东西：

- **`build.py`**：纯标准库，读 `ui.html` 的 `<script src>` **出现顺序**内联成单文件产物。
  「载入顺序」从此只有一处维护（旧版在 `labs/build.py`，那份随迁移删除）。
- **`.gitignore`**：本目录独立规则。`.svgbuild/`（约 65 MB，可重建）不入库；
  **产物 `svgb_beautifier.html` 明确入库**（双击即用的主交付物，规则里写了反向注释防止被误加）。
- **`README.md`**：GitHub 风格（特性 / 快速开始 / 目录树 / 架构图 / 评分模型 / 验收表 / 依赖 / 许可）。
- **`LICENSE`**：MIT（与所打包的 svgcanvas 上游一致），vendor 部分指向 `vendor/svgcanvas.LICENSE.txt`。
- **`tests/gen_realsvgs.py` 修了一个会写坏目录的真缺陷**：它的 `OUT` 仍写着 `ROOT/"labs"/"svgb"/"src"/"11_realsvgs.js"`。
  这串是**路径分段**写法，躲过了上一轮按 `labs/svgb` 字面量做的批量改写 —— 一旦有人重跑它，
  会把已删除的 `labs/svgb/src/` **重新创建**出来，产物则悄悄写到那里、产品用的 `src/11_realsvgs.js` 不动。
  现在 `ROOT` 收窄为 `svgedit/`，输入改为项目内的 `svg/` 与 `assets/`，输出为 `src/11_realsvgs.js`。
  **验证方式**：改完直接重跑，与入库版本比只有 **10 行**差异，且全部是 `file:` 元数据路径与表头
  （旧值 `svgedit/svg/…` / `report/assets/…` 是**仓库根相对**路径，迁移后正确值是项目内相对路径 `svg/…` / `assets/…`），
  体积 79 274 → 79 201 B，**恰好等于路径变短的字符数（-73）**。⇒ 脚本路径已修对，且旧文件里遗留的根前缀被顺带规范化。
  （该文件随后又因行尾统一由 79 201 → **79 125 B**，见 §20.5；两处变化互不重叠。）

路径改写覆盖 `src/*.js`、`ui.html` / `dev.html`、`tools/*`、`tests/*` 与文档里的相对引用
（`labs/svgb/` → 空、`"../../vendor/` → `"vendor/`、`labs/build.py` → `build.py`、
`report/assets/evidence_` → `assets/evidence_`）。终态残留检查：`labs/svgb` 命中 **0**、`../../vendor` 命中 **0**；
`build.py` 里仍提到 `labs/build.py` 是**故意**的（说明旧脚本已被取代）。

### 20.2 构建脚本里修掉的两个记账缺陷

**缺陷 1 · 码点数被当成字节数报。** `build.py` 早期把每段体积打成 `len(js)` —— 那是**码点数**，
不是字节数。源码混有大量 CJK，两者差 1.2~1.4 倍（`src/09_editor.js`：**57 099 码点 / 71 541 B**），
标成 `B` 会让人误读体积。现在两个数都打。

**缺陷 2 · 「行尾被规范化」的判据写反了。** 第一版把告警条件写成 `码点数 == 磁盘字节数`，
可是 CJK 文件的这两个数**永远不等**，于是每一行都会挂上"行尾已规范化"的尾巴 —— 真告警被噪声淹没。
正确判据是 **`内联字节数 != 磁盘字节数`**：仓库口径是 LF 时两者恒等，一旦不等就说明该文件带了 CRLF。

配套新增 `--verify`：构建到内存后剥掉 banner 时间戳，与磁盘产物**逐字节**比对。
它同时兜住了上面两条 —— 只要记账口径或内联顺序被改坏，这个断言就会失败。

### 20.3 零回归证据（分三层）

**第 1 层 · 全量扫描逐条对照（最强）**

用**迁移前 17:48 的快照** `.svgbuild/sweep_now.json` 与迁移后重跑结果逐条比：

| 口径 | 迁移前 | 迁移后 |
|:---|:---|:---|
| 样例条数 / id 集合 | 36 / — | 36 / **完全相同** |
| `before` / `after` / `delta` / `acc` / `rej` / `rounds` / `defects` 字段级差异 | — | **0 条** |
| sumDelta | 210.85 | **210.85** |

**第 2 层 · 双目标探针全绿**

| 探针 | `ui.html` | `svgb_beautifier.html` |
|:---|:---|:---|
| `edit_e2e`（47 项） | **47/47** | **47/47** |
| `edit_multi`（18 项） | **18/18** | **18/18** |
| `edit_ux2`（15 项） | **15/15** | **15/15** |
| `edit_cancel`（14 项） | **14/14** | **14/14** |

**第 3 层 · 冒烟与审计**

- `smoke_svgb`：`stage=ready`、`errs=[]`、`failed=[]`、`imgPath='vendor'`（说明 `vendor/rotate.svg` 解析正确）、
  samples=36、四视图可画、**视图非侵入性哈希一致**（切换全部视图前后 SVG sha 相同）。
- `contain_audit real-01`：越界 **4 / 62.63px → 0 / 0px**，与 §19.4 记载一致。

### 20.4 当前尺寸（§20 口径，取代 §18.4/§19.5 的快照值）

| 文件 | 行数 | 体积 |
|:---|:---|:---|
| `ui.html` | 1 458 | 79 569 B |
| `svgb_beautifier.html`（产物） | **7 425** | **1 578 008 B** |
| `src/`（11 个模块合计） | 5 833 | 384 990 B |
| `vendor/svgcanvas.min.js` | 106 | 1 113 445 B |
| `dev.html` | 117 | 5 736 B |
| `report.md`（本文件） | 901 | 82 471 B |

产物与源的账能对上：内联 JS **1 498 435 B**（12 段，`build.py` 实测）+ HTML 外壳 79 573 B = 1 578 008 B。
（注意「内联 JS」也有两套数：码点 1 445 284 / UTF-8 字节 1 498 435，见 §20.2。）
`build.py` 输出的 12 行现已**全部满足「磁盘字节数 == 内联字节数」**——这是 §20.5 行尾统一后的直接可观测结果。

### 20.5 行尾确定性：从「不可复现」到钉死为 LF

**问题**：本目录的**体积数字会写进本报告与 README**，还被 `build.py --verify` 用来断言可复现。
而本机 git 的 `core.autocrlf=true`（Windows 默认），仓库又没有 `.gitattributes` —— 意味着
**同一份提交在新克隆里会被检出成 CRLF**，单文件产物凭空多出约 7 KB，报告里所有字节数当场失效。

更隐蔽的是**生成脚本自己会写出 CRLF**：`src/11_realsvgs.js` 由 `tests/gen_realsvgs.py` 生成，
而它用的是 `Path.write_text()` —— `newline=None` 会把 `\n` 翻译成 `os.linesep`，
于是在 Windows 上**每重跑一次就产出一次 CRLF**。这就是"生成物行尾不稳定"的根因。

**修法（两条一起做才有意义）**：

1. 新增 `.gitattributes`：`* text=auto eol=lf` 钉死文本口径，并显式标 `*.png binary` 等
   （否则二进制会被 `text=auto` 误判，`assets/evidence_*.png` 里恰好含 `\r\n` 字节序列）。
2. `tests/gen_realsvgs.py` 改为显式 `newline="\n"` 写入（与 `build.py` 的口径一致）。

**迁移前工作区实测有 5 个 CRLF 文本文件**，全部规范为 LF：

| 文件 | CRLF 行 | 体积变化 |
|:---|:---|:---|
| `src/06_geometry.js` | 1 749 | 100 447 → 98 698 B |
| `svgeditAndLaya-v1.md` | 2 027 | 35 067 → 33 040 B |
| `scgeditAndLaya-v1.1.md` | 1 304 | 23 532 → 22 228 B |
| `src/07_patch.js` | 313 | 17 382 → 17 069 B |
| `src/11_realsvgs.js` | 76 | 79 201 → 79 125 B |

**验证**：

- `gen_realsvgs.py` 重跑两次 → `src/11_realsvgs.js` **逐字节一致**（确定性修复生效）。
- 统一行尾后重建产物：**1 578 008 B 不变** —— 因为 `read()` 本来就会把 CRLF 规范化，
  所以产物从来没有受过影响，变的只是"磁盘字节数"这个**被写进文档的数字**。
- 全套探针复跑：`edit_e2e` 47/47、`edit_multi` 18/18、`edit_ux2` 15/15、`edit_cancel` 14/14（双目标）；
  全量 36 样例与迁移前快照**字段级差异 0 条**，sumDelta 仍为 210.85。

## 附录 A · 复用既有成果的接口清单

| 复用对象 | 版本/路径 | 本产品用到的能力 |
|:---|:---|:---|
| `@svgedit/svgcanvas`（解析/视图） | 7.4.2，`vendor/svgcanvas.min.js`（1 113 445 B） | `setSvgString` / `getSvgString` / `getSvgRoot` / `getSvgContent` / `setZoom` / `setResolution` / `getResolution` |
| `@svgedit/svgcanvas`（**编辑**，§15） | 同上，**零新增依赖** | 选择 `selectOnly`/`getSelectedElements`/`clearSelection` · 属性 `setColor`/`setStrokeWidth`/`changeSelectedAttribute` · 文本 `setFontSize`/`setFontFamily`/`setBold`/`setItalic`/`setTextAnchor`（`setTextContent` 本宿主不可用，见 §15.6-1） · 几何 `moveSelectedElements`/`setRotationAngle`/`flipSelectedElements`/`alignSelectedElements` · 结构 `groupSelectedElements`/`ungroupSelectedElement`/`cloneSelectedElements`/`copySelectedElements`/`pasteElements`/`deleteSelectedElements`/`moveToTop`/`moveToBottom`/`moveUpDownSelected` · 历史 `undoMgr.undo/redo/addCommandToHistory` + `history.BatchCommand`/`history.ChangeElementCommand` |
| Laya 决策服务 | `http://127.0.0.1:8771` | `/api/health`、`/api/predict`（`forward_passes = 1`） |
| 无头浏览器驱动 | `tools/run_dev.cjs` 同款 `playwright-core` + 系统 Edge | 端到端探针 |
| 构建脚本 | `build.py` | 已扩展 `svgb` 目标 + Windows 化 node 解析 |

## 附录 B · 关键实现决策（为什么这么做）

| 决策 | 备选方案 | 为什么选它 |
|:---|:---|:---|
| 修改直接在活 DOM 上做，不走「导出字符串再载入」 | 每步导出/载入 | 避免元素身份丢失与编辑器辅助层污染；导出只用于最终交付与回滚快照 |
| 生效校验的最小单元是「一条 issue 的整组动作」 | 单个 op | 等距分布/画布重平衡是原子操作，逐 op 判定会把整组拆散（实测 canvas 归零） |
| op 级归因用 `gateKey = issueType\|strategy` | 含元素 id 的键 | 一类问题的修复天然是原子组；带元素 id 会让同一 op 被重试 26 次 |
| 画布收尾单独成阶段且幂等 | 混在普通 op 里 | 撑大内容盒的 op 必须与「补对称留白」同批校验，否则单看 op 就是 canvas 劣化 → 误杀 |
| 叠加层挂在 svgcanvas 挂载点的**兄弟容器** | 挂在其容器内 | svgcanvas 会重建自己容器内的 DOM，叠加层会被连带清掉 |
| 非编辑模式的输入守卫挂 `#stage` 的**捕获阶段** | 挂 `#host` 上用 `stopPropagation` 阻断 | svgcanvas 的 `mousedown` 就注册在 `#host` 自身，同节点监听器之间阻断不了（需 `stopImmediatePropagation` 且受注册顺序制约） |
| 编辑工具条留在流内、让画布让位 76 px | 做成覆盖式浮层 | `#host` 与 svgroot 同尺寸时无法滚动，浮层盖住的 68 px 会变成永久不可达的盲区；位移只是坐标问题，盲区是可用性问题 |
| `setText` 自己改 `textContent` + 官方撤销命令类入栈 | 用 `canvas.setTextContent` / `changeSelectedAttribute('#text')` | 两者在本宿主一个抛异常、一个不入撤销栈（旧值走 `getAttribute('#text')` 恒为 null），实测对照见 §15.6-1 |
| `run()` 失败时**也**冲刷轨迹 | 失败直接 return | svgedit 存在「先改 DOM 再抛异常」的 API，跳过冲刷会让改动从轨迹里消失 |
| 文本守卫只看顶层选中元素、不下钻 `<g>` | 下钻组内文本，让「选中组也能改字号」 | 下钻放行后 svgcanvas 对 `g` 执行 `g.textContent=` 会抹掉全部子元素（探针 diff 拍到现场），拒绝必须等于零改动 |
| 「可见手柄」按渲染盒计数 | 按 `visibility`/`display` | 未选中时 10 个手柄的样式全是 visible、渲染盒全是 0×0，按样式判恒报 10 |
| 属性面板在 `selected` 事件**下一帧**补画一次 | 同帧读手柄数 | svgcanvas 的手柄在事件之后才渲染，同帧取值恒为 0（面板显示 0、画面有 9） |
| 导出前用 `repairDims` 兜底 width/height | 直接导出 | `baseUnit` 缺失会写出 `width="NaN"`，往返后画布塌成 100×100 |
| 字号/字体等文本属性走「表现属性 + 内联 `style` **双写**」 | 只写表现属性 | Illustrator 导出件的 `font-size` 写在作者 `<style>` 类规则里，表现属性被层叠压过（实测：改了 `font-size` 属性但 computed 值不变）；`_needInline()` 试写后比对 computed 才判定要不要双写 |
| 取「要改的文字」用 IR 标签关联**回找** | 只做 DOM 子节点下钻 | 点卡片底板命中的是 `rect`，文字是它的**兄弟节点**，纯 DOM 下钻永远够不到（实测 0 命中） |
| 变更撤销入栈把旧 `style` 一并记进命令 | 只记属性名 | `ChangeElementCommand` 的 `unapply` 对 null 走 `removeAttribute`，「原本无 style」的情形也能精确还原 |
| 美化改动清单在**批次组装前**过滤被取消项 | 先全量执行再回滚被取消项 | 回滚会产生可见抖动，且污染撤销栈与台账（日志会多出一批「已回滚」噪声） |
| 同族放大按**族内最大需要**取统一宽高 | 各卡片各自放大到自己够用 | 各自放大 → 宽高不齐 → 对齐劣化 → 整批被 op 级门回滚（s32 实测 8.3 → 1.5） |
| 生长方向按 **analyzer 原始对齐误差**择优 | 固定向右/向下生长 | 固定方向会把完全对齐的中心线推歪（real-05 resize 批因 alignment −8 被整批否决）；且 `clusters` 判据对 `spread≈0` 的组失效（完全对齐反而不在 clusters 里） |
| 轨迹「点击回退到第 n 步」按 **undo 栈深**回退 | 重放变更 / 反向执行 | 重放需重建 DOM 状态且易漂移；`undoTo` 走到栈深 + `undoMgr.undo` 是唯一能精确回到该步的路径（探针断言「撤销栈真的减小 + 内容真的变」） |
| Ctrl 多选就地改写事件为 Shift 语义 | 自己重写一套多选逻辑 | svgcanvas 的选择链路（选择框 / justSelected / 多选拖拽 / selectionChanged）全在它自己的 `addToSelection` 里，同一事件对象上改 `shiftKey` 即可完全复用，零重实现、零状态耦合 |
| Ctrl+点已选中元素用 mouseup 时 `removeFromSelection` | mousedown 时立刻移除 | mousedown 立刻改选择会让内核的 mouseup 收尾看到不一致的选择态；现行做法拦下整个手势再在 mouseup 统一收尾 |
| Ctrl 手势的 mouseup 一律放行不拦 | 与 mousedown 对称地拦掉 | `mode='add'` 时内核自己 `setStarted(true)`，mouseup 还要做多选 selector 的 resize 收尾；`remove`/`blank` 时内核从未 setStarted，它自己的 `mouseUpEvent` 会 `return`。放行是两侧都安全的那一个选择 |
| 取消/回退期间 `flush()` 不 push 记录（`_noTrack`） | 让取消也进清单 | 取消是「对清单的操作」，不是新的编辑改动；记进去会让清单自我繁殖（出现「取消 #2」这种行），行号与用户认知错位 |
| 「回到基线」判据用结构计数 + 分数双等 | 只比 sha | `undo` 会替换 DOM 元素，往返一次后属性顺序/空白被规范化 → sha 恒不同（实测分数与结构全等）。语义判据才是用户关心的；shaSame 仍如实报出以便区分差异层次 |
| 正文分组加「字号一致」判据 | 只按左缘 ±1px 分组 | 同一内容在 fresh/DOM 两条路径上文本测量差 ±1px，标题与正文只差 2px，纯 x 分组会随机并错、块高翻倍后顶出容器 |
| `reflow_body` 的硬校验用 `Analyzer.minPad` | 用 `st.pad` | 实测卡内容竖向需要 176px、卡高仅 190px，16px 内边距下永远无解；minPad(=6) 才是「不越界」的真实下限 |
| 正文让开障碍用纵向重叠判定 | 矩形相交 | 图标整块在正文左侧、矩形不相交却纵向压住首行 |

---

## §21 运行时缺陷修复：选中（文字）元素崩溃

### 21.1 现象（用户报告）
进入编辑模式后，**选中一个文字元素去编辑时**抛出：

```
Uncaught TypeError: Cannot read properties of null (reading 'focus')
    at Object.init (svgb_beautifier.html:377)
    at toEditMode  (svgb_beautifier.html:377)
    at select     (svgb_beautifier.html:377)
    at mouseDown  (svgb_beautifier.html:377)
```

并附带一条浏览器控制台警告（仅 `file://` 直接打开时）：
`Unsafe attempt to load URL file:///.../vendor/... 'file:' URLs are treated as unique opaque origins.`
（后者是 svgcanvas 的 `cursor: url('vendor/rotate.svg')` 在 file:// 下的无害告警，不影响功能；见 21.5。）

表象是「选中其它元素报错、无法选中」——第一次能选（非文字元素、或不走该路径），
第二次选到文字元素就崩，选中链路被异常中断。

### 21.2 根因
崩溃栈全部落在 svgcanvas 内置的**画布内文本编辑器**上，与 `Editor` 层无关：

- 调用链 `select → toEditMode → init` 来自 svgcanvas 内部的 `selected` 事件处理器
  （dist/svgcanvas.js，已压缩为 `Wr`）：
  ```js
  // 选中 <text> 且当前不在 textedit 模式时，自动进入画布内文本编辑
  if (i === "text" && G.getCurrentMode() !== "textedit") {
    let t = F(e.clientX, e.clientY, G.getrootSctm());
    G.textActions.select(r, t.x, t.y);   // → toEditMode → init → this.#textinput.focus()
  }
  ```
- `init()` 第一行就是 `this.#textinput.focus()`；`#textinput` 是隐藏输入框，
  只有宿主调过 `textActions.setInputElem(...)` 才会有值。**本宿主从未调用过**，
  所以 `#textinput` 恒为 `null` → 抛 `reading 'focus'`。
- **第二条同源路径**（更隐蔽）：字体 API `setFontSize/setFontFamily/setBold/...`
  在末尾会调 `textActions.setCursor()`，而 `setCursor()` 第一件事也是
  `this.#textinput.value` / `.focus()`。用户在侧栏面板改选中文字的字号/字体时同样会崩。

也就是说，崩的根子是本产品**根本没用** svgcanvas 的画布内编辑器（文本编辑改走自己的
侧栏面板 `#eText` → `Editor.setText`），却没把它的自动触发关掉，也没给它喂那个隐藏输入框。

### 21.3 修复
在 `src/02_runtime.js` 的 `Runtime.mount()` 末尾（canvas 建好之后）新增
`_neutralizeBuiltinTextEditor()`：

1. **安全网**：建一个隐藏 `<input>` 并 `textActions.setInputElem(inp)`，
   保证任何 `.focus()/.value` 访问都不因 null 而崩（即便仍有其它路径触发 init/setCursor）。
2. **主修复**：把 `textActions` 的四条入口 `select / start / init / setCursor` 改造成空实现
   —— 文字元素像普通元素一样被正常选中（显示抓手、填充属性面板），不再进入 textedit
   模式（不隐藏抓手、不画闪烁光标），也不再因 `#textinput` 为 null 而崩。

> 只改这四条是因为其余的 `mouseDown/mouseMove/mouseUp/toEditMode/toSelectMode` 只在
> `textedit` 模式下才被调用；既然 `select/start` 已被拦截、不会再进入该模式，它们不会被触发。

### 21.4 验证（零回归证据）
新增回归探针 `tests/regress_text_select.cjs`（真实无头 Edge + 真实 svgcanvas@7.4.2），
做法：进入编辑模式 → 载入带文字的真实 SVG（47 个 `<text>`）→ 真实点击 15 个文字元素中心 +
直接调用崩溃入口 `Runtime.canvas.textActions.select(textEl,0,0)`，全程捕获 `pageerror`。

- **A/B（修复前 vs 修复后，同一份 `svgb_beautifier.html` 产物）**：
  | 版本 | 崩溃入口 `textActions.select` 抛错 | `null.focus` 类 pageerror | 文字元素可被正常选中 |
  |:---|:---:|:---:|:---:|
  | 修复前 | **是**（`progCrashed: true`） | 0（真实点击多命中覆盖层，靠确定性入口坐实） | — |
  | 修复后 | 否（`progCrashed: false`） | **0** | **是**（`anyTextSel: true`） |
- **既有编辑探针全绿（修复后）**：`edit_e2e 47/47`、`edit_multi 18/18`、
  `edit_ux2 15/15`、`edit_cancel 14/14` —— 无回归。
- 产物逐字节可复现：`python build.py --verify` → OK。

### 21.5 关于 file:// 警告
`Unsafe attempt to load URL file:///.../vendor/...` 来自 svgcanvas 给选择手柄设置的
`cursor: url('vendor/rotate.svg')`。只有当用户**直接双击本地 html 用 file:// 打开**时才出现，
经 http(s) 部署时不出现；它只是控制台告警，**不抛异常、不影响选中与编辑**。
如需彻底消除，可在 `svgb_beautifier.html` 经 http(s) 托管（推荐），或后续把该 cursor
改为内联 data-URI（会动到 svgcanvas 的 imgPath 机制，留作可选优化）。

---

## §22 Wireframe 视图应「只显示黑白」

### 22.1 现象（用户反馈）
切到 Wireframe 视图后，画面**仍有颜色**：既能看到原始彩色的 SVG 内容透出来，
叠加的骨架线本身也是蓝/青/橙（node `#2f6fed` / edge `#0d9488` / baseline `#c2740a`）。
预期：Wireframe 只显示黑白灰的结构骨架。

### 22.2 根因
Wireframe 是**非侵入叠加层**（`src/08_ui.js` 的 `Views`）：它在 svgcanvas 之上叠一个
独立的 `svg.svgb-ovl`，**原始内容 DOM 一字不改**。因此切到 wireframe 时：
- 原始彩色内容 `#svgcontent` 从头到尾都是可见的，只是被骨架线盖了一层 → 颜色透出；
- 骨架线本身还用了彩色 PAL（`Views.PAL`），并非黑白。

### 22.3 修复
两处，均在视图层，不改内容 DOM：
1. **隐藏原始内容**：`ui.html` 的 `setView(v)` 在切到 wireframe 时给 `#stage` 加
   `wf-content-hidden` 类，配套 CSS `#stage.wf-content-hidden #svgcontent{visibility:hidden}`；
   切到 original/diagnostic/proposed 时移除该类 → 内容恢复。`visibility` 不改布局，
   叠加层靠 `getScreenCTM` 对齐依旧准确；用 class 而非给 `#svgcontent` 写 inline style，
   是为了不被 svgcanvas 内部对 `#svgcontent` 的 transform 等 inline 样式覆盖。
2. **骨架纯黑白灰**：`Views.PAL` 新增 `wf:{node:'#1f1f1f',nodeFill:'rgba(0,0,0,0.04)',
   edge:'#333333',baseline:'#555555'}`，`wireframe()` 改用它，去掉全部彩色。
   （diagnostic/proposed 仍需优先级配色，保持原 PAL 不动。）

### 22.4 验证
新增 `tests/regress_wireframe.cjs`（无头 Edge）：载入真实样例 → 切 wireframe →
断言 `#svgcontent` 计算样式 `visibility==='hidden'`、骨架 wf 组的 stroke/fill 不含任何彩色 PAL 值；
再切回 original / diagnostic 断言内容恢复可见。结果 6/6 通过，无 pageerror。


