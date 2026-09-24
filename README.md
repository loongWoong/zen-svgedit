<div align="center">

# SVG Beautifier · svgedit × Laya

**借助 svgedit 的解析能力与 Laya 的局部判断能力，把一张有缺陷的 SVG 图自动美化并修正 —— 每一步改动都可验证、可回退。**

[![version](https://img.shields.io/badge/version-v1.4-2f6fed?style=flat-square)](report.md#19-三项反馈落地v14正文偏右--编辑改动清单--ctrl-多选)
[![build](https://img.shields.io/badge/build-python%20stdlib%20only-38a169?style=flat-square)](#-快速开始)
[![runtime](https://img.shields.io/badge/runtime-%40svgedit%2Fsvgcanvas%207.4.2-8b5cf6?style=flat-square)](#-依赖)
[![deps](https://img.shields.io/badge/node-not%20required-9aa5b1?style=flat-square)](#-依赖)
[![license](https://img.shields.io/badge/license-MIT-0d9488?style=flat-square)](#-license)

</div>

---

## 这是什么

输入一张排版有问题的 SVG（文字溢出容器、元素重叠、间距不齐、连线穿越节点、样式杂乱……），
输出一张**修好的** SVG，并给出**每一步改了什么、分数涨了多少**的账本。

它不是"再画一遍"，而是**在原有图元上做最小必要改动**：

- 读入后用 IR（Diagram IR）还原出「节点 / 边 / 自由文本 / 容器分组」，而不是只当字符串处理；
- 缺陷定位与操作选择**双路**：确定性几何规则 + Laya 模型的局部判断；
- 每个操作都要过**验证器**（整轮门 + 单操作门），不通过就回滚——**"不得越改越丑"是可执行断言，不是口号**；
- 全流程数字（分数、涨跌、接受/拒绝次数）都由真实无头浏览器跑批产出，`report.md` 里每个数字都附可重跑命令。

> **本项目参考并复用开源项目 [`SVG-Edit/svgedit`](https://github.com/SVG-Edit/svgedit)。**
> 它发布的 `@svgedit/svgcanvas` 提供了 SVG 的解析、渲染与编辑内核（选择 / 属性 / 几何 / 历史撤销栈），
> 本项目在此内核之上实现缺陷诊断、几何修复、验证器闭环与产品内编辑。完整说明见「[参考项目与致谢](#-参考项目与致谢)」。

---

## ✨ 特性

### 一键美化

| 能力 | 说明 |
|:---|:---|
| **7 维诊断** | 碰撞 / 文本 / 对齐 / 间距 / 连线 / 样式 / 画布 —— 加权成 0~100 质量分 |
| **20 个操作标签** | 17 个实体动作（放大容器、正文左归位、推开重叠、等间距分布、正交避障重路由、样式归一、画布留白平衡……）+ 3 个「保持 / 忽略」兜底 |
| **三策略对照** | `rule`（纯几何）/ `mix`（几何 + 模型裁决）/ `model`（模型主导），可现场切换对比 |
| **验证器闭环** | 每个操作先试做再验证；分数不升或违反硬约束 → 拒绝并回滚，账本如实记录 `accepted / rejected` |
| **可复现** | 同输入同 seed → 同输出（`01_util.js` 内置可复现随机） |

### 产品内直接编辑（v1.3 / v1.4）

| 分组 | 操作 |
|:---|:---|
| 属性 | 填充色、描边色、线宽、字号、文本内容、加粗、斜体（多选时**批量生效**） |
| 几何 | 微移 ±2px、旋转、对齐（单选相对画布 / 多选相对选区）、水平/垂直翻转 |
| 结构 | 成组、解组、上/下移一层、置顶/置底、原地副本、删除 |
| 选择 | **选择下钻**（点中的常是最外层 `<g>`）、上钻、**选同类**、**Ctrl 多选** |
| 历史 | 撤销 / 重做、**改动清单**（逐条可取消）、**定向取消第 k 步**、整段回退、全部回退 |

三个不易做对的点，这里都做实了：

- **Ctrl 多选**：`@svgedit/svgcanvas` 的累加选择**只认 Shift**（`A.includes(B) || (t.shiftKey || clearSelection(!0), …)`），Ctrl 根本没绑定。
  本实现不去重写选择逻辑，而是在捕获阶段把事件**就地改写为 Shift 语义**（`Object.defineProperty(e,'shiftKey',{value:true})`），
  让内核自己的 `addToSelection` 全链路（选择框 / `justSelected` / 多选拖拽 / `selectionChanged`）原样复用。
  再补两个内核缺的语义：Ctrl+点**已选中** = 取消该元素，Ctrl+点**空白** = 保持选择。
- **改动清单可定向取消**：`undoMgr` 的撤销栈是**线性**的，"取消第 k 步"若走 `undoTo` 会连带回退 k+1..n。
  因此每一步都存**属性级差量** `diffSvg(a,b)`，取消时只把「该步写过、且当前值仍是该步写入值」的属性改回去，后续步骤原地不动；
  若该步含结构变更（增删元素）无法定向还原，则**如实降级**为整段回退并报告牵连步数。
- **「回到基线」不能拿 SHA 判**：`undo` 走 `ChangeElementCommand.unapply` 会**替换 DOM 元素**，往返一次后属性顺序/空白被规范化，
  文本层 sha 永远不同。所以判据是「结构计数 + 分数」双等的语义比较 `sameAsEntry()`，并把 `shaSame` **如实**报出，让「文本层差异」与「语义差异」可区分。

### 视图叠加（非侵入）

`wireframe`（三级 / zoom-aware）/ `diagnostic` / `proposed` 三种叠加视图全部画在**独立叠加层**，不触碰被编辑的 DOM ——
冒烟测试里以「切换全部视图前后，SVG 文本 sha 完全不变」作为可执行断言。

---

## 🚀 快速开始

### 直接用（零安装）

`svgb_beautifier.html` 是**把所有依赖内联好的单文件产品页**，直接双击即可：

```bash
# Windows
start svgb_beautifier.html
# macOS
open svgb_beautifier.html
```

### 从源码重建（只需 Python，**不需要 node**）

```bash
python build.py            # 产出 svgb_beautifier.html
python build.py --check    # 只校验：源是否齐全 / 是否残留外链
python build.py --verify   # 构建到内存，断言与磁盘产物逐字节一致（可复现性）
```

构建脚本读 `ui.html`，按其中 `<script src="…">` 的**出现顺序**逐个内联。
因此「载入顺序」只有一处维护，构建脚本不需要额外维护一份清单。

### 跑验收探针（可选，需要本机有 Edge）

```bash
# 一次性准备依赖（不污染仓库：.svgbuild/ 已被 .gitignore 排除）
mkdir -p .svgbuild && (cd .svgbuild && npm install playwright-core --no-save)

export NODE_PATH="$PWD/.svgbuild/node_modules"

node tests/edit_e2e.cjs                     # 产品内编辑全量      47/47
node tests/edit_ux2.cjs                     # 编辑自由度/对齐感知  15/15
node tests/edit_multi.cjs                   # Ctrl 多选 + 批量     18/18
node tests/edit_cancel.cjs                  # 改动清单可取消       14/14
node tests/smoke_svgb.cjs                   # 产物冒烟（双击那条路）
node tests/sweep_rule.cjs                   # 全量 36 样例 × rule
node tests/contain_audit.cjs real-01        # 包含性审计

# 同一批探针验单文件产物：
SVGB_TARGET=svgb_beautifier.html node tests/edit_e2e.cjs
```

> 探针以 `file://` 加载页面并驱动**真实无头 Edge**，不依赖任何 mock。
> 默认浏览器路径写死在 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，换机器需改这一行。

---

## 📁 目录结构

```
svgedit/
├── ui.html                  # 产品页（源码形态：直连 vendor + src，可断点调试）
├── svgb_beautifier.html     # ★ 单文件产物：8 694 行 / 1 732 346 B（由 build.py 生成）
├── dev.html                 # 开发验证台：全量矩阵 / 往返 / 锚点探针
├── build.py                 # 构建脚本（仅标准库）
├── report.md                # 实现报告：全部数字可复跑
├── LICENSE                  # MIT（vendor 部分遵循上游 MIT）
├── .gitignore               # 独立忽略规则（.svgbuild/ 不入库，产物入库）
├── .gitattributes           # 行尾钉死为 LF + 二进制声明
├── svgeditAndLaya-v1.md     # 设计文档 v1
├── scgeditAndLaya-v1.1.md   # 设计文档 v1.1
│
├── src/                     # 11 个源码模块（共 384 990 B）
│   ├── 01_util.js           #   纯函数：矩阵 / 矩形 / 折线采样 / 可复现随机 / SHA-256
│   ├── 02_runtime.js        #   SVG 运行时（包 svgcanvas）+ 世界坐标 + 文本测量
│   ├── 03_ir.js             #   Diagram IR：节点 / 边 / 自由文本 / 容器分组 / 方言识别
│   ├── 04_analyzer.js       #   7 维诊断 + 质量评分 + Issue 模型
│   ├── 05_laya.js           #   Laya 客户端 + 问句构造 + 决策合成（rule / mix / model）
│   ├── 06_geometry.js       #   确定性几何引擎：op 构造器 + 策略顺位回退（最大单文件）
│   ├── 07_patch.js          #   Patch 引擎 + 验证器（整轮门 + op 门）+ 回滚闭环
│   ├── 08_ui.js             #   非侵入叠加视图：wireframe / diagnostic / proposed
│   ├── 09_editor.js         #   产品内直接编辑 + 变更轨迹 + 实时重评分
│   ├── 10_samples.js        #   缺陷注入式样例集（模型层注入 → 真值精确）
│   └── 11_realsvgs.js       #   9 张真实产出图内联
│
├── vendor/                  # svgcanvas IIFE 包 + 许可 + 图标（见「依赖」）
├── tools/                   # build_vendor.py（可复现地重打 vendor）、run_dev.cjs
├── tests/                   # 端到端探针与验收脚本
├── assets/                  # 证据截图（real-01 / real-05 前后对照）+ 3 张报告配图（gen 脚本的输入）
├── svg/                     # 样例 SVG
└── .svgbuild/               # 【未入库】开发工作台：诊断脚本 / 快照 / node_modules（约 65 MB）
```

> `.svgbuild/` 里的历史快照（`st3.json`、`sw_now*.json` …）是对照基线的来源，体积大但**可由 `tests/` 重建**，所以不入库；
> `report.md` 里凡引用快照的地方都同时给了重建命令。

---

## 🏗 架构

```
                       ┌──────────────────────────────────────────┐
   输入 SVG 文本 ──────▶ │ 03_ir.js   Diagram IR                    │
                       │   节点 / 边 / 自由文本 / 容器 / 方言识别   │
                       └────────────────┬─────────────────────────┘
                                        ▼
                       ┌──────────────────────────────────────────┐
                       │ 04_analyzer.js  7 维诊断 + 质量分 + Issue │
                       └────────────────┬─────────────────────────┘
                                        ▼
        ┌───────────────────────────────┴────────────────────────────┐
        ▼                                                            ▼
┌───────────────────────┐                             ┌──────────────────────────┐
│ 06_geometry.js         │                             │ 05_laya.js               │
│  确定性几何引擎         │◀──── rule / mix / model ───▶│  局部判断 + 决策合成      │
│  op 构造器 + 顺位回退   │                             │  （不可用时降级为纯 rule） │
└───────────┬───────────┘                             └──────────────────────────┘
            ▼
┌──────────────────────────────────────────┐
│ 07_patch.js  验证器：整轮门 + op 门        │
│   不通过 → 回滚；通过 → 记入账本           │
└───────────┬──────────────────────────────┘
            ▼
┌──────────────────────────────────────────┐    ┌─────────────────────────────┐
│ 08_ui.js  非侵入叠加视图                  │    │ 09_editor.js 产品内编辑       │
│  wireframe / diagnostic / proposed        │    │ 属性·几何·结构·选择·历史清单  │
└──────────────────────────────────────────┘    └─────────────────────────────┘
                    统一构建在 02_runtime.js（svgcanvas 内核）之上
```

**关键约定：叠加层是 View，不是 Mutation。** 诊断/提案/参考线一律画在独立叠加 canvas 上，
被编辑的 SVG DOM 只在真正「应用」时被改动 —— 因此可以随时切换视图而不产生副作用。

---

## 🎛 质量评分模型

```
score = 0.25·collision   + 0.20·textFit  + 0.15·alignment + 0.15·spacing
      + 0.10·edgeRouting + 0.10·style    + 0.05·canvasBalance        （每项 0~100）
```

评分器自带**自洽性锚点**：样例集里的「干净样例」必须接近满分 —— 干净样例若被判有缺陷，说明打分器本身有 bug。
这条锚点每次跑批都会被验证，而非事后补一个数。

---

## ✅ 验收与测试

全部探针都跑**真实无头 Edge**，并同时对「源码形态 `ui.html`」与「单文件产物 `svgb_beautifier.html`」各验一遍。

| 探针 | 覆盖内容 | 结果 |
|:---|:---|:---|
| `tests/edit_e2e.cjs` | 产品内编辑全量断言 | **47 / 47**（双目标） |
| `tests/edit_ux2.cjs` | 编辑自由度 + 同族对齐感知 | **15 / 15**（双目标） |
| `tests/edit_multi.cjs` | Ctrl 多选 + 批量改属性/位置 + 选同类 | **18 / 18**（双目标） |
| `tests/edit_cancel.cjs` | 改动清单：定向取消 / 整段回退 / 回基线判据 | **14 / 14**（双目标） |
| `tests/smoke_svgb.cjs` | 产物冒烟：零 pageerror、零失败请求、四视图可画 | stage=ready，`errs=[]`，`failed=[]` |
| `tests/sweep_rule.cjs` | 全量 **36** 样例 × `rule` 策略非回归门 | sumDelta **210.85**，0 崩溃 |
| `tests/contain_audit.cjs` | 文本包含性审计（real-01） | 越界 **4 / 62.63px → 0 / 0px** |
| `tests/open_probe.cjs` | 打开本地文件四条入口 | 全通过 |

样例集构成：**36 条 = 9 张真实产出图 + 27 条缺陷注入式合成样例**（`raw` 启发式方言 / `semantic` 协议方言两种）。

---

## 📦 依赖

**运行期只有一项外部依赖**，且已随仓库内联：

| 依赖 | 版本 | 体积 | 许可 |
|:---|:---|:---|:---|
| [`@svgedit/svgcanvas`](https://github.com/SVG-Edit/svgedit) | `7.4.2` | 1 113 445 B（IIFE 包） | MIT（见 `vendor/svgcanvas.LICENSE.txt`） |

`vendor/svgcanvas.min.js` 由 `tools/build_vendor.py` 用 esbuild 打为浏览器可直接 `<script src>` 的 IIFE 全局 `SVGCanvasLib`：

```bash
python tools/build_vendor.py          # 缺 dist 时自动 npm install
python tools/build_vendor.py --force  # 强制重装后重打
```

打包过程是上游 ESM 产物的**逐字拼接**（含其运行时 helper），**未做任何源码修改**；脚本会打印体积与 sha256 便于回归比对。

**其他可选依赖**（仅开发/验收时用，均不入库）：

| 用途 | 依赖 | 说明 |
|:---|:---|:---|
| 端到端探针 | `playwright-core` + 系统 Edge | 装在 `.svgbuild/node_modules`，见「快速开始」 |
| 构建体积校验 | Python 标准库 | `build.py` 只用 `argparse` / `os` / `re` / `sys` / `time` |
| 局部判断（可选） | Laya 服务 `http://127.0.0.1:8771` | 探活失败自动降级为纯 `rule` 策略，**页面仍完全可用** |

---

## 📚 文档索引

| 文档 | 内容 |
|:---|:---|
| [`report.md`](report.md) | 实现报告：19 个章节 + 2 个附录，每个数字都附可重跑命令 |
| [`svgeditAndLaya-v1.md`](svgeditAndLaya-v1.md) | 设计文档 v1 |
| [`scgeditAndLaya-v1.1.md`](scgeditAndLaya-v1.1.md) | 设计文档 v1.1（zoom-aware wireframe、样式档位等） |
| [`assets/`](assets) | real-01 / real-05 修复前后的同框对照截图 |

---

## ⚠️ 已知边界

如实记录，不是待办清单里的"以后再说"：

1. **`real-05` 的 `svg_16` 仍有 15.98px 越界**，且经**禁用对照实验**证明与正文重排策略无关
   （启用/禁用两次美化结果逐项相同）。原图文字本就缺 11–16px 内边距、又被等距排版锁住，
   强行放大只多 1px 却破坏等距 —— 此处**对齐优先于包含性**，是取舍不是缺陷。
2. **撤销会替换 DOM 元素 → 选择被清空**，需要重新选择。这是 svgcanvas 撤销机制的直接后果，
   本层选择如实在 UI 上表现，不做假象。
3. **包含结构变更的操作无法定向取消**（增删元素类），只能整段回退 —— UI 会提前告知牵连步数，
   不会静默升级成"整段回退"。
4. **探针依赖 Windows + Edge**：浏览器路径写死在探针里，跨平台需改这一行。
5. **行尾口径钉死为 LF**：`.gitattributes` 声明 `* text=auto eol=lf`，因为本仓库的体积数字会写进
   文档与 `build.py --verify` 的断言，行尾一旦随平台漂移这些数字就失效。`build.py` 报的 12 段现已
   全部满足「磁盘字节数 == 内联字节数」；若有人引入 CRLF，构建会打出 `⚠ 磁盘 N B ≠ 内联 M B`。

---

## 🙏 参考项目与致谢

本项目**参考并复用**了开源项目：

| 项目 | 地址 | 本项目如何使用 |
|:---|:---|:---|
| **SVG-Edit / svgedit** | <https://github.com/SVG-Edit/svgedit> | 其 `@svgedit/svgcanvas`（本项目打包为 `vendor/svgcanvas.min.js`）提供 SVG 的**解析、渲染与编辑内核**：选择与命中、表现属性写入、几何变换、层级与分组、`undoMgr` 撤销栈。本项目的缺陷诊断、几何修复、验证器闭环与产品内编辑都建立在这层内核之上。 |

具体地，本项目直接使用了上游的以下能力（完整清单见 `report.md` 附录 A）：

- **解析 / 视图**：`setSvgString` / `getSvgString` / `getSvgRoot` / `getSvgContent` / `setZoom` / `setResolution`；
- **编辑**：`selectOnly` / `getSelectedElements` / `clearSelection`、`setColor` / `setStrokeWidth` /
  `changeSelectedAttribute`、`moveSelectedElements` / `setRotationAngle` / `flipSelectedElements` /
  `alignSelectedElements`、`groupSelectedElements` / `ungroupSelectedElement` / `cloneSelectedElements` /
  `moveToTop` / `moveToBottom`、`undoMgr.undo/redo/addCommandToHistory` 等。

打包方式：`vendor/svgcanvas.min.js` 由 `tools/build_vendor.py` 用 esbuild 打成浏览器可直接
`<script src>` 的 IIFE 全局 `SVGCanvasLib`。它是上游 ESM 产物的**逐字拼接**（含上游自带的 `pathseg`
运行时 helper），**未对上游源码做任何修改**。

感谢 **SVG-Edit contributors**（Pavol Rusnak、Jens Diemer、Vidar Hokstad、Alexis Deveria、Brett Zamir、
Fabien Jacq、OptimistikSAS、Narendra Sisodiya）以及所有 svg-edit / svgedit 的贡献者。

> 命名说明：本目录名 `svgedit` 与上游项目同名，是为标明技术来源；本项目是**独立仓库**，
> 与上游 [SVG-Edit/svgedit](https://github.com/SVG-Edit/svgedit) **无隶属或官方关系**。

---

## 📄 License

本子项目代码采用 **MIT**；随附的 `vendor/svgcanvas.min.js` 遵循其上游 **MIT**（版权归 SVG-Edit contributors，
完整文本见 [`vendor/svgcanvas.LICENSE.txt`](vendor/svgcanvas.LICENSE.txt)）。

<div align="center"><sub>本目录是 jev-zen 下的独立 git 仓库，可单独 clone / push。</sub></div>
