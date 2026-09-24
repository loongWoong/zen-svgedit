/* =============================================================================
 * SVG Beautifier · 03b 区域图 RegionGraph（F5 · 语义区域树）
 *
 * 动机：源 SVG 本来就带**显式的语义区域结构** —— 每个 section 是一段
 *   「XML 注释 + <g>（或直接一串形状）」，例如 onto 样本里的
 *   `<!-- Center platform container --> <g>…</g>`。
 * 但 03_ir.js 把整棵树压平成一张节点表，区域信息在压平那一刻就丢了：
 * 下游只能看到「39 个节点」，看不到「中央面板挤、两侧列空」。
 * Analyzer.regionMetrics（F6 第一段，只写入 raw、不进总分）一直在等 `ir.regions`，
 * 缺了这份数据它就恒返回 applicable:false —— 本模块就是它的上游供数方。
 *
 * 契约（三条硬约束）：
 *   ① **只读**：不修改 DOM、不写任何属性。
 *   ② **绝不抛错**：整个函数体包在 try/catch 里，任何内部异常都返回 null。
 *      调用方把 null 解释为「区域不可用」，所有区域级度量随即退化为 not applicable
 *      （与 06_geometry.js 对可选依赖 LayaRule 的软失败口径一致：
 *        `typeof LayaRule !== 'undefined' && LayaRule.groupByType`）。
 *   ③ **唯一归属**：每个 IR 节点属于且只属于一个区（最深的那个拥有者），
 *      byNode 是这条不变量的唯一出口，diag 里做求和断言。
 *
 * 七个非显然的设计点（都是实测逼出来的，不是推测）：
 *   1. **必须先剥包装层**。svgcanvas 载入后 `#svgcontent` 的元素子节点只有
 *      `title/desc/defs` + 一个包装 `<g class="layer">`（所有内容都在里面）。
 *      不剥的话整个图会被认成「一个区」。
 *   2. **ink 只累加叶子成员**。嵌套容器（外框包内框）会把同一块面积算两次，
 *      实测 inkDensity 会冲到 2.66 这种无意义值；去掉「含住别人的成员」后才 ≤1。
 *   3. **满版底板用面积比而不是 coverRatio**（同 03_ir.js:149-152 的 isBg）：
 *      coverRatio 按 min(面积) 归一，画布内任何元素都会 ≈1.0，会把小色块也判成底板。
 *   4. **区元素没有 IR 节点成员时，bbox 回退到元素自身的世界包围盒**。
 *      纯装饰的命名区（如 Legend：4 个 16×16 色块太小、够不上节点门槛）
 *      否则没有几何，连 band/card 都判不出来。
 *   5. **根级直属的 IR 节点各自成一区**（源图的 section 注释正是逐个元素前导的），
 *      而**组内**节点归属于所在组：否则 onto 的 7 张卡片会被拆成 7 个区，
 *      得不出「左侧列 7 件」这种列级度量。
 *   6. **保留条件补一条「自身有可见内容」**。规格里「0~1 成员的命名区也保留」
 *      原本靠注释名兜底；产品 DOM 下名字恒为空（见下面 ★），若不放宽，
 *      图例带（整组都够不上节点门槛 → 0 成员）与「只有连线的语义带」会整块消失。
 *   7. **区名最终来自 `opts.svgText`（作者原文），且绝不猜**。图层化打断了注释与
 *      元素的兄弟关系，但 `svgText` 是未经改动的原文，交错关系完好。命名三级降级：
 *      ① 活 DOM 紧邻前导兄弟串（现场注释在原位时直接命中）；
 *      ② **id 命中**：源图元素的 id 是跨 DOM 重建的稳定身份，且 svgcanvas 只给
 *         没 id 的元素补 `svg_N`（作者写的 id 一律保留），所以 `region.dom` 的 id
 *         能对上；
 *      ③ **同类序数兜底**：源图里**没有 id** 的顶层元素 ↔ 仍无名的顶层区，
 *         按**标签同类**分组、两组各自按文档序配对，**只在数量完全相等时**才用。
 *      三种途径都只取「紧前兄弟（跳过纯空白文本）就是注释」的名字 —— 绝不把上一条
 *      注释顺延给后面的元素（那会把 `rect#svg_5` 外框错叫成 Background）。
 *      拿不到 / 解析失败（parsererror）/ 数量不等 → 一律保持空名：
 *      错名会污染 regionMetrics.hierarchy，比空名更糟。
 *
 * ★ 已知环境事实（会在 diag.notes 里报出来，不是本模块的 bug）：
 *   svgedit 的 Drawing.identifyLayers() 会把「根级元素」整体搬进新建的
 *   `g.layer`（该组追加在最后），而**根级注释留在原地**，于是源图里
 *   「注释紧邻其 section」的兄弟关系在运行时 DOM 里被抬断了一层。
 *   onto 样本实测：16 条注释仍在，但 13 条被抬到了 wrapper 之外，
 *   9 个区元素的 previousSibling 串里一条注释都没有 → 仅靠活 DOM 的 name 全为 ''。
 *   因此调用方要把**作者原文**经 `opts.svgText` 传进来（见设计点 7）：
 *   原文的交错关系是完好的，命名由它补齐。仍拿不到就保持空名 ——
 *   诚实降级，绝不给错名（错名会污染 hierarchy 度量与报告）。
 * ===========================================================================*/
'use strict';

const RegionGraph = {
  /* 判定阈值（全部可被 opts 覆盖） */
  DEF: {
    minMembers: 2,        /* 成为区的最少成员数；有名字的区放宽到 0（Legend/Footer 这类语义带） */
    containRatio: 0.95,   /* 包含判定：coverRatio ≥ 该值即视为「含住」（同 Analyzer.collision 口径） */
    frameRatio: 0.85,     /* 满版底板：自身面积 / 画布面积 ≥ 该值 */
    bandAspect: 6,        /* 长条带：宽高比 ≥ 该值 */
    bandMaxH: 0.12,       /* 长条带：高度 ≤ 画布高的该比例 */
    decorRatio: 0.0005,   /* 装饰性小区：面积 / 画布面积 < 该值且叶子全无标签 */
    aspectLo: 0.4,        /* 面板/卡片：宽高比带宽 */
    aspectHi: 4,
    maxSiblingScan: 64    /* 前导兄弟串最多回看多少个节点（防御恶意深链） */
  },

  /* 与 03_ir.js 的 SKIP_INSIDE 同口径：这些标签内部的元素不算内容 */
  SKIP: ['defs', 'marker', 'clippath', 'mask', 'pattern', 'symbol', 'filter',
         'lineargradient', 'radialgradient', 'title', 'desc', 'metadata', 'style', 'script'],

  /* 源图命名的单条缓存：{ text, data }（同一份作者原文不必每次重建都重解析） */
  _srcCache: { text: null, data: null },

  /* 软依赖：03_ir.js 已加载时复用它的 skip 表，避免两处口径漂移 */
  skipList() {
    return (typeof IR !== 'undefined' && IR && IR.SKIP_INSIDE && IR.SKIP_INSIDE.length)
      ? IR.SKIP_INSIDE : this.SKIP;
  },

  /* ============================ 主入口 ============================ */
  /* build(rt, content, nodes, canvas, opts) → { regions, byNode, tree, notes, diag } | null */
  build(rt, content, nodes, canvas, opts) {
    try {
      return this._build(rt, content, nodes, canvas, opts || {});
    } catch (e) {
      /* 软失败：调用方一律按「区域不可用」处理，绝不因为一个可选层炸掉主流程 */
      return null;
    }
  },

  _build(rt, content, nodes, canvas, opts) {
    /* 入参体检：拿不到真 DOM 就没有区域可言（调用方按 not applicable 处理） */
    if (!rt || !content || !content.querySelectorAll || !nodes || !nodes.length) return null;
    if (content.nodeType !== 1) return null;
    const o = Object.assign({}, this.DEF, opts);
    const skip = this.skipList();

    const cv = {
      w: (canvas && canvas.w) || parseFloat(rt.canvas && rt.canvas.contentW) || 0,
      h: (canvas && canvas.h) || parseFloat(rt.canvas && rt.canvas.contentH) || 0
    };

    /* ---------- 1. 剥掉包装层 ----------
     * svgcanvas 把全部内容塞进一个包装 <g>；#svgcontent 自身还挂着
     * title/desc/defs。只要「过滤后只剩一个元素子节点且它是 <g>」就继续下钻。 */
    let rootEl = content;
    for (let guard = 0; guard < 32; guard++) {
      const kids = this.kids(rootEl, skip);
      if (kids.length === 1 && tagOf(kids[0]) === 'g') { rootEl = kids[0]; continue; }
      break;
    }

    /* ---------- 元素 → IR 节点 反查 ----------
     * 组的 IR 节点 elem 是那个 <g>、shapeElem 是组里的形状；两者都登记，
     * 这样无论先遇到谁都能命中同一个节点（成员不会因遍历路径不同而丢失）。 */
    const nodeByEl = new Map();
    const shapeEls = new Set();
    for (const n of nodes) {
      if (!n) continue;
      if (n.elem && n.elem.nodeType === 1) nodeByEl.set(n.elem, n);
      if (n.shapeElem && n.shapeElem.nodeType === 1) { nodeByEl.set(n.shapeElem, n); shapeEls.add(n.shapeElem); }
    }
    const nById = new Map(nodes.filter(Boolean).map(n => [n.id, n]));

    /* ---------- 2. 递归建树（叶子级唯一归属） ----------
     * `<g>`：成员 ≥ minMembers 或**有注释名** → 成一个子区（Legend/Footer 这类
     *        0~1 成员的语义带也要留）；否则折叠 —— 成员上提给父级。
     * 非 <g>：命中 IR 节点才进成员表；文字/连线/装饰不进成员表（由包含关系计数）。
     * ★ 根级（depth 0）直属的 IR 节点各自成「一节」：源图的 section 注释正是
     *   逐个元素前导的，所以根级一个形状本身就是语义区（onto 样本的
     *   Background / 外框 两块就是两个区）；而**组内**的形状归属于组这一区，
     *   不再细分（否则 7 个卡片会被拆成 7 个区，得不出「左侧列 7 件」这种度量）。 */
    const consumed = new Set();   /* 已被吃掉的注释：一个名字只归一个区 */
    /* 折叠后上提的单成员小节：区元素取**被折叠的那个组**（源图的注释正是打在这个
     * 组上的），而不是组里那个形状 —— 否则区表里会出现「rect#svg_103」这种
     * 与源图 section 对不上的身份。命名同样先试活 DOM 的紧邻注释。 */
    const singleton = (n, domEl, depth) => ({
      el: (domEl && domEl.nodeType === 1) ? domEl : n.elem,
      depth, sub: [], own: [n],
      name: (domEl && domEl.nodeType === 1) ? this.commentName(domEl, consumed, o) : '',
      mem: [n]
    });
    const rollUp = nd => {
      nd.mem = nd.own.slice();
      for (const s of nd.sub) nd.mem.push.apply(nd.mem, s.mem);
      return nd;
    };
    const walk = (el, depth) => {
      const nd = { el, depth, sub: [], own: [], name: '', mem: [] };
      for (const c of this.kids(el, skip)) {
        if (tagOf(c) === 'g') {
          const k = rollUp(walk(c, depth + 1));
          k.name = this.commentName(c, consumed, o);
          /* 保留条件：成员 ≥ minMembers，或有注释名，或**自身就有可见内容**。
           * 第三条是产品 DOM 下的必要放宽：规格里「0~1 成员的命名区也保留」
           * 原本靠注释名兜底，但 svgedit 的图层重建会把根级注释抬到 wrapper 之外
           * （见文件头 ★），名字恒为空 —— 若不放宽，图例带（4 个 16×16 色块，
           * 整组都够不上节点门槛 → 0 成员）会整块消失，
           * 「只有连线/装饰的语义带」同理。空壳 <g> 仍然折叠。 */
          if (k.mem.length >= o.minMembers || k.name || (k.mem.length === 0 && this.hasOwnContent(c))) {
            nd.sub.push(k);
          } else if (depth === 0) {
            /* 根级折叠：成员各自成节，保持「根级节点 = 一节」的口径 */
            for (const m of k.mem) nd.sub.push(singleton(m, c, depth + 1));
          } else {
            nd.own.push.apply(nd.own, k.mem);   /* 组内折叠：成员上提 */
          }
        } else {
          const n = nodeByEl.get(c);
          if (!n) continue;
          if (depth === 0) nd.sub.push(singleton(n, c, depth + 1));
          else nd.own.push(n);
        }
      }
      return nd;
    };
    const rootNd = rollUp(walk(rootEl, 0));

    /* ---------- 3. 物化成公开的区对象 ---------- */
    const regions = [], byNode = Object.create(null);
    let seq = 0;
    const materialize = (nd, parent) => {
      const r = {
        id: 'r' + (++seq),
        dom: nd.el || null,
        depth: nd.depth,
        parent: parent ? parent.id : null,
        name: nd.name || '',
        kind: 'cluster',
        bbox: null,
        members: (nd.mem || []).map(n => n.id),
        texts: 0,
        decorations: 0,
        inkArea: 0,
        inkDensity: 0,
        whitespace: 1,
        children: [],
        leafCount: 0
      };
      for (const n of (nd.mem || [])) byNode[n.id] = r.id;
      if (parent) regions.push(r);          /* 树根单独由 tree 暴露，不进 regions */
      for (const s of nd.sub) r.children.push(materialize(s, r).id);
      return r;
    };
    const tree = materialize(rootNd, null);

    /* ---------- 3b. 兜底：漏掉的节点归给最深的包含区 ---------- */
    const orphans = nodes.filter(n => n && n.id && !byNode[n.id]);
    for (const n of orphans) {
      let host = null;
      for (const r of regions) {
        if (!r.dom || !r.dom.contains || !n.elem) continue;
        let inside = false;
        try { inside = r.dom.contains(n.elem); } catch (e) { inside = false; }
        if (!inside) continue;
        if (!host || r.depth > host.depth) host = r;
      }
      if (host) { host.members.push(n.id); byNode[n.id] = host.id; }
      else { tree.members.push(n.id); byNode[n.id] = tree.id; }   /* 兜底到树根 */
    }

    /* ---------- 4/5/6. 几何 + 类型 + 计数 ---------- */
    /* 一个节点都没接上 = 传进来的节点表和这棵 DOM 无关（不是「区域稀疏」），
     * 按软失败返回 null，省得下游拿一张空区表去算密度。 */
    if (!Object.keys(byNode).length) return null;
    for (const r of regions) this._measure(rt, r, nById, shapeEls, cv, o);
    this._measure(rt, tree, nById, shapeEls, cv, o);

    /* ---------- 7. 命名：活 DOM（第 2 步已试）→ 源图 id → 源图同类序数 ---------- */
    const srcMode = this.sourceMode(o.svgText);
    const fromSrc = this.applySourceNames(regions, tree, o.svgText);

    /* ---------- 诊断（断言不抛错，只回报） ---------- */
    const sum = regions.reduce((s, r) => s + r.members.length, 0);
    const ownedIds = Object.keys(byNode);
    const comments = this.countComments(content);
    const named = regions.filter(r => r.name).length;
    const notes = [];
    if (sum !== ownedIds.length)
      notes.push(`区成员总和 ${sum} ≠ 已归属节点数 ${ownedIds.length}（唯一归属不变量被破坏）`);
    if (ownedIds.length !== nodes.length)
      notes.push(`已归属节点 ${ownedIds.length} ≠ IR 节点 ${nodes.length}`);
    const over = regions.filter(r => r.inkDensity > 1);
    if (over.length)
      notes.push(`inkDensity > 1 的区：${over.map(r => r.id + '=' + r.inkDensity).join(', ')}（叶子去重失效）`);
    if (comments > 0 && named < regions.length) {
      if (srcMode === 'ok') {
        notes.push(`区名：活 DOM 紧邻注释命中 ${named - fromSrc.total} 个，`
          + `源图补齐 ${fromSrc.total} 个（id ${fromSrc.id} / 同类序数 ${fromSrc.ordinal}），`
          + `仍无名 ${regions.length - named} 个 —— 多义处一律留空，不猜`);
      } else if (srcMode === 'invalid') {
        notes.push(`opts.svgText 无法解析（parsererror）→ 退回活 DOM 命名：`
          + `DOM 内有 ${comments} 条注释但都已被图层重建抬走，故 name 为空`);
      } else {
        notes.push(`DOM 内有 ${comments} 条 XML 注释，但都已被 svgedit 的图层重建抬到 wrapper 之外`
          + `（区元素的紧邻前导兄弟串里没有注释）→ name 为空；`
          + `调用方传入作者原文（opts.svgText）即可补齐`);
      }
    }

    return {
      regions, byNode, tree, notes,
      diag: {
        regions: regions.length, named, comments,
        sourceNames: fromSrc.total, sourceNameMode: srcMode,
        ownedNodes: ownedIds.length, totalNodes: nodes.length,
        sumMembers: sum, rootTag: tagOf(rootEl), rootId: (rootEl && rootEl.id) || '',
        unwrapped: rootEl !== content, invariant: sum === ownedIds.length && ownedIds.length === nodes.length
      }
    };
  },

  /* --------------------------- 小工具 --------------------------- */
  kids(el, skip) {
    const out = [];
    if (!el || !el.children) return out;
    for (const c of el.children) if (skip.indexOf(tagOf(c)) < 0) out.push(c);
    return out;
  },

  /* 语义命名：沿 previousSibling 链找「紧邻前导兄弟串」里的 XML 注释。
   * · 空白文本节点、元素兄弟都跳过（一个注释可能前导一整节多个元素）；
   * · 停在父边界（不越出去找祖辈的兄弟）——「不吞比紧邻串更远的那条注释」；
   * · 已被别的区吃掉的注释不再复用（一个名字只归一个区）。 */
  commentName(el, consumed, o) {
    let s = el && el.previousSibling, steps = 0;
    while (s && steps++ < o.maxSiblingScan) {
      if (s.nodeType === 8) {
        if (consumed.has(s)) { s = s.previousSibling; continue; }
        consumed.add(s);
        return String(s.nodeValue == null ? '' : s.nodeValue).replace(/\s+/g, ' ').trim();
      }
      if (s.nodeType === 3 && String(s.nodeValue || '').trim() !== '') return '';  /* 非空白文本：串断 */
      s = s.previousSibling;
    }
    return '';
  },

  /* ================= 源图命名（opts.svgText 路径） =================
   * 现场 DOM 的注释已被图层重建抬走（见文件头 ★），但作者原文里的
   * 「注释紧邻其 section」是完好的。这里只做**严格相邻**的读取：
   * 元素的名字 = 它的前一个「非纯空白」兄弟节点，且该节点必须是注释。 */

  /* 源图元素名的唯一读法：向前跳过纯空白文本节点，第一个节点必须是注释。
   * 不越过元素兄弟、不越过非空白文本、不跨父边界 —— 绝不把上一条注释顺延下来。 */
  adjacentName(el) {
    let s = el && el.previousSibling, steps = 0;
    while (s && s.nodeType === 3 && String(s.nodeValue || '').trim() === ''
           && steps++ < this.DEF.maxSiblingScan) s = s.previousSibling;
    if (!s || s.nodeType !== 8) return '';
    return String(s.nodeValue == null ? '' : s.nodeValue).replace(/\s+/g, ' ').trim();
  },

  /* 解析作者原文，抽出两张表（单条缓存：同一份文本每次重建都重解析没必要）：
   *   idNames: 源图**带 id** 的元素 → 紧邻注释名（id 是跨 DOM 重建的稳定身份）
   *   byTag  : 源图**顶层、无 id** 的元素 → 按标签分组的紧邻注释名序列表
   *            （带着 id 的走 idNames，不参与序数配对，避免错位） */
  srcNames(svgText) {
    if (typeof svgText !== 'string' || !svgText.trim()) return null;
    if (this._srcCache && this._srcCache.text === svgText) return this._srcCache.data;
    const skip = this.skipList();
    let data = null;
    try {
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      const root = doc && doc.documentElement;
      if (root && tagOf(root) === 'svg' && !(doc.querySelector && doc.querySelector('parsererror'))) {
        const idNames = new Map(), byTag = new Map();
        const walk = el => {
          for (const c of el.children) {
            if (skip.indexOf(tagOf(c)) >= 0) continue;
            const id = c.getAttribute && c.getAttribute('id');
            const nm = this.adjacentName(c);
            if (id && nm) idNames.set(id, nm);
            walk(c);
          }
        };
        walk(root);
        for (const c of root.children) {
          if (skip.indexOf(tagOf(c)) >= 0) continue;
          if (c.getAttribute && c.getAttribute('id')) continue;
          const t = tagOf(c);
          if (!byTag.has(t)) byTag.set(t, []);
          byTag.get(t).push(this.adjacentName(c));
        }
        data = { idNames, byTag };
      }
    } catch (e) { data = null; }
    this._srcCache = { text: svgText, data };
    return data;
  },

  /* 源图命名的两种口径，供 diag 区分「没给原文」和「原文坏了」 */
  sourceMode(svgText) {
    if (typeof svgText !== 'string' || !svgText.trim()) return 'missing';
    return this.srcNames(svgText) ? 'ok' : 'invalid';
  },

  /* DOM 文档序比较（序数配对必须显式排序，不能靠 regions 的生成顺序） */
  docOrder(a, b) {
    if (a === b) return 0;
    try {
      const p = a.compareDocumentPosition(b);
      if (p & 4) return -1;    /* b 在 a 之后 */
      if (p & 2) return 1;
    } catch (e) { /* 忽略：退回稳定序 */ }
    return 0;
  },

  /* 给仍无名的区补名（活 DOM 已在建树时试过一轮）：
   *   ① id 命中：源图带 id 的元素名 → 同 id 的区元素；id 唯一，跨层级也安全。
   *   ② 同类序数：顶层、仍无名的区按标签分组，与源图**顶层、无 id** 的同标签元素
   *      按文档序配对；**只在两组数量完全相等时**才用（数量不等一律留空，绝不猜）。
   * 名字可能为空串（源图那个元素前面没有紧邻注释）—— 保持该区空名。 */
  applySourceNames(regions, tree, svgText) {
    const out = { id: 0, ordinal: 0, total: 0 };
    const src = this.srcNames(svgText);
    if (!src) return out;
    for (const r of regions) {
      if (r.name || !r.dom || !r.dom.getAttribute) continue;
      const id = r.dom.getAttribute('data-id') || r.dom.id || '';
      if (id && src.idNames.has(id)) { r.name = src.idNames.get(id); out.id++; }
    }
    const rootId = tree && tree.id;
    const buckets = new Map();
    for (const r of regions) {
      if (r.name || r.parent !== rootId) continue;    /* 只配顶层区 */
      const t = tagOf(r.dom);
      if (!t) continue;
      if (!buckets.has(t)) buckets.set(t, []);
      buckets.get(t).push(r);
    }
    for (const [t, list] of buckets) {
      const srcList = src.byTag.get(t);
      if (!srcList || srcList.length !== list.length) continue;   /* 数量不等 → 放弃该标签 */
      list.sort((a, b) => this.docOrder(a.dom, b.dom));
      for (let i = 0; i < list.length; i++) {
        if (srcList[i] && !list[i].name) { list[i].name = srcList[i]; out.ordinal++; }
      }
    }
    out.total = out.id + out.ordinal;
    return out;
  },

  /* 组自身是否有可见内容（形状 / 连线 / 文字）。
   * 用途：0 成员但内容全在节点门槛之下的语义带（图例色块、纯连线带）不该被折叠掉。 */
  hasOwnContent(el) {
    if (!el || !el.querySelectorAll) return false;
    try { return el.querySelectorAll('rect,circle,ellipse,polygon,path,line,polyline,text').length > 0; }
    catch (e) { return false; }
  },

  /* 统计子树里的 XML 注释条数（只看元素内容，不进入 skip 表内部） */
  countComments(el) {
    let n = 0;
    if (!el || !el.querySelectorAll) return 0;
    try {
      const it = document.createTreeWalker(el, 128 /* SHOW_COMMENT */);
      while (it.nextNode()) n++;
    } catch (e) { return n; }
    return n;
  },

  /* 区的文本量：子树内 <text> 元素数（节点标签文字也是 <text>，一并计入）。 */
  countTexts(el) {
    if (!el || !el.querySelectorAll) return 0;
    try { return el.querySelectorAll('text').length; } catch (e) { return 0; }
  },

  /* 区内的「装饰件」：够不上节点门槛、也不是连线的形状（如图例色块、小圆点）。 */
  countDecorations(el, shapeEls) {
    if (!el || !el.querySelectorAll) return 0;
    let n = 0;
    try {
      for (const s of el.querySelectorAll('rect,circle,ellipse,polygon')) if (!shapeEls.has(s)) n++;
    } catch (e) { /* 忽略 */ }
    return n;
  },

  /* 元素自身的世界包围盒（0 成员命名区的几何兜底） */
  elBox(rt, el) {
    if (!rt || !el || !rt.worldBBox) return null;
    let b = null;
    try { b = rt.worldBBox(el, { stroke: true }); } catch (e) { return null; }
    if (!b || !isFinite(b.x) || !isFinite(b.w) || !(b.w > 0 || b.h > 0)) return null;
    return R.mk(b.x, b.y, b.w, b.h);
  },

  /* -------------------- 几何 + 墨密度 + 类型 -------------------- */
  _measure(rt, r, nById, shapeEls, cv, o) {
    const mem = (r.members || []).map(id => nById.get(id)).filter(Boolean);
    r.bbox = R.union(mem.map(m => m.bbox)) || this.elBox(rt, r.dom);

    /* 叶子 = 不含住其它成员的成员（coverRatio ≥ 0.95 视为包含，同 Analyzer.collision）。
     * ★ 没有这一步，嵌套容器（外框 + 内框）会把同一块面积重复计入，
     *   inkDensity 会 >1（实测 2.66）。 */
    const contains = (a, b) => a !== b
      && R.area(a.bbox) > R.area(b.bbox)
      && R.coverRatio(a.bbox, b.bbox) >= o.containRatio;
    const leaves = mem.filter(m => !mem.some(k => contains(m, k)));
    r.leafCount = leaves.length;

    r.inkArea = r2(leaves.reduce((s, m) => s + R.area(m.bbox), 0));
    const area = r.bbox ? R.area(r.bbox) : 0;
    r.inkDensity = r2(r.inkArea / Math.max(1, area));
    r.whitespace = r2(1 - Math.min(1, r.inkDensity));
    r.texts = this.countTexts(r.dom);
    r.decorations = this.countDecorations(r.dom, shapeEls);
    r.kind = this._kind(r, leaves, cv, o);
  },

  /* 类型判定：按顺序首个命中者胜（纯几何、确定性） */
  _kind(r, leaves, cv, o) {
    const box = r.bbox || R.mk(0, 0, 0, 0);
    const cvA = cv.w * cv.h, cvH = cv.h;
    const a = R.area(box);

    /* ① 满版底板：面积比口径（同 03_ir.js 的 isBg）。
     *    刻意不用 coverRatio：它按 min(面积) 归一，画布内任何元素都 ≈1.0。 */
    if (cvA > 0 && a / cvA >= o.frameRatio) return 'frame';
    /* ② 长条带：很宽很薄（除零保护：h ≤ 0 直接不成立） */
    if (box.h > 0 && box.w > 0
        && box.w / box.h >= o.bandAspect && box.h <= o.bandMaxH * cvH) return 'band';
    /* ③ 装饰性小区：叶子全无标签且面积占比极小（0 成员时 every 恒真，同样成立） */
    const labelless = leaves.every(m => !(m.labels && m.labels.length));
    if (cvA > 0 && labelless && a < o.decorRatio * cvA) return 'decoration';
    /* ④ 面板 / ⑤ 卡片：同一宽高比带宽，成员要求不同 */
    const asp = box.h > 0 ? box.w / box.h : 0;
    if (asp >= o.aspectLo && asp <= o.aspectHi) {
      if (leaves.length >= 2 || (leaves.length >= 1 && (r.texts || 0) >= 2)) return 'panel';
      return 'card';
    }
    return 'cluster';
  }
};
