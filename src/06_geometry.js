/* =============================================================================
 * SVG Beautifier · 06 确定性几何 / 布局引擎
 *
 * 设计文档 §5：Laya 决策「做什么」，几何引擎计算「做多少」。
 * 本层是全确定性的：输入 IR + 决策，输出精确数值与 ops。无随机、无模型。
 *
 * 两个入口：
 *   evaluate(ir, an, issues, strategyKey)  → 可行性预检（规则用它做硬门筛选）
 *   plan(ir, an, decision)                 → ops 列表（含 preview，供 Proposed 视图）
 *
 * 收口约束（防止「越改越丑」，设计文档 §25 堵点六）：
 *   **每轮每个元素最多被一个 op 触碰**，其余 op 记 skipped 交由下一轮；
 *   再叠加 Validator 的分数守卫与回滚，构成完整自修复闭环。
 * ===========================================================================*/
'use strict';

const Geo = {
  LABEL: {
    resize_container: '放大容器', reflow_body: '正文左归位', move_text: '修正文字锚点', wrap_text: '文本换行', reduce_font: '缩小字号',
    move_apart: '推开重叠', grow_spacing: '整体扩间距', global_relayout: '整体重排',
    snap_edges: '吸附边线', snap_centers: '吸附中心',
    distribute_equal: '等间距分布', distribute_weighted: '加权分布',
    orthogonal_reroute: '正交避障重路由', keep_and_shift: '移动被穿越节点',
    normalize_style: '样式归一', keep_style: '保持样式',
    rebalance_canvas: '画布留白平衡', keep_canvas: '保持画布',
    grow_to_min: '放大到最小可读', ignore: '忽略',
    raise_text: '提升图层', nudge_text: '移出遮挡'
  },

  /* 风格决策真实驱动几何目标（不是摆设） */
  STYLE: {
    minimal: { pad: 14, gap: 28, tier: [13, 11], lineGap: 3 },
    technical: { pad: 16, gap: 32, tier: [14, 12], lineGap: 4 },
    enterprise: { pad: 20, gap: 40, tier: [15, 13], lineGap: 5 },
    presentation: { pad: 24, gap: 48, tier: [17, 14], lineGap: 6 },
    dense: { pad: 10, gap: 22, tier: [13, 11], lineGap: 3 }
  },
  styleOf(k) { return this.STYLE[k] || this.STYLE.technical; },

  /* 字号档位 = 「本文档自己的两个主流字号」，而不是预设的绝对像素。
   * ★ 为什么必须文档内求：STYLE 预设的 tier（如 enterprise=[15,13]）是给小画布调的，
   *   直接套到 1920×1080 的图上会把 54/30/24/22/19px 一律压成 15/13 —— 成品相当于
   *   「用便签字号排海报」。real-05 实测原始字号 54/30/28/25/21/18/17 全部落到 12/14px。
   * 取「出现次数 ≥2 的降序前二档」；不足两档时退化为「出现最多的两个不同字号」，
   * 连两个都没有时回落到预设 st.tier。 */
  fontTiers(ir, st) {
    const cnt = new Map();
    const add = v => { const k = r2(v); if (!(k > 0)) return; cnt.set(k, (cnt.get(k) || 0) + 1); };
    for (const n of ir.nodes) for (const l of n.labels) add(l.fontSize);
    for (const t of ir.texts) add(t.fontSize);
    const arr = [...cnt.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
    const strong = arr.filter(x => x[1] >= 2).slice(0, 2).map(x => x[0]);
    const pool = strong.length === 2 ? strong : arr.slice(0, 2).map(x => x[0]);
    if (pool.length < 2) return (st && st.tier ? st.tier.slice() : [14, 12]);
    return pool.slice().sort((a, b) => b - a);      /* 大档在前 */
  },

  /* 取目标档位：**必须落在 [0.70×, 1.45×] 容差带内**，否则返回 null（放弃该条）。
   * 这条带是「不许越改越丑」的量化表达：单次字号改动超过 ±45% 肉眼就是「换了一套版式」，
   * 修一致性不值得付这个代价。 */
  nearestTier(size, tiers, idx, st) {
    if (!(size > 0)) return null;
    const cands = (tiers && tiers.length ? tiers : st.tier).slice().sort((a, b) => b - a);
    const inBand = t => { const r = t / size; return r >= 0.70 && r <= 1.45; };
    const cand = cands.filter(inBand).sort((a, b) => Math.abs(a - size) - Math.abs(b - size))[0];
    if (cand === undefined) return null;
    /* 首个（最靠上的）标签按「标题档」取向：大档也在带内时优先大档 */
    if (idx === 0 && cands.length >= 2 && inBand(cands[0]) &&
        Math.abs(cands[0] - size) <= Math.abs(cand - size) * 1.8) return r2(cands[0]);
    return r2(cand);
  },

  /* 修复阶段顺序（由 Laya 的 fix_order 决策选择） */
  PHASES: {
    text_first: ['text_overflow', 'style_inconsistency', 'overlap', 'occlusion', 'spacing', 'misalignment', 'tiny_element', 'canvas_margin', 'edge_crossing'],
    geometry_first: ['overlap', 'occlusion', 'spacing', 'misalignment', 'tiny_element', 'text_overflow', 'style_inconsistency', 'canvas_margin', 'edge_crossing'],
    edge_first: ['edge_crossing', 'overlap', 'occlusion', 'text_overflow', 'spacing', 'misalignment', 'style_inconsistency', 'tiny_element', 'canvas_margin'],
    global_relayout: ['canvas_margin', 'overlap', 'occlusion', 'spacing', 'misalignment', 'text_overflow', 'edge_crossing', 'style_inconsistency', 'tiny_element']
  },

  /* ==================== 提交原子性分级（F1） ====================
   * 决定「一类的修复动作能否按 item 拆分提交」。07_patch.js 在整批被 op 级门淘汰后
   * 读这张表：'whole' 维持整批提交（保持既有语义），其余按 item 增量提交。
   *
   * 'whole' —— 整类必须一次提交。判据是**组内一致性**：拆开会破坏不变量。
   *            这些条目的理由在 07_patch.js 与 plan() 的 claim() 注释里都有实测记录
   *            （整幅平移拆一半 → 留白更不对称；等距分布拆一半 → canvas 归零）。
   * 'item'  —— 每个 item（= 一组 targets，见 claim() 的 ik()）独立提交，互不影响。
   * 'cluster'—— 逐对齐簇独立，处理方式与 'item' 相同（保留独立取值是为了台账可读）。
   *
   * ★ 未声明的类型一律按 'item'：漏声明时最坏只是多花几次校验；
   *   若默认 'whole' 则会重演「9 个 item 对、1 个 item 错 → 整类丢弃」的退化。
   *   失败方向必须选安全的那一侧。 */
  ATOMIC: {
    canvas_margin: 'whole',        /* 整幅平移 + 扩画布，拆开必然破坏对称留白 */
    spacing: 'whole',              /* 等距分布必须整行/整列一起挪（实测拆了 canvas 归零） */
    edge_crossing: 'whole',        /* 整组重路由，拆开会让新路径互相打架 */
    misalignment: 'cluster',       /* 逐对齐簇独立 */
    text_overflow: 'item',         /* 逐容器独立 */
    style_inconsistency: 'item',   /* 逐节点字号/填充独立 */
    tiny_element: 'item',          /* 逐元素独立 */
    overlap: 'item',               /* 逐对独立 */
    occlusion: 'item'              /* 逐文字独立 */
  },
  atomicity(type) { return this.ATOMIC[type] || 'item'; },

  /* ==================== 节点可动空间（供多策略共用） ==================== */
  freeSpace(ir, node, minGap) {
    const mg = minGap === undefined ? 10 : minGap;
    const g = node.geomBox;
    /* 注意：不要用 R 作局部变量名——会遮蔽全局矩形工具 R */
    let freeL = g.x, freeR = ir.canvas.w - R.right(g);
    let freeT = g.y, freeB = ir.canvas.h - R.bottom(g);
    for (const o of ir.nodes) {
      if (o === node) continue;
      /* ★ 跳过与本体**互相包含**的元素（父容器与子装饰件），它们是可用空间而不是障碍。
       * 两种情况都必须豁免：
       *   ① 父容器把卡片整个装进去 —— 漏掉则「已横向重叠 → 左右自由空间判 0」，
       *      evResize 永远「可用 0px」，用户要的「背景图形适配文字」直接不可达；
       *   ② 子元素（角标圆、图标）落在卡片内部 —— 漏掉则同一分支同样把自由空间清零，
       *      实测 real-01 的三张知识卡各自带一个 56px 的圆形角标，
       *      `freeSpace` 全部返回 {0,0,0,0} → 三条 text_overflow 一条 op 都产不出来。
       * 口径与 Analyzer.collision 的「完全包含 = 合法嵌套」一致：coverRatio ≥ 0.95 视作嵌套。 */
      const og = o.geomBox;
      if (og && R.coverRatio(g, og) >= 0.95) continue;
      const ob = o.bbox;
      const vOverlap = Math.min(R.bottom(g), R.bottom(ob)) - Math.max(g.y, ob.y);
      if (vOverlap > 1) {
        if (R.right(ob) <= g.x) freeL = Math.min(freeL, g.x - R.right(ob) - mg);
        else if (ob.x >= R.right(g)) freeR = Math.min(freeR, ob.x - R.right(g) - mg);
        /* ★ 已经横向重叠：任何横向生长都只会加深这次碰撞 → 该轴自由空间判 0。
         * 漏掉这一支会让「贴住邻居」被当成「有空间」，实测 collision 98→90。 */
        else { freeL = 0; freeR = 0; }
      }
      const hOverlap = Math.min(R.right(g), R.right(ob)) - Math.max(g.x, ob.x);
      if (hOverlap > 1) {
        if (R.bottom(ob) <= g.y) freeT = Math.min(freeT, g.y - R.bottom(ob) - mg);
        else if (ob.y >= R.bottom(g)) freeB = Math.min(freeB, ob.y - R.bottom(g) - mg);
        else { freeT = 0; freeB = 0; }
      }
    }
    return { l: Math.max(0, freeL), r: Math.max(0, freeR), t: Math.max(0, freeT), b: Math.max(0, freeB) };
  },

  /* 是否与任何「不应碰撞」的节点相交。
   * ★ 判定口径必须与 Analyzer.collision 逐字对齐，否则几何引擎会「自认为干净」，
   *   而打分器照样扣分 —— 表现为 op 应用后 collision 反而劣化（实测 96→90）。
   *   Analyzer 的口径是：`inter.w < 2 && inter.h < 2` 才算发丝级接触不计；
   *   且 coverRatio ≥ 0.95 视为合法嵌套容器。 */
  wouldCollide(ir, self, rect, ignore) {
    for (const o of ir.nodes) {
      if (o === self || (ignore || []).indexOf(o) >= 0) continue;
      const inter = R.intersect(rect, o.bbox);
      if (!inter) continue;
      if (inter.w < 2 && inter.h < 2) continue;
      if (R.coverRatio(rect, o.bbox) >= 0.95) continue;
      return o;
    }
    return null;
  },

  /* ==================== 可行性预检 ==================== */
  evaluate(ir, an, issues, key, sopt) {
    const st = this.styleOf(sopt && sopt.style);
    const type = issues[0].type;
    switch (type + ':' + key) {
      case 'text_overflow:resize_container': return this.evResize(ir, an, issues, st);
      case 'text_overflow:reflow_body': return this.evReflowBody(ir, issues, st);
      case 'text_overflow:move_text': return this.evMoveText(ir, issues);
      case 'text_overflow:wrap_text': return this.evWrap(ir, issues, st);
      case 'text_overflow:reduce_font': return this.evReduceFont(ir, issues, st);
      case 'overlap:move_apart': return this.evMoveApart(ir, an, issues);
      case 'overlap:grow_spacing': return this.evGrowSpacing(ir, an, issues, st);
      /* ★ F4a：global_relayout 曾是**幽灵策略** —— 在 LABEL/PHASES/evaluate/候选表里都有，
       * 但 plan() 的 switch 没有对应 case → 落 default → 0 op → 顺位回退到共用 separation()
       * 的 move_apart / grow_spacing，于是三条候选给出**完全相同的数字**，让 Laya 的 ranks
       * 与台账都在说谎。候选表里有幻觉比候选少更糟，故先把桩降为「不可用」；
       * 真正实现区域重排时再连同 6 处注册点一起恢复。 */
      case 'overlap:global_relayout': return { score: 0, detail: '未实现（已下线，不再参与排序）', risky: true };
      case 'occlusion:nudge_text': return this.evNudgeText(ir, issues, st);
      case 'occlusion:raise_text': return this.evRaiseText(issues);
      case 'misalignment:snap_edges': return this.evSnap(ir, an, 'edges');
      case 'misalignment:snap_centers': return this.evSnap(ir, an, 'centers');
      case 'spacing:distribute_equal': return this.evDistribute(ir, issues, 'equal', st);
      case 'spacing:distribute_weighted': return this.evDistribute(ir, issues, 'weighted', st);
      case 'edge_crossing:orthogonal_reroute': return this.evReroute(ir, an, issues);
      case 'edge_crossing:keep_and_shift': return this.evKeepShift(ir, issues);
      case 'style_inconsistency:normalize_style': {
        const tiers = this.fontTiers(ir, st);
        let nFix = 0;
        for (const node of ir.nodes) {
          const ls = node.labels.slice().sort((a, b) => a.bbox.y - b.bbox.y);
          ls.forEach((l, i) => {
            const w = this.nearestTier(l.fontSize, tiers, i, st);
            if (w !== null && Math.abs(l.fontSize - w) >= 0.4) nFix++;
          });
        }
        const nFill = (an.raw.style.fills || []).length;
        return { score: (nFix || nFill > 1) ? 100 : 40, detail: `字号对齐到文档档位 ${tiers.join('/')}px（${nFix} 条）；填充按色族归一（${nFill} 色）`, risky: false };
      }
      case 'style_inconsistency:keep_style': return { score: 20, detail: '保持现状', risky: false };
      case 'canvas_margin:rebalance_canvas': return this.evRebalance(ir, an);
      case 'canvas_margin:keep_canvas': return { score: 20, detail: '保持现状', risky: false };
      case 'tiny_element:grow_to_min': return this.evGrowMin(ir, an, issues);
      case 'tiny_element:ignore': return { score: 40, detail: '不处理（交由人工）', risky: false };
      default: return { score: 50, detail: '未定义策略', risky: false };
    }
  },

  /* 容器放大的**可行性预检**。
   * ★ 口径必须与 `opResize` 完全一致，否则决策层会选一个产不出效果/产错效果的策略：
   *   旧实现按「总尺寸」算——`growX = (并集宽 + 2·pad) − 容器宽`，
   *   忽略了「左边富余、右边缺口」这种逐边情形，于是 real-01 报出
   *   「需增 208.19px / 可用 1875px」→ 100 分，被选为唯一策略；
   *   而 opResize 逐边算出来的真实可长量只有 16.5px（右边邻居只留了这么点空隙），
   *   结果 5 个 op 全部 applied、净分却只有 +0.4，残余越界 10.47px 无人接手。
   * 现在改成：逐边缺口 → 与自由空间逐边取 min → 只有「缺口全部补平」才算完全可解；
   *   部分可解给 0.5 权重并把残余量计入惩罚，从而在空间不足时**主动让位**给
   *   reduce_font / wrap_text（修复阶梯的下一级），而不是霸占整轮。 */
  evResize(ir, an, issues, st0) {
    const st = st0 || this.styleOf(null);
    let nTot = 0, nEff = 0, totalNeed = 0, totalAvail = 0, sumShort = 0;
    for (const it of issues) {
      const n = it.evidence.nodeRef;
      if (!n) continue;
      nTot++;
      const g = n.geomBox;
      const lu = (n.labels && n.labels.length) ? R.union(n.labels.map(l => l.bbox)) : null;
      if (!lu) { nEff++; continue; }
      const dl = Math.max(0, g.x + st.pad - lu.x);
      const dr = Math.max(0, R.right(lu) + st.pad - R.right(g));
      const dt = Math.max(0, g.y + st.pad - lu.y);
      const db = Math.max(0, R.bottom(lu) + st.pad - R.bottom(g));
      const wantX = dl + dr, wantY = dt + db;
      const fs = this.freeSpace(ir, n, 8);
      const canX = Math.min(dl, fs.l) + Math.min(dr, fs.r);
      const canY = Math.min(dt, fs.t) + Math.min(db, fs.b);
      totalNeed += wantX + wantY;
      totalAvail += canX + canY;
      if (wantX + wantY < 0.6) { nEff++; continue; }              /* 本来就不缺，无需增长 */
      const short = Math.max(0, wantX - canX) / Math.max(1, wantX || 1) +
                    Math.max(0, wantY - canY) / Math.max(1, wantY || 1);
      sumShort += Math.min(1, short);
      if (short <= 0.02) nEff++;                                    /* 缺口可全部补平 */
      else if (canX + canY > 0.6) nEff += 0.5;                      /* 只能补一半 → 降权 */
    }
    const feasible = nTot ? nEff / nTot : 0;
    const resid = nTot ? sumShort / nTot : 0;
    const score = r2(clamp(100 * feasible * (1 - 0.5 * resid), 0, 100));
    return {
      score, risky: score < 70,
      detail: `需增 ${r2(totalNeed)}px / 逐边可用 ${r2(totalAvail)}px（可补平 ${r2(feasible * 100)}%` +
        (resid > 0.02 ? `，残余 ${r2(resid * 100)}% 交降字号/换行` : '') + '）',
      preview: null
    };
  },

  evMoveText(ir, issues) {
    /* ★ 预检口径必须与 opFixAnchor 的产出口径**逐字一致**：
     * 旧实现只要 `anchor !== 'middle'` 就记一条「可修复」，于是把它自己的 op
     * 构造器随后会拒绝的节点也算进来 → 得分 92 压过 resize_container(100 仅在空间
     * 充足时才有)，决策层误选 move_text，产出一堆垃圾 op（实测 real-05 首个批次
     * 17 条 move_text 把文字重锚到容器外，正是「文字超出背景/被遮挡」的来源）。 */
    let fixable = 0, worstOff = 0;
    for (const it of issues) {
      const n = it.evidence.nodeRef;
      if (!n) continue;
      for (const l of n.labels) {
        const d = this.anchorDelta(ir, n, l);
        if (!d) continue;
        fixable++;
        worstOff = Math.max(worstOff, Math.abs(d.dwx));
      }
    }
    /* ★ 计分必须随**覆盖率**变化，不能给固定分：
     *   real-01 的 text_overflow 有 5 项，move_text 只能安全处理其中 1 个标签，
     *   旧实现照样给死分 92 → 压过「可补平 90% 缺口」的 resize_container(85.4)，
     *   决策层于是选了 move_text：整批只产 1 个 op，4 项越界原地不动，
     *   还把标题平移了 278px（用户反馈 #2「文字被遮挡 / 位置乱」的来源之一）。
     * 改成 25 + 67·覆盖率：只修 1/5 得 ≈38，全修得 92，与 resize 的高覆盖形成正确序。 */
    const nTot = issues.length || 1;
    const cov = Math.min(1, fixable / nTot);
    return {
      score: fixable ? r2(25 + 67 * cov) : 25, risky: false,
      detail: fixable ? `${fixable}/${nTot} 个标签可安全居中（最大偏移 ${r2(worstOff)}px）` : '标签无可安全重锚的偏离（改走容器放大）'
    };
  },

  /* ============ 正文块「左归位 + 让开图标」（reflow_body） ============
   * 用户反馈（截图标注）：「卡片里正文过于偏右」。实测 real-01 的三张图标卡片：
   *   容器 `rect#svg_30` = 555..805（宽 250），图标 `circle#svg_31` 左偏移只有 **22px**，
   *   而正文三行却在 `x=648` → 距容器左 **93px**（为了对齐到图标右侧的标题下方），
   *   左下方因此留出一整块空槽、右缘反而比容器宽出 18px —— 观感就是「文字被推到右边」。
   *
   * ★ 为什么 analyzer 不报这个缺陷：它按**标签并集**算 pad，而图标里的那个字
   *   （`语` @ x=589）也在容器的 labels 里，把并集左缘拉到 589 → `pad.l` 只剩 36，
   *   惩罚全落在右侧的 `dR` 上。所以「左缩进过大」在现有评分里是**隐形的**，
   *   交给 resize_container 只会把容器往右撑大，正文依旧待在 93px 的缩进上。
   *
   * ★ 修法只动文字、不动容器：把正文块（≥2 行且左缘同列的密排文本）
   *   ① 下移到「左侧障碍（图标）下缘 + gap」之下，
   *   ② 左移对齐到**容器基线内边距**（= 容器内图标自身的左偏移）。
   *   不碰容器 ⇒ 不引入新的碰撞/对齐风险（resize_container 的主要风险恰恰在这里）。
   *   代价是正文与标题不再左对齐 —— 这是用户明确要求的方向（标题仍留在图标右侧）。
   *
   * 保守边界：容器内**必须**先找到一个「贴左的非文本形状（图标）」用来推断基线内边距；
   * 找不到就返回 null，把问题交回 resize_container，不做无依据的猜测。 */
  bodyReflow(ir, n, st) {
    const L = (n.labels || []).filter(l => l.bbox);
    if (L.length < 3) return null;
    const g = n.geomBox;
    if (g.w <= 0 || g.h <= 0) return null;
    /* 容器内的非文本形状（图标等）：中心落在容器内、基本不带文字 */
    const shapes = ir.nodes.filter(o => o !== n && o.shapeElem && o.geomBox &&
      (o.labels || []).length <= 1 &&
      R.has(R.expand(g, 2), { x: R.cx(o.geomBox), y: R.cy(o.geomBox) }));
    if (!shapes.length) return null;
    const basePad = Math.min(...shapes.map(o => o.geomBox.x - g.x));
    if (!(basePad >= 0 && basePad < 48)) return null;
    /* 图标里的字（与形状相交的标签）排除出正文候选 */
    const inShape = l => shapes.some(o => { const it = R.intersect(o.geomBox, l.bbox); return it && it.w > 1 && it.h > 1; });
    const rest = L.filter(l => !inShape(l));
    if (rest.length < 2) return null;
    /* 正文 = 左缘同列（±1px）**且字号一致**的成员最多的那一组。
     * ★ 只用「左缘 ±1px」分组不可靠：实测同一条 real-01，fresh `Runtime.load` 与
     *   `UI.select` 两条路径的文本测量会差 ±1px —— 标题落在 650、正文落在 649，
     *   于是「差 1px 算不算同列」随机翻转：一次把标题并进正文（块高 82→129px，
     *   下移后顶出容器底边、校验不过 → 策略空转、排名掉回 resize），
     *   另一次却正常。这种抖动必须靠**语义判据**消掉：标题 30px、正文 19px。
     * 同时这也保住了正确语义 —— 正文就是一串**同字号**的密排行。 */
    const fsOf = l => l.fontSize || 0;
    const groups = [];
    for (const l of rest) {
      let hit = null;
      for (const gr of groups) {
        if (Math.abs(gr.x - l.bbox.x) > 1) continue;
        if (Math.abs(fsOf(gr.arr[0]) - fsOf(l)) > Math.max(2, 0.2 * Math.max(fsOf(gr.arr[0]), fsOf(l)))) continue;
        hit = gr; break;
      }
      if (!hit) { hit = { x: l.bbox.x, arr: [] }; groups.push(hit); }
      hit.arr.push(l);
    }
    let body = null;
    for (const gr of groups) if (!body || gr.arr.length > body.length) body = gr.arr;
    if (!body || body.length < 2) return null;
    const bb = R.union(body.map(l => l.bbox));
    const indent = bb.x - g.x;
    if (indent < basePad + 12) return null;                 /* 缩进不明显 → 不值得动 */
    /* 左侧障碍：整块位于正文左侧（右缘不越过正文左缘），且**纵向**与正文相交。
     * ★ 不能直接用 R.intersect 判：图标整块在正文左边，两个矩形根本不相交，
     *   但它的下缘压在正文首行的 y 区间上 —— 正是它逼着正文右缩进。
     *   漏掉这一步的后果：算出的 dx 会把首行推进图标里，碰撞校验不过 → 策略空转、永远无效。 */
    const obst = shapes.filter(o => R.right(o.geomBox) <= bb.x + 1 &&
      R.bottom(o.geomBox) > bb.y && o.geomBox.y < R.bottom(bb));
    const gap = Math.max(st.pad, 10);
    const dx = r2((g.x + basePad) - bb.x);
    const dy = obst.length ? r2(Math.max(...obst.map(o => R.bottom(o.geomBox))) + gap - bb.y) : 0;
    if (dx >= -0.6 && dy <= 0.6) return null;
    const after = R.mk(bb.x + dx, bb.y + dy, bb.w, bb.h);
    /* 硬约束用 **analyzer 自己的 minPad**（而不是风格里更宽的 st.pad=16）：
     * 该卡内容是「图标 22 + 图标 56 + 间隙 16 + 正文 82」，竖向总共要 176px，
     * 卡片只有 190px —— 按 16px 卡底边就只剩 14px，永远过不了校验、策略形同虚设。
     * 只要不触发分析器的「内边距不足」惩罚（pad ≥ minPad）就算修好。 */
    const minPad = (typeof Analyzer !== 'undefined' && Analyzer.DEF) ? Analyzer.DEF.minPad : 6;
    const tol = 0.5, pad = Math.max(2, minPad);
    if (after.x < g.x + pad - tol || after.y < g.y + pad - tol ||
        R.right(after) > R.right(g) - pad + tol || R.bottom(after) > R.bottom(g) - pad + tol) return null;
    /* 不得与容器内任何其它标签或形状相撞 */
    for (const l of L) {
      if (body.indexOf(l) >= 0) continue;
      const it = R.intersect(after, l.bbox); if (it && it.w > 1 && it.h > 1) return null;
    }
    for (const o of shapes) { const it = R.intersect(after, o.geomBox); if (it && it.w > 1 && it.h > 1) return null; }
    return {
      body, dx, dy, before: bb, after, basePad, nObst: obst.length,
      why: `正文块缩进 ${r2(indent)}px → 归位到容器内边距 ${r2(basePad)}px（左移 ${r2(-dx)}px` +
        (dy > 0.6 ? `、下移 ${r2(dy)}px 让开左侧图标` : '') + `）`
    };
  },

  evReflowBody(ir, issues, st) {
    let fix = 0, worst = 0;
    const tot = issues.length || 1;
    for (const it of issues) {
      const n = it.evidence.nodeRef; if (!n) continue;
      const p = this.bodyReflow(ir, n, st);
      if (p) { fix++; worst = Math.max(worst, -p.dx); }
    }
    /* ★ 计分口径（为什么斜率这么大）：
     *   reflow 修一条就是**完全修好**（动完 pad 四边全部 ≥ minPad、该条 issue 消失），
     *   而 resize_container 是按「可补平比例」给的（实测 real-01 得 85.31，却留 10.43% 残余），
     *   而且它靠**改容器几何**换修复，天然带碰撞/对齐风险（real-05 就因此整批被 op 级门否决过）。
     *   所以覆盖率高处必须让 reflow 胜出：cov 0.6 → 86 > 85.31；cov 0.4 → 69 < 85（退回 resize）。
     *   还有一层：reflow 只修「被图标硬缩进」的那几条，修完第二轮其余条目自然落回
     *   resize_container（本层「0 op 0 skip 就顺位」的回退阶梯），两类条目都能收掉。 */
    return {
      score: fix ? clamp(r2(35 + 85 * Math.min(1, fix / tot)), 0, 100) : 25, risky: false,
      detail: fix ? `${fix}/${tot} 个容器的正文可左归位（最大左移 ${r2(worst)}px，不动容器、无新碰撞；本策略修一条即完全修好）`
                  : '无「正文被图标硬缩进」的容器'
    };
  },

  evWrap(ir, issues, st) {
    let ok = 0, need = 0, worstLines = 0;
    for (const it of issues) {
      const n = it.evidence.nodeRef; if (!n) continue;
      need++;
      const availW = Math.max(20, n.geomBox.w - 2 * st.pad);
      const lineH = Math.max(...n.labels.map(l => l.fontSize), 12) * 1.25 + st.lineGap;
      const lines = Math.max(...n.labels.map(l => Math.ceil(l.bbox.w / availW)), 1);
      if (lines < 2) continue;
      const needH = lines * lineH + 2 * st.pad + (n.labels.length - 1) * (lineH * 0.6);
      const fs = this.freeSpace(ir, n, 10);
      const fit = needH <= n.geomBox.h + fs.t + fs.b;
      if (fit) { ok++; worstLines = Math.max(worstLines, lines); }
    }
    const score = need === 0 ? 40 : r2(100 * ok / need * 0.9 + (ok ? 10 : 0));
    return { score: clamp(score, 0, 100), risky: ok < need, detail: `${ok}/${need} 个容器纵向可容纳换行（最多 ${worstLines} 行）` };
  },

  evReduceFont(ir, issues, st) {
    /* 与 opReduceFont 同口径：只能用**文档内已有档位**，且不得低于 0.60×原字号。
     * 否则预检给 55 分、op 构造器却返回 null → 决策选了一个产不出任何 op 的策略，
     * 整类问题空转一轮（历史「model 策略均值偏低」就是这么来的）。 */
    const tiers = this.fontTiers(ir, st);
    const sizes = [];
    let infeasible = 0;
    for (const it of issues) {
      const n = it.evidence.nodeRef; if (!n) continue;
      const availW = Math.max(10, n.geomBox.w - 2 * st.pad);
      const availH = Math.max(6, n.geomBox.h - 2 * st.pad);
      for (const l of n.labels) {
        const need = Math.max(l.bbox.w / availW, l.bbox.h / availH);
        if (!(need > 1)) continue;
        const target = l.fontSize / need;
        const want = tiers.find(t => t <= target + 0.01);
        if (want === undefined || want < l.fontSize * 0.60) { infeasible++; continue; }
        sizes.push(want);
      }
    }
    const minS = sizes.length ? Math.min(...sizes) : 14;
    const risky = !sizes.length || minS < 10;
    return {
      score: !sizes.length ? 25 : (risky ? 35 : 55), risky,
      detail: sizes.length ? `可缩至 ${nf(minS, 1)}px（文档档位 ${tiers.join('/')}px）${risky ? '，低于 10px 可读下限' : ''}`
                           : `${infeasible} 个标签无可用的更低档位（不允许腰斩 / 造新档）`
    };
  },

  evMoveApart(ir, an, issues) {
    let feasible = 0, blocked = 0, worst = 0;
    for (const it of issues) {
      const p = an.raw.collision.pairs.find(x => x.a === it.targets[0] && x.b === it.targets[1]);
      if (!p) continue;
      const plan = this.separation(ir, p);
      if (plan) { feasible++; worst = Math.max(worst, plan.dist); } else blocked++;
    }
    const n = feasible + blocked;
    const score = n === 0 ? 40 : r2(100 * feasible / n);
    return { score, risky: blocked > 0, detail: `可推开 ${feasible}/${n} 对（最大位移 ${r2(worst)}px）` };
  },

  evGrowSpacing(ir, an, issues, st) {
    let ok = 0, need = 0;
    for (const it of issues) {
      need++;
      const [a, b] = it.targets;
      const nb = ir.nodes.find(n => n.id === b);
      const fs = nb ? this.freeSpace(ir, nb, 10) : null;
      if (fs && (fs.r > 20 || fs.l > 20)) ok++;
    }
    return { score: need === 0 ? 40 : r2(60 + 40 * ok / need), risky: ok < need, detail: `${ok}/${need} 对有横向扩展余量` };
  },

  evSnap(ir, an, mode) {
    const want = mode === 'edges' ? ['left', 'right', 'top', 'bottom'] : ['centerX', 'centerY'];
    const cl = an.raw.alignment.clusters;
    const mine = cl.filter(c => want.indexOf(c.family) >= 0);
    const other = cl.filter(c => want.indexOf(c.family) < 0);
    const myErr = mine.reduce((a, c) => a + c.spread, 0);
    const otherErr = other.reduce((a, c) => a + c.spread, 0);
    return {
      score: r2(clamp(50 + myErr * 4 - otherErr * 0.5, 0, 100)),
      risky: false,
      detail: mode === 'edges' ? `边线类偏差 ${r2(myErr)}px / 中心类 ${r2(otherErr)}px` : `中心类偏差 ${r2(otherErr)}px / 边线类 ${r2(myErr)}px`
    };
  },

  evDistribute(ir, issues, mode, st) {
    let ok = 0, need = 0, worstGap = Infinity;
    for (const it of issues) {
      need++;
      const g = it.evidence;
      const ids = it.targets;
      const ns = ids.map(id => ir.nodes.find(n => n.id === id)).filter(Boolean);
      if (ns.length < 3) continue;
      const axis = g.axis === 'y' ? 'y' : 'x';
      const sorted = ns.slice().sort((a, b) => axis === 'x' ? a.bbox.x - b.bbox.x : a.bbox.y - b.bbox.y);
      const span = axis === 'x' ? R.right(sorted[sorted.length - 1].geomBox) - sorted[0].geomBox.x
                                : R.bottom(sorted[sorted.length - 1].geomBox) - sorted[0].geomBox.y;
      const sumW = sorted.reduce((a, n) => a + (axis === 'x' ? n.geomBox.w : n.geomBox.h), 0);
      const gap = (span - sumW) / (sorted.length - 1);
      worstGap = Math.min(worstGap, gap);
      if (gap >= 6) ok++;
    }
    const score = need === 0 ? 30 : r2(clamp(100 * ok / need, 0, 100));
    return { score, risky: ok < need, detail: `${ok}/${need} 组可均分（最小可得间距 ${isFinite(worstGap) ? r2(worstGap) : '—'}px）` };
  },

  evReroute(ir, an, issues) {
    const edges = new Set();
    for (const it of issues) {
      const e = it.evidence.kind === 'edge_through_node'
        ? ir.edges.find(x => x.id === it.targets[0])
        : ir.edges.find(x => it.targets.indexOf(x.id) >= 0);
      if (e) edges.add(e);
    }
    /* 预检上限：只试前 N 条连线。★F8：上限从 6 提到 12，并且**显式声明截断**
     * ——旧实现静默忽略第 7 条之后的连线，决策层会误以为已全覆盖。
     * 上限存在的原因是 routeEdge 是 O(E) 的栅格 A*，预检阶段要控制总开销。 */
    const REROUTE_PRE = 12;
    const all = [...edges];
    const list = all.slice(0, REROUTE_PRE);
    const trunc = all.length > list.length ? `；另有 ${all.length - list.length} 条未预检（仅取前 ${REROUTE_PRE} 条）` : '';
    let ok = 0, worst = null;
    for (const e of list) {
      const r = this.routeEdge(ir, e);
      if (r && !r.failed) ok++;
      else worst = e.describe;
    }
    const n = list.length || 1;
    return {
      score: r2(clamp(100 * ok / n, 0, 100)), risky: ok < n,
      detail: `${ok}/${n} 条连线找到「零节点穿越且不增加交叉」的正交路径${worst ? '；失败：' + worst : ''}${trunc}`
    };
  },

  evKeepShift(ir, issues) {
    const nodes = [];
    for (const it of issues) {
      const ndId = it.evidence.kind === 'edge_through_node' ? it.targets[1] : null;
      if (ndId) nodes.push(ndId);
    }
    return { score: nodes.length ? 50 : 30, risky: true, detail: nodes.length ? `改移 ${nodes.length} 个被穿越节点` : '无被穿越节点可移' };
  },

  evRebalance(ir, an) {
    const cb = an.raw.canvas.contentBox || ir.contentBox;
    if (!cb) return { score: 40, detail: '无内容盒' };
    const dx = r2((ir.canvas.w - cb.w) / 2 - cb.x), dy = r2((ir.canvas.h - cb.h) / 2 - cb.y);
    const fits = cb.w <= ir.canvas.w && cb.h <= ir.canvas.h;
    return { score: fits ? 100 : 40, risky: !fits, detail: `内容整体平移 (${dx}, ${dy}) 至居中` };
  },

  /* ==================== 画布收尾（同轮追加，不占决策） ====================
   * 为什么必须同轮做：resize_container / grow_to_min / wrap_text 会把内容盒撑大。
   * 若把画布重平衡留到下一轮，本轮 canvas 维度必然劣化 → Validator 守卫否决整轮，
   * 一个真实的正收益被丢掉（实测 raw-grid-…-s24 增益 +14.45 被整体回滚）。
   * 本算子只做两件几何事实：
   *   ① 内容盒 + 对称留白 超出画布 → 扩画布（走 svgcanvas 原生 setResolution）；
   *   ② 把内容整体平移到对称留白。
   * ★ 纯几何：无决策、无随机、不读 Laya。 */
  canvasTail(ir, an, st, pad) {
    const cb = an.raw.canvas.contentBox || ir.contentBox;
    const out = { ops: [], grow: false };
    if (!cb || !(cb.w > 0) || !(cb.h > 0)) return out;
    const P = (pad === undefined) ? (st ? Math.max(18, st.pad + 8) : 24) : pad;
    const W0 = ir.canvas.w, H0 = ir.canvas.h;

    /* ★ 满版设计必须原样放行（用户反馈 #1 的隐藏推手）。
     * 很多成品图自带一块 `x=0 y=0 width=W height=H` 的底色矩形，内容盒因此等于整张画布。
     * 旧逻辑无条件要求「四边至少 P 留白」，于是给一张本来就满版的图再扩 2P，
     * 并把全部内容平移 +P —— 底色矩形不再覆盖新画布，四周多出白边，且
     * 所有元素相对底色的位置全部偏移（real-01/05 实测 1920×1080 → 1969×1129、整体 +24.5）。
     * 判据：存在一块「≥90% 画布面积且四边贴边」的底板，且内容盒没有明显溢出。
     * 容差用 1.5px 而不是 0.6px：`worldBBox(shape,{stroke:true})` 对**无描边**元素也会
     * 留 0.5px 出血（实测底板 geomBox=1920×1080 但 bbox=-0.5,-0.5,1921×1081），
     * 用 0.6 会把「满版」误判成「横向溢出了 1px」而不放行。 */
    const cArea0 = Math.max(1, W0 * H0);
    const plate = (ir.nodes || []).find(n =>
      R.area(n.geomBox) >= cArea0 * 0.90 &&
      n.geomBox.x <= W0 * 0.02 && n.geomBox.y <= H0 * 0.02 &&
      R.right(n.geomBox) >= W0 * 0.98 && R.bottom(n.geomBox) >= H0 * 0.98);
    if (plate && cb.w <= W0 + 1.5 && cb.h <= H0 + 1.5) {
      out.pad = null; out.flush = true;
      out.note = `已存在满版底板 ${plate.describe}（${r2(cb.w)}×${r2(cb.h)} vs 画布 ${W0}×${H0}）→ 不做留白重排`;
      return out;
    }

    /* ★ 统一留白 m：不能只按最小留白扩一个轴。
     * 若横向扩到 24px 而纵向仍是原来的 39.6px，四边留白不等 →
     * balance = sd/mean = 0.245 → canvas 分值 100→88，守卫照样否决（实测踩到）。
     * 正确解：m 取 max(最小留白, 两轴现有留白)，四边一律 m；
     * 内容本来就均衡时 m 恰等于原留白 → W/H 回到 W0 → 收尾自然成为空操作。 */
    let m = Math.max(P, (W0 - cb.w) / 2, (H0 - cb.h) / 2);
    m = r2(m);
    let W = r2(cb.w + 2 * m), H = r2(cb.h + 2 * m);
    if (!(W > W0 + 0.6)) W = W0;
    if (!(H > H0 + 0.6)) H = H0;
    out.pad = m;
    out.grow = (W !== W0) || (H !== H0);
    out.canvas = { w0: W0, h0: H0, w: W, h: H, pad: m };

    if (out.grow) {
      out.ops.push({
        kind: 'canvas', target: null, strategy: 'rebalance_canvas', issueType: 'canvas_margin',
        why: `内容盒 ${r2(cb.w)}×${r2(cb.h)} + 统一留白 ${m}×4 超出画布 ${W0}×${H0} → 扩至 ${W}×${H}`,
        preview: { before: R.mk(0, 0, W0, H0), after: R.mk(0, 0, W, H) },
        apply: () => Runtime.setResolution(W, H),
        label: `扩展画布 ${W0}×${H0} → ${W}×${H}`
      });
    }
    const dx = r2((W - cb.w) / 2 - cb.x), dy = r2((H - cb.h) / 2 - cb.y);
    out.dx = dx; out.dy = dy;
    if (Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6) return out;

    const why = `画布收尾平移 (${dx}, ${dy}) 至对称留白`;
    for (const n of ir.nodes) {
      out.ops.push({
        kind: 'translate', target: n.elem, strategy: 'rebalance_canvas', issueType: 'canvas_margin', why,
        preview: { before: n.bbox, after: { x: r2(n.bbox.x + dx), y: r2(n.bbox.y + dy), w: n.bbox.w, h: n.bbox.h } },
        apply: () => this.applyTranslate(n, dx, dy), label: `平移 ${n.describe}`
      });
    }
    for (const e of ir.edges) {
      const pts = e.pts.map(p => ({ x: r2(p.x + dx), y: r2(p.y + dy) }));
      out.ops.push({
        kind: 'path', target: e.elem, strategy: 'rebalance_canvas', issueType: 'canvas_margin', why,
        preview: { before: R.fromPoints(e.pts), after: R.fromPoints(pts), path: pts },
        apply: () => this.applyPath(e, pts, st), label: `平移 ${e.describe}`
      });
    }
    /* 自由文本（不含已归属节点的标签，节点标签已随 applyTranslate(node) 一起走） */
    for (const t of ir.texts) {
      out.ops.push({
        kind: 'translate', target: t.elem, strategy: 'rebalance_canvas', issueType: 'canvas_margin', why,
        preview: { before: t.bbox, after: { x: r2(t.bbox.x + dx), y: r2(t.bbox.y + dy), w: t.bbox.w, h: t.bbox.h } },
        apply: () => this.applyTranslate(t, dx, dy), label: '平移 free text'
      });
    }
    return out;
  },

  evGrowMin(ir, an, issues) {
    const target = ir.medArea * 0.5;
    const rows = issues.map(it => {
      const n = ir.nodes.find(x => x.id === it.targets[0]); if (!n) return null;
      const need = target / Math.max(1, R.area(n.geomBox));
      return { n, scale: Math.sqrt(Math.max(1, need)), newW: r2(n.geomBox.w * Math.sqrt(Math.max(1, need))), newH: r2(n.geomBox.h * Math.sqrt(Math.max(1, need))) };
    }).filter(Boolean);
    let collide = 0;
    for (const r of rows) {
      const rect = R.mk(R.cx(r.n.geomBox) - r.newW / 2, R.cy(r.n.geomBox) - r.newH / 2, r.newW, r.newH);
      if (this.wouldCollide(ir, r.n, rect)) collide++;
    }
    return {
      score: r2(clamp(100 - collide * 40, 0, 100)), risky: collide > 0,
      detail: `${rows.length} 个过小节点放大约 ${nf(rows.length ? rows[0].scale : 1, 2)}×${collide ? `，${collide} 个会碰撞` : ''}`
    };
  },

  /* ============ 文字遮挡修复：平移出遮挡 / 提升图层 ============
   * 两种策略都只动「被遮挡的那个文字」，不动任何形状几何，因此不会引入新的
   * 节点碰撞；评分由几何可行性预检给出，决策层再按分数排序选首选、其余顺位兜底。 */
  evNudgeText(ir, issues, st) {
    /* 平移适合「同父级 / 或遮挡形状不在文字之后绘制」的情形（把文字移出形状几何重叠即可）。
     * 跨父级且遮挡形状在文字之后绘制时，平移改不了层级，_nudgePlan 返回 null，交棒 raise_text。
     * 仅在「能找到一个不越界、不与其它不透明形状新生成 ≥30% 覆盖的平移方向」时才算可修。 */
    let fix = 0, worst = 0;
    for (const it of issues) {
      const oc = it.evidence; if (!oc || !oc.textRef || !oc.shapeRef) continue;
      if (this._nudgePlan(ir, oc, st)) { fix++; worst = Math.max(worst, oc.cover); }
    }
    return { score: fix ? r2(72 + 20 * Math.min(1, fix / Math.max(1, issues.length))) : 25, risky: false,
      detail: fix ? `${fix}/${issues.length} 条文字可平移出遮挡（最大覆盖 ${pct(worst)}）` : '无安全平移方向（改走提升图层）' };
  },

  evRaiseText(issues) {
    /* 提升图层（z-order）是文字遮挡的**通用兜底**：只要文字与遮挡形状都在画布里，
     * 把文字重排到形状之后绘制即可保证可见。opRaiseText 已支持跨父级（用 getScreenCTM
     * 补偿，位置不变），所以不再限制同父级——对所有遮挡项都算可修。 */
    let fix = 0;
    for (const it of issues) {
      const oc = it.evidence; if (!oc || !oc.textRef || !oc.shapeRef) continue;
      const tEl = oc.textRef.elem, mEl = oc.shapeRef.shapeElem || oc.shapeRef.elem;
      if (!tEl || !mEl || !tEl.parentNode || !mEl.parentNode) continue;
      fix++;
    }
    return { score: fix ? r2(60 + 30 * Math.min(1, fix / Math.max(1, issues.length))) : 25, risky: false,
      detail: fix ? `${fix}/${issues.length} 条文字可提升图层至遮挡形状之上（跨父级亦安全）` : '无可提升文字' };
  },

  /* 为被遮挡文字计算一个「平移出形状」的方向：四选一（左/右/上/下）取代价最小者，
   * 要求：不出画布、不与其它不透明形状（排除遮挡者与自身归属节点）生成 ≥30% 覆盖。 */
  _nudgePlan(ir, oc, st) {
    const t = oc.textRef, m = oc.shapeRef, tb = t.bbox, mb = m.geomBox;
    if (!tb || !mb) return null;
    /* ★ 跨父级且遮挡形状在文字「之后」绘制：平移只改文字自身坐标，无法改变它所在组
     *   的绘制层级（整组都画在遮挡形状所在组之前），所以平移永远解不掉这类遮挡，
     *   直接返回 null 让决策层交棒 raise_text（跨父级提升，已做 CTM 补偿）。 */
    const tEl = t.elem, mEl = m.shapeElem || m.elem;
    if (tEl && mEl && tEl.parentNode && mEl.parentNode && tEl.parentNode !== mEl.parentNode) {
      const FOLLOWING = (typeof Node !== 'undefined' && Node.DOCUMENT_POSITION_FOLLOWING) || 4;
      try { if ((tEl.compareDocumentPosition(mEl) & FOLLOWING) !== 0) return null; } catch (x) {}
    }
    const gap = 4, W = ir.canvas.w, H = ir.canvas.h;
    const cands = [
      { dx: (mb.x - gap) - R.right(tb), dy: 0 },   /* 左移：右缘 ≤ 形状左缘 */
      { dx: (R.right(mb) + gap) - tb.x, dy: 0 },   /* 右移 */
      { dx: 0, dy: (mb.y - gap) - R.bottom(tb) },  /* 上移：底缘 ≤ 形状顶缘 */
      { dx: 0, dy: (R.bottom(mb) + gap) - tb.y }   /* 下移 */
    ];
    let best = null, bestCost = Infinity;
    for (const c of cands) {
      if (Math.abs(c.dx) < 0.6 && Math.abs(c.dy) < 0.6) continue;
      const na = R.mk(tb.x + c.dx, tb.y + c.dy, tb.w, tb.h);
      if (na.x < -0.5 || na.y < -0.5 || R.right(na) > W + 0.5 || R.bottom(na) > H + 0.5) continue; /* 出画布 */
      let blocked = false;
      for (const o of ir.nodes) {
        if (o === m || o === oc.ownerRef || o.isBg) continue;
        if (!normColor(o.fill)) continue;
        /* 文字**当前**已与该节点大量共面（如标题本来就坐在面板里）→ 移动后仍可共存，不算新遮挡 */
        const cur = R.intersect(tb, o.geomBox);
        if (cur && R.area(cur) / R.area(tb) >= 0.3) continue;
        const it = R.intersect(na, o.geomBox);
        if (it && R.area(it) / R.area(na) >= 0.3) { blocked = true; break; }
      }
      if (blocked) continue;
      const cost = Math.abs(c.dx) + Math.abs(c.dy);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    return best;
  },

  opNudgeText(ir, an, oc, st, key, it) {
    const plan = this._nudgePlan(ir, oc, st);
    if (!plan) return null;
    const t = oc.textRef, tb = t.bbox;
    const after = { x: r2(tb.x + plan.dx), y: r2(tb.y + plan.dy), w: tb.w, h: tb.h };
    const why = `文字${t.text ? '“' + t.text.slice(0, 12) + '”' : t.id} 被 ${oc.shapeRef.describe} 遮挡 → 平移 (${r2(plan.dx)}, ${r2(plan.dy)}) 移出遮挡`;
    return {
      kind: 'translate', target: t.elem, strategy: key, issueType: 'occlusion', why,
      preview: { before: tb, after },
      apply: () => this.applyTranslate({ elem: t.elem }, plan.dx, plan.dy),
      label: `移出遮挡 ${t.id}`
    };
  },

  opRaiseText(ir, an, oc, key, it) {
    const t = oc.textRef, m = oc.shapeRef;
    const tEl = t.elem, mEl = m.shapeElem || m.elem;
    if (!tEl || !mEl || !tEl.parentNode || !mEl.parentNode) return null;
    const before = Object.assign({}, t.bbox);
    const why = `文字${t.text ? '“' + t.text.slice(0, 12) + '”' : t.id} 被 ${m.describe} 遮挡 → 提升图层至其之上渲染（保证可见）`;
    return {
      kind: 'raise', target: tEl, strategy: key, issueType: 'occlusion', why,
      preview: { before, after: before },
      apply: () => {
        try {
          const mParent = mEl.parentNode, oldParent = tEl.parentNode;
          if (oldParent === mParent) {                       /* 同父级：直接提升，位置天然不变 */
            mParent.insertBefore(tEl, mEl.nextSibling);
            return;
          }
          /* 跨父级提升：把文字移到遮挡形状所在父级、紧随其后绘制。
           * 两级父级若存在 transform / 嵌套差异，用 getScreenCTM 给文字补一个补偿 matrix，
           * 使其视觉位置保持不变——对任意嵌套、任意变换都位置安全（更健壮普适）。 */
          const M0 = tEl.getScreenCTM && tEl.getScreenCTM();  /* 文字当前：局部 → 屏幕 */
          const B = mParent.getScreenCTM && mParent.getScreenCTM(); /* 目标父级：局部 → 屏幕 */
          if (M0 && B && typeof B.inverse === 'function' && typeof B.multiply === 'function') {
            const N = B.inverse().multiply(M0);              /* 文字局部 → 目标父级局部 */
            const f = n => r2(n);
            tEl.setAttribute('transform',
              `matrix(${f(N.a)} ${f(N.b)} ${f(N.c)} ${f(N.d)} ${f(N.e)} ${f(N.f)})`);
          }
          mParent.insertBefore(tEl, mEl.nextSibling);
        } catch (e) {
          /* 补偿失败（如未渲染拿不到 CTM）：按原样提升，至少保证文字可见 */
          try { mEl.parentNode.insertBefore(tEl, mEl.nextSibling); } catch (_) {}
        }
      },
      label: `提升图层 ${t.id}`
    };
  },

  /* ==================== ops 生成 ==================== */
  plan(ir, an, dec, sopt) {
    const st = this.styleOf(dec.applied.style ? styleKey(dec.applied.style) : (sopt && sopt.style));
    const phaseName = dec.applied.fix_order ? dec.applied.fix_order.choice : 'geometry_first';
    const phase = this.PHASES[phaseName] || this.PHASES.geometry_first;
    /* ★ item 列表按**最新**分析态重建，策略选择（key）来自决策本身。
     * 这样「一次前向 → 多步重规划」不会重复调用模型，符合 §21 的局部判断定位。 */
    const byType = (typeof LayaRule !== 'undefined' && LayaRule.groupByType)
      ? LayaRule.groupByType(an) : (dec.plan.__byType || {});
    const gate = dec.gate || {};
    const rej = (sopt && sopt.reject) || [];   /* ['issueType|strategy', ...] 本轮已被 op 级门淘汰者 */

    const groups = [];
    for (const type of Object.keys(byType)) {
      const rec = dec.applied['strategy_' + type];
      let key = rec ? rec.choice : (byType[type][0].candidates || [])[0];
      /* 策略回退阶梯：首选策略被淘汰时，沿决策层已经排好的候选顺位退一格。
       * 决策本身只跑一次（ranks 已在决策里算好），所以这不增加任何模型调用。 */
      if (rej.length && rej.indexOf(type + '|' + key) >= 0) {
        const ranks = ((dec.plan && dec.plan.__strategies) || {})[type] || [];
        const alt = ranks.map(r => r.key).filter(k => rej.indexOf(type + '|' + k) < 0)[0];
        if (!alt) continue;      /* 该类的全部候选策略本轮都已失败 → 放弃该类 */
        key = alt;
      }
      let items = byType[type];
      if (!gate.safeAll) items = items.filter(i => i.priority !== 'critical');
      /* ★ F1：本轮已按 item 提交失败的 (策略, item) 组合不再产出。
       * 注意 `key` 在此处**已经定稿**（上面的回退阶梯刚算完），所以组合键里必须带上
       * 当前策略 —— 只用 item 会让一个策略的失败连带封杀同类问题的其它策略（实测回归）。
       * 键与 07_patch 的写入端同构：gateKey + '|' + itemTargets。 */
      if (sopt && sopt.rejectItems && sopt.rejectItems.length) {
        const gk = type + '|' + (key || '');
        items = items.filter(i => sopt.rejectItems.indexOf(
          gk + '|' + (i && i.targets ? i.targets.join(',') : '')) < 0);
      }
      if (!items.length) continue;
      groups.push({ type, key, items, phase: phase.indexOf(type), src: rec ? rec.source : 'rule' });
    }
    groups.sort((a, b) => (a.phase - b.phase) || (a.type < b.type ? -1 : 1));

    const ops = [], skipped = [], dbg = [];
    const owner = new Map();
    const cur = { type: '', key: '' };
    const ik = it => (it && it.targets ? it.targets.join(',') : '');
    const claim = (el, op, itemKey) => {
      /* 归因键两层：
       *  gateKey —— 生效校验与黑名单的最小单元。一律取「issue 类型」，
       *   因为一类问题的修复动作天然是原子组：等距分布必须整行一起挪、
       *   画布重平衡必须整幅一起平移、连线避障要整组重路由；
       *   拆到单元素判定会把整组打散（实测 canvas 97.9→97.9 归零）。
       *  itemKey —— 仅用于台账展示「这批里包含哪几条 issue」。 */
      op.gateKey = cur.type + '|' + (cur.key || '');
      if (itemKey !== undefined && itemKey !== null) op.itemKey = cur.type + '|' + itemKey;
      /* ★F1 修正（实测回归后补）：item 级黑名单必须**按策略分域**，因此另存裸目标串。
       * 只按 item 记账会把「wrap_text 在这个 item 上失败」误推广成「这个 item 在任何
       * 策略上都无救」，从而连带封杀 resize_container / move_text 等同 item 的其它策略。
       * 实测代价：real-02 丢掉一次本会被接受的 resize_container#5（72.15 → 68.95），
       * real-03 丢掉 resize_container#2（69.95 → 69.55）。旧版的 gateKey 黑名单是
       * 「issue 类型 + 策略」二元键，item 级黑名单必须保持同样的粒度。
       * 组合键 = gateKey + '|' + itemTargets（见 plan() 里的过滤与 07_patch 的写入）。 */
      if (itemKey !== undefined && itemKey !== null) op.itemTargets = itemKey;
      if (owner.has(el)) { op.skipped = '该元素本轮已被 ' + owner.get(el) + ' 占用'; skipped.push(op); return false; }
      owner.set(el, op.strategy);
      ops.push(op);
      return true;
    };
    const mk = (kind, target, strategy, issueType, why, preview, apply, label) =>
      ({ kind, target, strategy, issueType, why, preview, apply, label });

    for (const g of groups) {
      cur.type = g.type;
      /* ★ 几何不可行 → 按决策层**已排好的顺位**再试一格，不增加任何模型调用。
       * 为什么必须做：决策可能选中一个几何上无解的策略，而「无解」= op 构造器返回 null
       * = 该类问题 0 op = 整轮零修复。实测两例：
       *   s14 model 选 reduce_font，但该图字号已是最低档 → opReduceFont 返回 null；
       *   s11 model 选 keep_canvas → 0 op。
       * 后果是 model 策略 22 例均值 96.79，远低于 rule 的 99.04（差 2.25 分）。
       * 判定口径：本次迭代**既没产出 op 也没产出 skip**（说明该策略根本不适用），
       * 才继续顺位；只要产出了（哪怕只是 skip），立刻停手 —— 否则 overlap 这类
       * 与 key 无关的分支会被重复执行、push 重复的 skip。 */
      const ranks = (((dec.plan && dec.plan.__strategies) || {})[g.type] || []).map(r => r.key);
      const tried = [];
      const opsBeforeAll = ops.length, skipBeforeAll = skipped.length;
      let key = g.key;
      for (;;) {
        tried.push(key); g.key = key; cur.key = key;
        const opsBefore = ops.length;
        const skipBefore = skipped.length;
        switch (g.type) {
        case 'text_overflow': {
          for (const it of g.items) {
            const n = it.evidence.nodeRef; if (!n) continue;
            if (g.key === 'resize_container') {
              const op = this.opResize(ir, an, n, st, g.key, it);
              if (op) claim(n.elem, op, ik(it));
            } else if (g.key === 'reflow_body') {
              const op = this.opReflowBody(ir, n, st, g.key, it);
              if (op) claim(n.elem, op, ik(it));
            } else if (g.key === 'move_text') {
              for (const l of n.labels) {
                const op = this.opFixAnchor(ir, n, l, g.key, it);
                if (op) claim(l.elem, op, ik(it));
              }
            } else if (g.key === 'wrap_text') {
              const op = this.opWrap(ir, an, n, st, g.key, it);
              if (op) claim(n.elem, op, ik(it));
            } else if (g.key === 'reduce_font') {
              const op = this.opReduceFont(ir, n, st, g.key, it);
              if (op) claim(n.elem, op, ik(it));
            }
          }
          break;
        }
        case 'overlap': {
          for (const it of g.items) {
            const p = an.raw.collision.pairs.find(x => x.a === it.targets[0] && x.b === it.targets[1]);
            if (!p) continue;
            const sp = this.separation(ir, p);
            if (!sp) { skipped.push({ skipped: '无可推开方向', strategy: g.key, issueType: g.type }); continue; }
            const mover = sp.mover;
            const op = mk('translate', mover.elem, g.key, g.type,
              `与 ${sp.other.describe} 重叠 ${p.depth}px，沿 ${sp.axis} 推开 ${sp.dist}px`,
              { before: mover.bbox, after: sp.after },
              () => this.applyTranslate(mover, sp.dx, sp.dy),
              `推开 ${mover.describe}`);
            claim(mover.elem, op, ik(it));
          }
          break;
        }
        case 'occlusion': {
          for (const it of g.items) {
            const oc = an.raw.occlusion.items.find(x => x.textId === it.targets[0] && x.shapeId === it.targets[1]);
            if (!oc) continue;
            if (g.key === 'nudge_text') {
              const op = this.opNudgeText(ir, an, oc, st, g.key, it);
              if (op) claim(oc.textRef.elem, op, ik(it));
            } else if (g.key === 'raise_text') {
              const op = this.opRaiseText(ir, an, oc, st, g.key, it);
              if (op) claim(oc.textRef.elem, op, ik(it));
            }
          }
          break;
        }
        case 'misalignment': {
          const cl = this.snapTargets(ir, an, g.key);
          for (const t of cl) {
            const n = t.node;
            const it0 = t.items[0];
            const op = mk('translate', n.elem, g.key, g.type,
              `${it0.cn}偏差 ${it0.spread}px → 吸附到 ${it0.target}（dx=${t.dx}, dy=${t.dy}）`,
              { before: n.bbox, after: { x: n.bbox.x + t.dx, y: n.bbox.y + t.dy, w: n.bbox.w, h: n.bbox.h } },
              () => this.applyTranslate(n, t.dx, t.dy),
              `吸附 ${n.describe}`);
            claim(n.elem, op, n.id);
          }
          break;
        }
        case 'spacing': {
          for (const it of g.items) {
            const ns = it.targets.map(id => ir.nodes.find(n => n.id === id)).filter(Boolean);
            if (ns.length < 3) continue;
            const axis = it.evidence.axis === 'y' ? 'y' : 'x';
            /* ★ 剔除「把同组其它成员整个装进去」的容器节点。
             * 间距 issue 的 targets 常把外层容器一并列进来（它是该行的视觉成员），
             * 但容器一旦参与均分，sumW 会凭空多出一个整幅宽度：
             * span−sumW 变负 → gap 变负 → cursor 直接跳到容器右边 → 实测把 5 个卡片
             * 挪到 x=2101 / y=1808（画布只有 1920×1080），「均分」变成「扔出画布」。
             * 判据必须是**真包含**（外框包住其余全部成员且面积显著更大）——
             * 不能用 coverRatio：它按 min(面积) 归一，会把「小卡在行包围盒内」也误判成容器。 */
            const members = ns.filter(n => {
              const ob = R.union(ns.filter(x => x !== n).map(x => x.geomBox));
              if (!ob) return true;
              const encloses = n.geomBox.x <= ob.x + 0.5 && n.geomBox.y <= ob.y + 0.5 &&
                               R.right(n.geomBox) >= R.right(ob) - 0.5 && R.bottom(n.geomBox) >= R.bottom(ob) - 0.5 &&
                               R.area(n.geomBox) >= R.area(ob) * 1.05;
              return !encloses;
            });
            if (members.length < 3) continue;
            const sorted = members.slice().sort((a, b) => axis === 'x' ? a.bbox.x - b.bbox.x : a.bbox.y - b.bbox.y);
            /* ★ 队列性校验：沿分布轴两两不得重叠。
             * 分析器的聚类口径是「另一轴中心相近」，这会把**同心嵌套**的元素也算成一列
             * ——实测 real-01 的页头横条与中央大容器 cx 都是 957.5、cy 只差 2.5，
             * 于是被判成同一行/同一列，而它们沿 y 是**包含**关系（gap = −896.5px）。
             * 对包含关系的组做「均分」= 把容器往下扔 721px（实测 textFit 96→90、canvas 崩）。
             * gap < 0 一律拒绝该组。 */
            let nested = false;
            for (let i = 1; i < sorted.length; i++) {
              if (R.gap(sorted[i - 1].bbox, sorted[i].bbox, axis) < -1) { nested = true; break; }
            }
            if (nested) {
              skipped.push({ skipped: `该组沿 ${axis} 轴存在重叠/嵌套，不是可均分的队列`, strategy: g.key, issueType: g.type, target: ik(it) });
              continue;
            }
            const span = axis === 'x' ? R.right(sorted[sorted.length - 1].geomBox) - sorted[0].geomBox.x
                                      : R.bottom(sorted[sorted.length - 1].geomBox) - sorted[0].geomBox.y;
            const sumW = sorted.reduce((a, n) => a + (axis === 'x' ? n.geomBox.w : n.geomBox.h), 0);
            /* ★ F4b：grow_spacing 与 move_apart 语义分家。
             * 旧实现里 grow_spacing 与 move_apart **共用 separation() 同一段代码**
             * （只换 g.key 与标签），于是两条候选在实测台账里给出逐字相同的数字，
             * 而 "整体扩间距" 这个名字承诺的是组级行为。这里把它接到组级设施上：
             * 目标间距取「观测均值」与「风格 gap」的较大者 —— 即"向风格目标拉开"，
             * 而 distribute_equal 仍是"归一到观测跨度"。出画布保护（见下）与
             * 最小间距 6px 继续生效，所以"拉开"永远不会把元素扔出画布。 */
            const observed = (span - sumW) / (sorted.length - 1);
            const base = g.key === 'distribute_weighted' ? null
                       : g.key === 'grow_spacing' ? Math.max(observed, st.gap)
                       : observed;
            let cursor = axis === 'x' ? sorted[0].geomBox.x : sorted[0].geomBox.y;
            const wsum = sorted.reduce((a, n) => a + n.importance, 0);
            for (let i = 0; i < sorted.length; i++) {
              const n = sorted[i];
              if (i === 0) { cursor += axis === 'x' ? n.geomBox.w : n.geomBox.h; continue; }
              const gap = base === null ? (span - sumW) * (n.importance / wsum) / (sorted.length - 1) : base;
              const cur = axis === 'x' ? n.geomBox.x : n.geomBox.y;
              const want = r2(cursor + Math.max(6, gap));
              const d = r2(want - cur);
              if (Math.abs(d) > 0.6) {
                const dx = axis === 'x' ? d : 0, dy = axis === 'y' ? d : 0;
                /* ★ 出画布的位移一律不发（用户反馈的「虚线框跑到左上」同源：
                 *   元素被挪到画布外后，选择框也跟着落到画布外）。 */
                const probe = { x: n.bbox.x + dx, y: n.bbox.y + dy, w: n.bbox.w, h: n.bbox.h };
                if (probe.x < -0.5 || probe.y < -0.5 ||
                    R.right(probe) > ir.canvas.w + 0.5 || R.bottom(probe) > ir.canvas.h + 0.5) {
                  skipped.push({ skipped: `均分会把 ${n.describe} 移出画布（${r2(probe.x)},${r2(probe.y)}）`, strategy: g.key, issueType: g.type, target: n.describe });
                  break;
                }
                const op = mk('translate', n.elem, g.key, g.type,
                  `间距 ${it.evidence.gaps ? it.evidence.gaps[i - 1] : '?'}px → ${r2(Math.max(6, gap))}px`,
                  { before: n.bbox, after: probe },
                  () => this.applyTranslate(n, dx, dy),
                  `均分 ${n.describe}`);
                claim(n.elem, op, ik(it));
              }
              cursor = want + (axis === 'x' ? n.geomBox.w : n.geomBox.h);
            }
          }
          break;
        }
        case 'edge_crossing': {
          if (g.key === 'orthogonal_reroute') {
            const seen = new Set();
            for (const it of g.items) {
              const e = it.evidence.kind === 'edge_through_node'
                ? ir.edges.find(x => x.id === it.targets[0])
                : ir.edges.find(x => it.targets.indexOf(x.id) >= 0);
              if (!e || seen.has(e.id)) continue;
              seen.add(e.id);
              const r = this.routeEdge(ir, e);
              if (!r || r.failed) { skipped.push({ skipped: '未找到无穿越路径', strategy: g.key, issueType: g.type, target: e.describe }); continue; }
              const op = mk('path', e.elem, g.key, g.type,
                `${e.routing} → orthogonal，绕开 ${r.avoided} 个障碍`,
                { before: R.fromPoints(e.pts), after: R.fromPoints(r.pts), path: r.pts },
                () => this.applyPath(e, r.pts, st), `重路由 ${e.describe}`);
              claim(e.elem, op, e.id);
            }
          } else {
            const nodes = new Set();
            for (const it of g.items) if (it.evidence.kind === 'edge_through_node') {
              const n = ir.nodes.find(x => x.id === it.targets[1]);
              if (n) nodes.add(n);
            }
            for (const n of nodes) {
              const fs = this.freeSpace(ir, n, 10);
              const axis = fs.r >= fs.l ? 'r' : 'l';
              const d = r2(Math.min(40, Math.max(18, (axis === 'r' ? fs.r : fs.l) * 0.6)));
              const dx = axis === 'r' ? d : -d;
              const op = mk('translate', n.elem, g.key, g.type,
                `移出路由通道（沿 x ${dx > 0 ? '+' : ''}${dx}px）`,
                { before: n.bbox, after: { x: n.bbox.x + dx, y: n.bbox.y, w: n.bbox.w, h: n.bbox.h } },
                () => this.applyTranslate(n, dx, 0), `移位 ${n.describe}`);
              claim(n.elem, op, n.id);
            }
          }
          break;
        }
        case 'style_inconsistency': {
          if (g.key !== 'normalize_style') break;
          /* ---------- ① 字号归一：档位必须「相对本文档」，且不许腰斩 ----------
           * 旧实现直接用 STYLE 预设的绝对档位（如 enterprise = [15,13]px）。
           * 那套数值是给小尺寸画布调的；套到 1920×1080 的海报上，54/30/24/22/19/17px
           * 会被一律压成 15/13（real-05 实测全部落到 12/14px），
           * 直接产出「文字比背景小一大截」的成品，而且因为 Analyzer.textFit 只惩罚
           * 「文字太挤」不惩罚「文字太小」，这个破坏反而被判为加分。
           * 现改为：档位 = 「本文档自己的两个主流字号」，且单次改动幅度限制在
           * [0.70×, 1.45×] 之间，超出即放弃该条（宁可不动，也不越改越丑）。 */
          const tiers = this.fontTiers(ir, st);
          for (const n of ir.nodes) {
            const ls = n.labels.slice().sort((a, b) => a.bbox.y - b.bbox.y);
            ls.forEach((l, i) => {
              const want = this.nearestTier(l.fontSize, tiers, i, st);
              if (want === null || Math.abs(l.fontSize - want) < 0.4) return;
              const op = mk('attr', l.elem, g.key, g.type,
                `字号 ${nf(l.fontSize, 1)} → ${want}px（文档档位 ${tiers.join('/')}px）`,
                null,
                () => setA(l.elem, 'font-size', want),
                `字号 ${l.text.slice(0, 10)}`);
              claim(l.elem, op, 'fs:' + l.text.slice(0, 10));
            });
          }
          /* ---------- ② 填充归一：只归「同色族近重复色」 ----------
           * ★ 修复「大面积蓝色异常」：不再用全局最高频色强刷，
           *   改为按色距聚族，且大件（背景板/容器）与跨明度的改动一律豁免。
           *   real-05 实测：修复前 15 种填充 → 1 种（全 #1769e0）；修复后带色距
           *   阈值的族内归一不再触碰任何浅底。 */
          const fills = an.raw.style.fills;
          if (fills.length > 1) {
            /* 阈值 40：能把「同一套浅色卡片的几个色相」（实测 s21 的 #e6f1fb/#ffe4e6/
             * #fef3c7/#f3e8ff 两两 15~40）归成一个，但够不着 real-05 里
             * 浅底 → 饱和品牌蓝（色距 250+）这种跨量纲跳变。
             * 只取 8 会把 s21 这种「样式噪声」样例也判为无需归一，风格分回不去。 */
            const tol = (isFinite(sopt && sopt.fillTol) ? sopt.fillTol : 40);
            const groups = clusterFills(fills, tol);
            const cArea = Math.max(1, ir.canvas.w * ir.canvas.h);
            /* 各色「在用它的最大元素面积」。
             * ★ 目标色若是某个**显著更大**的元素（≥8 倍面积）在用，说明它是版面骨架色
             * （页面底 / 大容器）——把一张小卡片刷成它 = 卡片溶进背景，肉眼就是「卡片消失」。
             * real-05 的 #f7fbff 由 1920×1080 底板使用（面积比 68×）→ 全部浅底卡受保护；
             * s21 的 4 个浅色各由同尺寸卡片使用（面积比 1×）→ 照常归一。
             * 这比「按是否 ≥50% 画布」判骨架色更准：后者会把「满版浅底卡片」也误赦。 */
            const bigOf = new Map();
            for (const n of ir.nodes) {
              const c0 = normColor(n.fill);
              if (!isPaintColor(c0)) continue;
              bigOf.set(c0, Math.max(bigOf.get(c0) || 0, R.area(n.geomBox)));
            }
            for (const n of ir.nodes) {
              const c = normColor(n.fill);
              if (!isPaintColor(c)) continue;              /* 渐变/无填充/命名色跳过 */
              const grp = groups.find(x => x.members.indexOf(c) >= 0);
              if (!grp || grp.rep === c) continue;         /* 已是族代表 → 无需归一 */
              if (colorDist(c, grp.rep) > tol) continue;   /* 双保险 */
              if ((bigOf.get(grp.rep) || 0) >= R.area(n.geomBox) * 8) continue;  /* 不许溶进骨架色 */
              if (!fillSwapSafe(n, c, grp.rep, cArea)) continue;
              const op = mk('attr', n.shapeElem, g.key, g.type,
                `填充 ${c} → ${grp.rep}（同色族归一，色距 ${Math.round(colorDist(c, grp.rep))}，族内 ${grp.members.length} 色）`,
                null, () => setA(n.shapeElem, 'fill', grp.rep), `填充 ${n.describe}`);
              claim(n.shapeElem, op, 'fill:' + n.id);
            }
          }
          break;
        }
        case 'canvas_margin': {
          if (g.key !== 'rebalance_canvas') break;
          const cb = an.raw.canvas.contentBox || ir.contentBox;
          if (!cb) break;
          const dx = r2((ir.canvas.w - cb.w) / 2 - cb.x), dy = r2((ir.canvas.h - cb.h) / 2 - cb.y);
          if (Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6) break;
          for (const n of ir.nodes) {
            const op = mk('translate', n.elem, g.key, g.type, `画布留白平衡平移 ${dx},${dy}`,
              { before: n.bbox, after: { x: n.bbox.x + dx, y: n.bbox.y + dy, w: n.bbox.w, h: n.bbox.h } },
              () => this.applyTranslate(n, dx, dy), `平移 ${n.describe}`);
            claim(n.elem, op, 'canvas');
          }
          for (const e of ir.edges) {
            const pts = e.pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
            const op = mk('path', e.elem, g.key, g.type, `画布留白平衡平移 ${dx},${dy}`,
              { before: R.fromPoints(e.pts), after: R.fromPoints(pts), path: pts },
              () => this.applyPath(e, pts, st), `平移 ${e.describe}`);
            claim(e.elem, op, 'canvas');
          }
          for (const t of ir.texts) {
            const op = mk('translate', t.elem, g.key, g.type, `画布留白平衡平移 ${dx},${dy}`,
              { before: t.bbox, after: { x: t.bbox.x + dx, y: t.bbox.y + dy, w: t.bbox.w, h: t.bbox.h } },
              () => this.applyTranslate(t, dx, dy), '平移 free text');
            claim(t.elem, op, 'canvas');
          }
          break;
        }
        case 'tiny_element': {
          if (g.key !== 'grow_to_min') break;
          for (const it of g.items) {
            const n = ir.nodes.find(x => x.id === it.targets[0]);
            if (!n) continue;
            /* ★F7 双保险：即使 issue 侧误报，几何侧也不放大容器/装饰件。
             * 放大一个无标签的装饰件或满版容器既无视觉收益，又必然造成碰撞。 */
            if (n.role && n.role !== 'data' && n.role !== 'label') {
              skipped.push({ skipped: `该元素是 ${n.role}，不参与尺寸归一`, strategy: g.key, issueType: g.type, target: n.describe });
              continue;
            }
            const scale = Math.sqrt(Math.max(1, (ir.medArea * 0.5) / Math.max(1, R.area(n.geomBox))));
            if (scale < 1.05) continue;
            const newW = r2(n.geomBox.w * scale), newH = r2(n.geomBox.h * scale);
            const nx = r2(R.cx(n.geomBox) - newW / 2), ny = r2(R.cy(n.geomBox) - newH / 2);
            const after = R.mk(nx, ny, newW, newH);
            const hit = this.wouldCollide(ir, n, after);
            const op = mk('resize', n.shapeElem, g.key, g.type,
              `放大 ${nf(scale, 2)}× → ${newW}×${newH}${hit ? '（与 ' + hit.describe + ' 冲突，将交由验证器裁定）' : ''}`,
              { before: n.geomBox, after },
              () => this.applyResize(n, nx, ny, newW, newH), `放大 ${n.describe}`);
            claim(n.elem, op, ik(it));
          }
          break;
        }
        default: break;
        }
        /* 产出检查：本次迭代既没有 op 也没有 skip → 该策略根本不适用，按顺位再试一格 */
        if (ops.length > opsBefore || skipped.length > skipBefore) break;
        const next = ranks.filter(k => tried.indexOf(k) < 0 && rej.indexOf(g.type + '|' + k) < 0)[0];
        if (!next) break;
        if (tried.length === 1) {
          dbg.push({ type: g.type, chosen: g.key, infeasible: true, fallbackTo: next,
                     phase: g.phase, items: g.items.length, src: g.src });
        }
        key = next;
      }
      dbg.push({
        type: g.type, key: g.key, phase: g.phase, items: g.items.length, src: g.src,
        ops: ops.length - opsBeforeAll, skipped: skipped.length - skipBeforeAll,
        retries: tried.length - 1
      });
    }
    return { ops, skipped, dbg, phase: phaseName, style: st, byType };
  },

  /* ==================== 单策略构造器 ==================== */
  /* 取节点所属对齐簇 → 决定「哪条边不许动」。
   * 用于容器放大：若节点处在某一列左对齐簇里，居中生长会把列打散（实测 alignment 100→88）。 */
  anchorOf(an, n) {
    const out = { x: null, y: null, from: [], spread: { x: Infinity, y: Infinity } };
    const cl = (an && an.raw && an.raw.alignment && an.raw.alignment.clusters) || [];
    for (const c of cl) {
      if (!c.members || c.members.indexOf(n.id) < 0) continue;
      const isX = (c.family === 'left' || c.family === 'centerX' || c.family === 'right');
      /* ★ 取「最紧」的簇当锚，不能取「最后遍历到的」。
       * 一个节点常常同时属于多个簇：实测 real-01 的 `rect#svg_27`（页头横条）既在
       * `top` 簇（spread 1px，与中央大容器上边齐）又在某个 `centerY` 簇里；
       * 旧代码按数组顺序「后写覆盖」，centerY 胜出 → 走无锚的对称生长 →
       * 上边从 185 抬到 172、戳出父容器 13px（collision 100→92、alignment 72→58）。
       * spread 越小说明这条边越硬，越该保住。 */
      const s = (c.spread === undefined || c.spread === null || !isFinite(c.spread)) ? 0 : c.spread;
      const k = isX ? 'x' : 'y';
      if (s <= out.spread[k]) { out.spread[k] = s; out[k] = c.family; }
      out.from.push(c.family);
    }
    return out;
  },

  /* 找「同族并肩卡片」：同形状、等宽、等高、同顶边、等距的一排兄弟。
   * ★ 为什么必须成族处理（用户反馈 #1「背景图形宽高与文字适配」的关键一环）：
   *   一排等宽卡片里只有个别几张的文案偏长，各自按自己的缺口放大 →
   *   结果宽度 320 / 320 / 336.5 / 327.45 … 参差不齐，**行对齐当场崩掉**。
   *   实测 real-05：6 个 resize_container op 全部应用成功，却因
   *   「Δ0 + 对齐劣化 -8（90→82）」被 op 级门整批回滚 ——
   *   用户看到的依旧是「文字照样露在背景外面」，一次都没修上。
   *   成族后按族内**最大需要**取统一宽高，各成员算出的 W/H 必然相同
   *   （关系对称、缺口集合一致），于是宽度依旧整齐、对齐不再劣化。
   * 门槛刻意收紧（等宽等高 ±2px、等距 ±3px）：只为「本来就是一套卡片」的行触发，
   * 不去碰那些尺寸本就各异、可能是有意为之的布局。 */
  rowFamily(ir, n, st) {
    if (!n.labels || !n.labels.length) return null;
    const g = n.geomBox;
    /* ★ 族内成员必须**自己也有同一条 issue**（内边距不足），否则会出大问题：
     *   本层只给 `g.items`（issue 列表）里的节点产 op，把「不需要改的成员」算进
     *   统一宽度，会让 `wMax`（族内最紧成员的自由空间）被一个根本不会放大的
     *   邻居压死 —— 真正需要放大的那个只长出一点点，整批 Δ0 白做。
     *   实测 semantic-…-s32 正是这样从 8.3 掉到 1.5。
     * 判据与 04_analyzer.js#textFit 完全一致：任一侧 pad < minPad 才算 issue。 */
    const minPad = (typeof Analyzer !== 'undefined' && Analyzer.DEF) ? Analyzer.DEF.minPad : 6;
    const hasIssue = o => {
      if (!o.pad) return false;
      return Math.min(o.pad.l, o.pad.r, o.pad.t, o.pad.b) < minPad - 1e-9;
    };
    const out = [];
    for (const o of ir.nodes) {
      if (o === n) continue;
      if (!o.labels || !o.labels.length) continue;
      if (!hasIssue(o)) continue;
      if (String(o.shape) !== String(n.shape)) continue;
      const og = o.geomBox;
      if (Math.abs(og.w - g.w) > 2 || Math.abs(og.h - g.h) > 2) continue;
      if (Math.abs(og.y - g.y) > 3) continue;
      out.push(o);
    }
    if (!out.length) return null;
    out.push(n);
    /* ★ 刻意**不**要求「严格等距」。等宽等高 + 同顶边已经足以判定「这是一排卡片」，
     *   而「等距」会把真实版面里常见的不等距排布挡在族外 ——
     *   实测 real-02：4 张 185×125 同顶卡片，间距 230/460/690（设计师把两张靠在一起、
     *   另外两张拉开），被等距守卫拒绝 → 又变回各自放大 → 它们**共同的下边界**被破坏，
     *   resize 批因「对齐劣化 -10」整批回滚，文字越界一点没修上。
     *   等距在本项目里是 spacing 维度的考核项，不是「同族」的必要条件。 */
    out.sort((a, b) => a.geomBox.x - b.geomBox.x);
    return out;
  },

  /* 对齐误差的**只读**重算：把族内成员按候选位移假想搬一下，再交给 analyzer 自己算。
   * ★ 为什么不自己写一套聚类：analyzer 的 alignment() 有 4 处非显然细节
   *   （6 个对齐家族、`spread > alignMin && <= alignTol` 才算缺陷、
   *    按对角线自适应的 alignTol、以及「链式比较 cur[last] 而非与簇首比较」），
   *   自己复刻一遍必然与它漂移，就会出现「本层以为保住了、analyzer 却判劣化」。
   *   这里直接把改过 bbox 的浅拷贝节点表喂回 Analyzer.alignment ——
   *   口径 100% 同源，且**不碰 DOM**（只改 JS 对象）。
   * 代价：6 个家族 × 节点数 的量级，纯算术，可忽略。 */
  alignErrWith(ir, moved) {
    const W = ir.canvas.w, H = ir.canvas.h, diag = Math.hypot(W, H) || 1000;
    const o = { alignMin: (typeof Analyzer !== 'undefined' && Analyzer.DEF) ? Analyzer.DEF.alignMin : 0.5,
                alignTol: Math.max(4, Math.min(14, diag * 0.014)) };
    const nodes = ir.nodes.map(n => {
      const d = n.bbox ? moved.get(n.id) : null;
      if (!d) return n;
      return Object.assign({}, n, {
        bbox: { x: n.bbox.x + d.dx, y: n.bbox.y + d.dy, w: n.bbox.w + d.dw, h: n.bbox.h + d.dh }
      });
    });
    const a = Analyzer.alignment({ nodes, canvas: ir.canvas }, o);
    return a.error;
  },

  /* 容器放大。三条必须守住的几何事实：
   * ① 需求尺寸按「标签并集盒」算，不能按 n.textW（= 最宽的那**一个**标签）；
   * ② 生长方向由**四边缺口**决定（哪边不够就往哪边长），不是无条件居中；
   * ③ 生长量被自由空间封顶 —— 无节制放大等于把容器扩进邻居，制造新的碰撞
   *    （实测 growth 后 collision 98→80，整轮正收益被守卫丢弃）；
   * ④ 等距同族的兄弟必须**同宽同高**一起放（见 rowFamily），否则对齐劣化把整批拖走。
   * 若两个轴都无处可长，返回 null，把问题让给 wrap_text / reduce_font（修复阶梯）。 */
  opResize(ir, an, n, st, key, issue) {
    /* ★ 为什么必须「按边算缺口」而不能只看总尺寸：
     *   real-01 的 `rect#svg_30`：容器 555..805、标签并集 591..822.7 ——
     *   左边富余 36px、右边却缺 17.7px。按总尺寸算会得出
     *   `needW = 231.7+40 = 271.7 > 250` → 居中生长 21.7px，
     *   右边界只到 811.9，文字仍然露在外面（用户反馈「文字超出背景图形」原样保留）。
     *   按边算则 dl=0、dr=21.7 → 左边不动、只向右长 → 文字真正被包住，
     *   而且左边界不变 = 行列的左边对齐关系自动保住（不需要额外的对齐簇锚）。
     * 缺口同时天然覆盖了「垂直方向」：页头横条的标签下缘低于容器 9px → 只向下长，
     * 上边不动，「与中央大容器上边齐」的关系不破。 */
    const lu = (n.labels && n.labels.length) ? R.union(n.labels.map(l => l.bbox)) : null;
    if (!lu) return null;
    const g = n.geomBox;
    const fs = this.freeSpace(ir, n, 8);
    const d0 = {
      l: Math.max(0, g.x + st.pad - lu.x),
      r: Math.max(0, R.right(lu) + st.pad - R.right(g)),
      t: Math.max(0, g.y + st.pad - lu.y),
      b: Math.max(0, R.bottom(lu) + st.pad - R.bottom(g))
    };

    /* ---------- 同族统一放大（④）---------- */
    const fam = this.rowFamily(ir, n, st);
    if (fam && fam.length > 1) {
      const info = fam.map(m => {
        const mg = m.geomBox;
        const mlu = R.union(m.labels.map(l => l.bbox));
        const mfs = this.freeSpace(ir, m, 8);
        return {
          m, mg, mfs,
          dl: Math.max(0, mg.x + st.pad - mlu.x),
          dr: Math.max(0, R.right(mlu) + st.pad - R.right(mg)),
          dt: Math.max(0, mg.y + st.pad - mlu.y),
          db: Math.max(0, R.bottom(mlu) + st.pad - R.bottom(mg))
        };
      });
      /* ---------- 生长方向：按 analyzer 自己的口径挑「对齐损失最小」的那个 ----------
       * ★ 实测 real-05：5 张卡片只向右加宽 16.5px 后，textFit 由 94 升到 96（文字越界
       *   确实修好了），但 alignment 由 90 掉到 82 —— 因为 `rect#svg_16` 原本与
       *   svg_2 / svg_6 / svg_25 / svg_53 的**水平中心完全对齐（spread = 0）**，
       *   只往右长把它的中心推了 8.25px，等于亲手弄歪了一条本来齐整的中心线，
       *   整个 resize 批因此被 op 级门判死，用户看到的还是「文字露在背景外」。
       * ★ 不要试图用「优先级表」猜方向：实测过三版（只向右 / 参与 centerX 就对称 /
       *   先查 clusters），全部在某个样例上翻车 —— 根因是 analyzer 只把
       *   `spread > alignMin` 的组收进 clusters，**完全对齐的组反而查不到**，
       *   而它恰恰最该保住。
       * 正确做法：把各候选几何**假想位移**后交给 analyzer 自己算对齐误差，取最小者
       *   （见 alignErrWith，不碰 DOM）。候选方向：
       *     right/left/sym（对称，中心不动）/bottom/top/sym —— 每个方向的
       *   「需要宽度」按其能补的缺口算：只向右长只能补 dr，对称长能同时补 dl 与 dr。 */
      const mkCand = (axis) => {
        const isX = axis === 'x';
        const out = [];
        const modes = isX ? ['right', 'sym', 'left'] : ['bottom', 'sym', 'top'];
        for (const m of modes) {
          const need = Math.max(...info.map(x => {
            const w0 = isX ? x.mg.w : x.mg.h;
            const d1 = isX ? x.dr : x.db;      /* 正向缺口（右/下） */
            const d2 = isX ? x.dl : x.dt;      /* 反向缺口（左/上） */
            if (m === 'right' || m === 'bottom') return w0 + d1;
            if (m === 'left' || m === 'top') return w0 + d2;
            return w0 + 2 * Math.max(d1, d2);  /* sym */
          }));
          const cap = Math.min(...info.map(x => {
            const w0 = isX ? x.mg.w : x.mg.h;
            const fs1 = isX ? x.mfs.r : x.mfs.b;
            const fs2 = isX ? x.mfs.l : x.mfs.t;
            if (m === 'right' || m === 'bottom') return w0 + fs1;
            if (m === 'left' || m === 'top') return w0 + fs2;
            return w0 + fs1 + fs2;
          }));
          const S = r2(Math.min(need, cap));
          /* 可行性：向左/上/对称生长需要那一侧的自由空间够 */
          const feas = info.every(x => {
            const d = Math.max(0, S - (isX ? x.mg.w : x.mg.h));
            const fs2 = isX ? x.mfs.l : x.mfs.t;
            if (m === 'right' || m === 'bottom') return true;
            if (m === 'left' || m === 'top') return fs2 >= d - 0.01;
            return fs2 >= d / 2 - 0.01;
          });
          if (feas) out.push({ mode: m, S });
        }
        return out;
      };
      const cx = mkCand('x'), cy = mkCand('y');
      if (cx.length && cy.length) {
        let best = null;
        for (const xo of cx) for (const yo of cy) {
          const gx = r2(xo.S - g.w), gy = r2(yo.S - g.h);
          if (gx < 0.6 && gy < 0.6) continue;
          const moved = new Map();
          for (const x of info) {
            const dw = r2(xo.S - x.mg.w), dh = r2(yo.S - x.mg.h);
            const dx = xo.mode === 'left' ? -dw : (xo.mode === 'sym' ? r2(-dw / 2) : 0);
            const dy = yo.mode === 'top' ? -dh : (yo.mode === 'sym' ? r2(-dh / 2) : 0);
            moved.set(x.m.id, { dx, dy, dw, dh });
          }
          const err = this.alignErrWith(ir, moved);
          /* 先最小化对齐误差（乘 1000 让它绝对主导），同误差时取生长更多者 */
          const key = err * 1000 - (gx + gy);
          if (!best || key < best.key) best = { key, err, xo, yo, gx, gy };
        }
        if (!best) return null;
        const W = best.xo.S, H = best.yo.S;
        const nx = best.xo.mode === 'left' ? r2(g.x - best.gx)
          : (best.xo.mode === 'sym' ? r2(g.x - best.gx / 2) : g.x);
        const ny = best.yo.mode === 'top' ? r2(g.y - best.gy)
          : (best.yo.mode === 'sym' ? r2(g.y - best.gy / 2) : g.y);
        const wNeed = Math.max(...info.map(x => x.mg.w + x.dr));
        const hNeed = Math.max(...info.map(x => x.mg.h + x.db));
        const capped = (wNeed > W + 0.6) || (hNeed > H + 0.6);
        const why = `同族 ${info.length} 张等宽卡片统一放大 → ${W}×${H}` +
          `（X ${best.xo.mode} 长 ${best.gx}、Y ${best.yo.mode} 长 ${best.gy}；` +
          `候选方向按 analyzer 口径对齐误差择优，选中方案对齐误差 ${r2(best.err)}）` +
          (capped ? '（受最紧成员的自由空间封顶，残余交降字号/换行）' : '');
        return {
          kind: 'resize', target: n.shapeElem, strategy: key, issueType: issue.type, why,
          preview: { before: n.geomBox, after: R.mk(nx, ny, W, H) },
          apply: () => this.applyResize(n, nx, ny, W, H),
          label: `同族放大容器 ${n.describe}`
        };
      }
    }

    /* ---------- 单件逐边放大（②③）---------- */
    let dl = d0.l, dr = d0.r, dt = d0.t, db = d0.b;
    if (dl < 0.6 && dr < 0.6 && dt < 0.6 && db < 0.6) return null;
    const wantL = dl, wantR = dr, wantT = dt, wantB = db;
    dl = Math.min(dl, fs.l); dr = Math.min(dr, fs.r);
    dt = Math.min(dt, fs.t); db = Math.min(db, fs.b);
    const growX = r2(dl + dr), growY = r2(dt + db);
    if (growX < 0.6 && growY < 0.6) return null;
    const cappedX = (wantL + wantR) > growX + 0.6, cappedY = (wantT + wantB) > growY + 0.6;
    const W = r2(g.w + growX), H = r2(g.h + growY);
    const nx = r2(g.x - dl), ny = r2(g.y - dt);

    const fitW = !cappedX, fitH = !cappedY;
    const why = `标签并集 ${r2(lu.w)}×${r2(lu.h)} + padding ${st.pad} → 容器 ${W}×${H}` +
      `，缺口 左${r2(wantL)}/右${r2(wantR)}/上${r2(wantT)}/下${r2(wantB)}→实长 左${r2(dl)}/右${r2(dr)}/上${r2(dt)}/下${r2(db)}` +
      ((cappedX || cappedY) ? '（受自由空间封顶，仍不足以容纳文本 → 下轮交 wrap_text / reduce_font）' : '');
    void fitW; void fitH;
    return {
      kind: 'resize', target: n.shapeElem, strategy: key, issueType: issue.type, why,
      preview: { before: n.geomBox, after: R.mk(nx, ny, W, H) },
      apply: () => this.applyResize(n, nx, ny, W, H),
      label: `放大容器 ${n.describe}`
    };
  },

  /* 把标签的**视觉中心**移到其背景容器的中心。
   * ★ 两处护栏都来自实测缺陷（用户反馈 #1/#2）：
   *   ① 移完必须**仍落在容器内部** —— 旧实现把 world 的 `cy` 直接写进本地的 y 属性，
   *      且同时切 dominant-baseline，两处口径打架，实测把 `01 主数据统一` 这类标签
   *      推到 y=448（容器只到 434.5）→「文字超出背景图形」。
   *   ② 不得与同一容器内的**其它标签**重叠 —— 多标签卡片的两个标签各自被吸到容器中心后
   *      会重合（实测 baseline 448 / 443.67 只差 4px）→「文字被遮挡」。
   *   ③ ★F3：不得落进**其它节点**的容器范围、也不得压到自由文本。护栏②只覆盖
   *      「同节点兄弟标签」，范围小于缺陷范围：把文字吸到容器中心时，它可能越出
   *      与邻居的视觉边界（对 textFit / occlusion 两个口径而言就是新缺陷）。
   *      这一层只做**否决**，不参与位移择优，因此不会改变既有成功案例的位移量。
   * 任一护栏不满足就返回 null（宁可不动）。坐标系换算：`geomBox`/`bbox` 是 world，
   * 写回的 x/y 是元素**本地**属性，需按 CTM 的 x/y 缩放折算。 */
  anchorDelta(ir, n, l) {
    const sx = Math.abs((n.ctm && n.ctm.a) || 1) || 1;
    const sy = Math.abs((n.ctm && n.ctm.d) || 1) || 1;
    const cx = R.cx(n.geomBox), cy = R.cy(n.geomBox);
    const dwx = r2(cx - R.cx(l.bbox)), dwy = r2(cy - R.cy(l.bbox));
    if (Math.abs(dwx) < 0.6 && Math.abs(dwy) < 0.6) return null;
    const dx = r2(dwx / sx), dy = r2(dwy / sy);
    const after = { x: l.bbox.x + dx * sx, y: l.bbox.y + dy * sy, w: l.bbox.w, h: l.bbox.h };
    const g = n.geomBox, tol = 1.0;
    if (after.x < g.x - tol || after.y < g.y - tol ||
        R.right(after) > R.right(g) + tol || R.bottom(after) > R.bottom(g) + tol) return null;
    for (const o of n.labels) {
      if (o === l || !o.bbox) continue;
      const inter = R.intersect(after, o.bbox);
      if (inter && inter.w > 1 && inter.h > 1) return null;
    }
    /* ★F3 护栏③：跨节点。只查「落进别人容器」与「压住自由文本」两件事 ——
     * 二者都是明确缺陷；不查与其它节点**标签**的重叠，因为标签在 IR 里不互相排斥，
     * 那样会把大量合法排版（密集标签图）一刀否决。
     * 复用 wouldCollide 而不是手写 R.intersect：它的 coverRatio ≥ 0.95 豁免正好放过
     * 「标签完整落在父容器 / 满版底板内」这一合法情形（coverRatio 按较小面积归一，
     * 故 label 完全在底板内时比值 = 1）；手写版本会让所有带背景底板的图一条
     * move_text 都产不出来。口径与 Analyzer.collision 同源（见 wouldCollide 注释）。 */
    if (ir && ir.nodes && this.wouldCollide(ir, n, after, [n])) return null;
    /* ★F3 护栏④（依据 tests/diag_batch.cjs 的实测归因追加）：**不得把标签搬到不透明形状之下**。
     * 上面 ③ 复用 wouldCollide 时继承了它 coverRatio ≥ 0.95 的豁免。那个豁免本意是放过
     * 「标签完整待在自己父容器 / 满版底板内」这一合法嵌套 —— 但它**同样**放过了
     * 「标签完整落进另一个不透明、且绘制更晚的容器底下」，而后者恰是 Analyzer.occlusion
     * 判为缺陷、op 级门必然扣分的形态。于是出现「几何自认为修好了、门禁测出劣化」的错配。
     * 实测代价：move_text 批次里 opFixAnchor 把 H1 标题整体平移 (697.5, 449.5)px 到画布中心，
     * 落在 n23/n25（文档序更靠后、不透明）之下 → occlusion 由 0 变 2 →
     * occlusion.density = 0.5 正好等于 collSat → metrics.collision 从 96 塌到 0
     * → 整批 10 个 op 被全数否决（这就是「collision 96→0」的直接成因）。
     * 判据与 Analyzer.occlusion **同源**：不透明、非属主、非背景、文档序在文字之后、
     * 两维交叠 ≥6px（排除发丝级接触）。
     * 只否决「**新引入**」的遮挡：若标签当前位置本就被同一形状压着，搬过去仍被压
     * 不构成新缺陷，不能因此否决 —— 否则所有位于遮挡下的标签都永远修不动。 */
    if (ir && ir.nodes && l.elem) {
      const FOLLOWING = 4;
      for (const m of ir.nodes) {
        if (m === n || m.isBg) continue;                 /* 与 Analyzer.occlusion 的排除项一致 */
        if (!normColor(m.fill)) continue;                /* 无填充 / 透明 / 悬空 paint 引用 → 不遮挡 */
        const ia = R.intersect(after, m.geomBox);
        if (!ia || ia.w < 6 || ia.h < 6) continue;
        const ib = R.intersect(l.bbox, m.geomBox);
        if (ib && ib.w >= 6 && ib.h >= 6) continue;      /* 本来就被压 → 不算新引入 */
        let later = false;
        try { later = (l.elem.compareDocumentPosition(m.shapeElem || m.elem) & FOLLOWING) !== 0; } catch (x) {}
        if (later) return null;
      }
    }
    if (ir && ir.freeTexts) {
      for (const t of ir.freeTexts) {
        if (!t || !t.bbox || t.elem === l.elem) continue;
        const inter = R.intersect(after, t.bbox);
        if (inter && inter.w > 1 && inter.h > 1) return null;
      }
    }
    return { dx, dy, dwx: dwx, dwy: dwy, after };
  },

  opReflowBody(ir, n, st, key, issue) {
    const p = this.bodyReflow(ir, n, st);
    if (!p) return null;
    return {
      kind: 'translate', target: p.body[0].elem, strategy: key, issueType: issue.type,
      why: p.why,
      preview: { before: p.before, after: p.after },
      /* 只平移正文那几行文本；容器与图标一概不动 */
      apply: () => { for (const l of p.body) this.applyTranslate({ elem: l.elem }, p.dx, p.dy); },
      label: `正文左归位 ${n.describe}`
    };
  },

  opFixAnchor(ir, n, l, key, issue) {
    const d = this.anchorDelta(ir, n, l);
    if (!d) return null;
    const cur = { x: numA(l.elem, 'x', 0), y: numA(l.elem, 'y', 0) };
    return {
      kind: 'textanchor', target: l.elem, strategy: key, issueType: issue.type,
      why: `锚点 ${l.anchor} → middle；中心偏差 (${d.dwx}, ${d.dwy})px`,
      preview: { before: l.bbox, after: d.after },
      apply: () => {
        setA(l.elem, 'text-anchor', 'middle');
        setA(l.elem, 'x', r2(cur.x + d.dx));
        /* 只平移、不切 dominant-baseline：切了会把刚才算好的偏移再叠一次 */
        if (Math.abs(d.dy) >= 0.6) setA(l.elem, 'y', r2(cur.y + d.dy));
      },
      label: `锚点修正 ${l.text.slice(0, 12)}`
    };
  },

  opWrap(ir, an, n, st, key, issue) {
    const availW = Math.max(20, n.geomBox.w - 2 * st.pad);
    let linesTotal = 0;
    const plan = [];
    for (const l of n.labels) {
      const css = Runtime.fontString(l.elem).css;
      const lines = wrapText(l.text, availW, css);
      if (lines.length < 2) continue;
      plan.push({ l, lines, css });
      linesTotal += lines.length;
    }
    if (!plan.length) return null;
    const main = plan[0];
    const lineH = r2(Math.max(...main.l.lines ? [main.l.fontSize] : [12]) * 1.25 + st.lineGap);
    const needH = r2(plan.reduce((a, p) => a + p.lines.length * lineH, 0) + 2 * st.pad);
    const cx = R.cx(n.geomBox);
    const nx = r2(cx - n.geomBox.w / 2);
    /* ★ 换行会让容器变高，生长方向必须跟随该节点**实际所属的对齐族**：
     * 属于 top 族 → 锚定上边（只牺牲下边）；属于 bottom 族 → 锚定下边；
     * 属于 centerY 族 → 保持中心生长（中心本来就是它的对齐基准）；
     * 不属于任何 y 族 → 中心生长无副作用。一律锚顶会让 centerY 族的两侧同时偏离
     * （实测 raw-grid-text_overflow 100 → 99.6 的退化就是这么来的）。 */
    const ancY = this.anchorOf(an, n).y;
    const ny = ancY === 'bottom' ? r2(R.bottom(n.geomBox) - needH)
             : ancY === 'top' ? n.geomBox.y
             : r2(R.cy(n.geomBox) - needH / 2);
    return {
      kind: 'wrap', target: main.l.elem, strategy: key, issueType: issue.type,
      why: `可用宽 ${r2(availW)}px → 拆 ${plan.map(p => p.lines.length).join('/')} 行；容器高 ${r2(n.geomBox.h)} → ${needH}`,
      preview: { before: n.geomBox, after: R.mk(nx, ny, n.geomBox.w, needH) },
      apply: () => {
        const startY = r2(ny + st.pad + main.l.fontSize);
        main.l.elem.textContent = '';
        main.lines.forEach((ln, i) => {
          const ts = mkEl('tspan');
          setA(ts, 'x', r2(cx));
          setA(ts, 'y', r2(startY + i * lineH));
          ts.textContent = ln;
          main.l.elem.appendChild(ts);
        });
        setA(main.l.elem, 'text-anchor', 'middle');
        setA(main.l.elem, 'dominant-baseline', 'central');
        this.applyResize(n, nx, ny, n.geomBox.w, needH);
      },
      label: `换行 ${main.l.text.slice(0, 10)}`
    };
  },

  /* 缩字号（修复阶梯最后手段，文档 §16 第 5 步）。
   * ★ 只能缩到**已存在的样式档位**（st.tier）：
   *   若按 need 算出 12.5px 就照做，会凭空造出第三档字号，style_inconsistency 立刻爆掉
   *   （实测 style 维度 100 → 58），等于用「修 A 坏 B」换一次 textFit。
   *   档位不够低时直接放弃本条（返回 null），交给 wrap_text 或保持原样。 */
  opReduceFont(ir, n, st, key, issue) {
    const availW = Math.max(10, n.geomBox.w - 2 * st.pad);
    const availH = Math.max(8, n.geomBox.h - 2 * st.pad);
    /* 档位取**文档内已有字号**（见 fontTiers），不是预设的绝对像素 ——
     * 预设档位在 1920×1080 的海报上是「另一个量纲」，会把 24px 直接砍到 14px。
     * 另加 0.60× 下限：单次缩字超过 40% 一律放弃（改走 wrap_text / resize_container）。 */
    const tiers = this.fontTiers(ir, st);                     /* 由大到小 */
    const changes = [];
    for (const l of n.labels) {
      const need = Math.max(l.bbox.w / availW, l.bbox.h / availH);
      if (!(need > 1)) continue;
      const target = l.fontSize / need;
      /* 取「不大于目标的最大的已存在档位」；比最小档位还小则不缩 */
      const want = tiers.find(t => t <= target + 0.01);
      if (want === undefined) continue;
      if (want < l.fontSize * 0.60) continue;                 /* 腰斩式缩字：放弃 */
      if (Math.abs(want - l.fontSize) > 0.4) changes.push({ l, want });
    }
    if (!changes.length) return null;
    return {
      kind: 'font', target: changes[0].l.elem, strategy: key, issueType: issue.type,
      why: `字号 ${changes.map(c => `${nf(c.l.fontSize, 1)}→${c.want}`).join(', ')}；吸附到已有档位 [${tiers.join('/')}]（修复阶梯最后手段）`,
      preview: null,
      apply: () => { for (const c of changes) setA(c.l.elem, 'font-size', c.want); },
      label: `缩字 ${n.describe}`
    };
  },

  /* 重叠分离：选径向位移最小、且落点无新碰撞的一侧 */
  /* 推开重叠：4 个方向 × 2 个 mover × 3 档位移倍率。
   * 为什么要多档：恰好「贴到 10px 间隙」的那一档常常正好撞上第三个节点，
   * 而再往外挪一点就是干净位置。只试最小位移会导致「明知有碰撞也照做」，
   * 表现为 collision 维度被自己改坏（实测 96→90 后整轮被守卫回滚）。 */
  separation(ir, p) {
    const a = p.aRef, b = p.bRef;
    /* ★ 本体规则「位移上限」的几何端（声明在 05b_ontology.js RULES.displace_cap）
     * 实测病理：`circle#svg_75` 与装饰环 `circle#svg_27` 只重叠 **7.8px**（在 y 轴），
     * 正确的 y 向小位移因会撞第三个节点而被 `wouldCollide` 过滤掉，于是候选里只剩
     * 「沿 x 把 a 的右边缘搬到 b 的左边缘」= `1482.8 − 1278 + 10` = **214.8px** —— 27 倍过度修正。
     * 规则内容：位移必须与**实际重叠量**同量级，d_max = max(K × 重叠量, 画布短边 × frac)；
     * 全部候选都超限时返回 null（跳过，而不是远距离搬运）。
     *
     * ★★ 默认**关闭**（opt-in：ir.opts.ontDisplaceCap === true）。原因见 palantir_value.cjs：
     *   本函数是**共享**设施（两处调用点：overlap 的推开、以及 reroute 家族的取点），
     *   在目标文件上开启本上限代价 −4.10 分，且结构不变量反而变差
     *   （containPx 128→253.71、guideSpreadMax 183→211.83、attachErrMax 36→42.01）——
     *   因为它挡掉的正是**在被接受、并在修复几何**的那些动作。
     *   规则本身有据（214.8px 是真实的过度修正），但要生效必须先把调用点拆开、
     *   逐条定价后再开，不能默认全图收紧。 */
    const OC = (typeof Ontology !== 'undefined' && Ontology && Ontology.DEF) ? Ontology.DEF : {};
    const K = typeof OC.displaceK === 'number' ? OC.displaceK : 1.5;
    const FR = typeof OC.displaceFrac === 'number' ? OC.displaceFrac : 0.06;
    const capOff = !(ir && ir.opts && ir.opts.ontDisplaceCap === true);
    const cvW = (ir && ir.canvas && ir.canvas.w) || 1920;
    const cvH = (ir && ir.canvas && ir.canvas.h) || 1080;
    const dMax = capOff ? Infinity
      : Math.max(K * Math.abs(p.depth || 0), FR * Math.min(cvW, cvH));
    const base = (axis, dir) => {
      const v = axis === 'x'
        ? (dir > 0 ? R.right(a.geomBox) - b.geomBox.x + 10 : R.right(b.geomBox) - a.geomBox.x + 10)
        : (dir > 0 ? R.bottom(a.geomBox) - b.geomBox.y + 10 : R.bottom(b.geomBox) - a.geomBox.y + 10);
      return Math.max(12, v);
    };
    const cands = [];
    const MULS = [1, 1.6, 2.4];
    for (const axis of ['x', 'y']) {
      for (const dir of [1, -1]) {
        /* 把 a 沿 dir 推开（b 不动）；或把 b 沿 -dir 推开（a 不动） */
        for (const mover of [a, b]) {
          const s = mover === a ? dir : -dir;
          const need = base(axis, s);
          for (const mul of MULS) {
            const d = r2(need * mul);
            const dx = axis === 'x' ? s * d : 0, dy = axis === 'y' ? s * d : 0;
            const after = { x: mover.geomBox.x + dx, y: mover.geomBox.y + dy, w: mover.geomBox.w, h: mover.geomBox.h };
            /* 允许贴边（后续画布收尾会统一留白），但不允许移到画布外 */
            if (after.x < 0 || after.y < 0 || R.right(after) > ir.canvas.w || R.bottom(after) > ir.canvas.h) continue;
            const hit = this.wouldCollide(ir, mover, after, [mover === a ? b : a]);
            cands.push({ mover, other: mover === a ? b : a, axis, dir: s, dist: d, dx, dy, after, hit, mul });
          }
        }
      }
    }
    if (!cands.length) return null;
    /* ★ 先按位移上限过滤（本体规则），再挑无新碰撞者 */
    const pool = capOff ? cands : cands.filter(c => c.dist <= dMax + 0.01);
    if (!pool.length) return null;
    /* ★ 只在「无新碰撞」的候选里挑最小位移。
     * 全部候选都会撞上第三个节点时返回 null —— 几何引擎不主动制造新碰撞，
     * 把它交回决策层换策略（move_apart → grow_spacing → global_relayout）。
     * 曾经的「退而取碰撞最轻的一个」会稳定地把 collision 改坏（实测 96→90 后被守卫否决）。 */
    const good = pool.filter(c => !c.hit);
    if (!good.length) return null;
    good.sort((x, y) => x.dist - y.dist);
    return good[0];
  },

  /* 对齐吸附：按决策选择的族集合，把每个节点聚合到一个位移（x/y 各自取该方向的簇） */
  snapTargets(ir, an, key) {
    const want = key === 'snap_centers' ? ['centerX', 'centerY'] : key === 'snap_edges' ? ['left', 'right', 'top', 'bottom'] : null;
    const agg = new Map();
    for (const c of an.raw.alignment.clusters) {
      if (want && want.indexOf(c.family) < 0) continue;
      const isX = (c.family === 'left' || c.family === 'right' || c.family === 'centerX');
      for (const id of c.members) {
        const n = ir.nodes.find(x => x.id === id);
        if (!n) continue;
        const cur = famVal(n, c.family);
        const d = r2(c.target - cur);
        if (Math.abs(d) < 0.3) continue;
        const rec = agg.get(id) || { node: n, dx: 0, dy: 0, sevX: 0, sevY: 0, items: [] };
        if (isX) { if (Math.abs(d) > Math.abs(rec.dx)) rec.dx = d; rec.sevX = Math.max(rec.sevX, c.spread); }
        else { if (Math.abs(d) > Math.abs(rec.dy)) rec.dy = d; rec.sevY = Math.max(rec.sevY, c.spread); }
        rec.items.push({ family: c.family, cn: c.cn, spread: c.spread, target: c.target, d });
        agg.set(id, rec);
      }
    }
    const out = [];
    for (const rec of agg.values()) {
      /* ★ 只沿「更严重」的那个轴吸附。
       * 两轴同时动会把节点移出行/列：实测 misalignment 修好、spacing 却从 85 崩到 43.3，
       * 整轮正收益被守卫丢弃。吸附的语义是「小修正」，不是「换位置」。 */
      if (rec.dx && rec.dy) {
        if (rec.sevX >= rec.sevY) rec.dy = 0; else rec.dx = 0;
      }
      /* ★ 吸附不得制造新碰撞 */
      const bb = rec.node.bbox;
      const probe = { x: bb.x + rec.dx, y: bb.y + rec.dy, w: bb.w, h: bb.h };
      if (this.wouldCollide(ir, rec.node, probe)) continue;
      out.push(rec);
    }
    return out;
  },

  /* ==================== 正交避障重路由 ==================== */
  /* ★F8：两条折线之间的交叉段数（无向，按段对计数）。
   * 口径要点：这里只用于**前后对比**（原路径 vs 新路径），因此共享端点造成的
   * 冗余计数对两侧同权、会在比较中抵消。不要把它当成绝对交叉数对外报告。 */
  _crossCount(pts, others) {
    if (!pts || pts.length < 2) return 0;
    let n = 0;
    for (const o of others) {
      const q = o && o.pts;
      if (!q || q.length < 2) continue;
      for (let i = 1; i < pts.length; i++) {
        for (let j = 1; j < q.length; j++) {
          if (Seg.cross(pts[i - 1], pts[i], q[j - 1], q[j])) n++;
        }
      }
    }
    return n;
  },

  routeEdge(ir, e) {
    /* ★F8 新增 EDGE_PEN：其它连线所在格子的附加代价。
     * 取 6 的依据：空格代价 1、转向罚 2.2 —— 6 足以让 A* 宁可多绕几格也不压线，
     * 但仍是**软惩罚**，不会造成无解（硬阻塞会让连线密集的图大面积退化成 L 形）。 */
    const clear = 10, cell = 8, EDGE_PEN = 6;
    const src = e.source ? ir.nodes.find(n => n.id === e.source) : null;
    const dst = e.target ? ir.nodes.find(n => n.id === e.target) : null;
    const a = e.pts[0], b = e.pts[e.pts.length - 1];
    const portOf = (node, toward, vertical) => {
      if (!node) return null;
      const g = node.geomBox;
      if (vertical) return { x: r2(R.cx(g)), y: r2(toward.y > R.cy(g) ? R.bottom(g) : g.y) };
      return { x: r2(toward.x > R.cx(g) ? R.right(g) : g.x), y: r2(R.cy(g)) };
    };
    const vertical = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);
    const S = src ? portOf(src, b, vertical) : { x: r2(a.x), y: r2(a.y) };
    const T = dst ? portOf(dst, a, vertical) : { x: r2(b.x), y: r2(b.y) };

    const nx = Math.ceil(ir.canvas.w / cell), ny = Math.ceil(ir.canvas.h / cell);
    const idx = (i, j) => j * nx + i;
    const blocked = new Uint8Array(nx * ny);
    const skip = new Set([src, dst].filter(Boolean).map(n => n.id));
    let avoided = 0;
    for (const n of ir.nodes) {
      if (skip.has(n.id)) continue;
      const r = R.expand(n.geomBox, clear);
      const i0 = clamp(Math.floor(r.x / cell), 0, nx - 1), i1 = clamp(Math.ceil(R.right(r) / cell), 0, nx - 1);
      const j0 = clamp(Math.floor(r.y / cell), 0, ny - 1), j1 = clamp(Math.ceil(R.bottom(r) / cell), 0, ny - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) blocked[idx(i, j)] = 1;
      avoided++;
    }

    /* ★F8：把「其它边」也纳入代价。旧实现只把节点当障碍，于是 edge-over-edge
     * 交叉**永远修不掉**（Analyzer 一直在计 edgeRouting，几何层却看不见）。
     * 做法是**软惩罚**而非加入 blocked：连线之间本来就近，硬阻塞会让 A* 大面积无解。 */
    const edgeOcc = new Uint8Array(nx * ny);
    const others = (ir.edges || []).filter(x => x !== e && x && x.pts && x.pts.length >= 2);
    for (const e2 of others) {
      for (let i = 1; i < e2.pts.length; i++) {
        const p = e2.pts[i - 1], q = e2.pts[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / (cell * 0.5)));
        for (let s = 0; s <= steps; s++) {
          const x = p.x + (q.x - p.x) * (s / steps), y = p.y + (q.y - p.y) * (s / steps);
          edgeOcc[idx(clamp(Math.round(x / cell), 0, nx - 1), clamp(Math.round(y / cell), 0, ny - 1))] = 1;
        }
      }
    }

    /* 原路径基线：用于「绝不更差」判定（节点穿越数 + 边交叉数） */
    const origCross = this._crossCount(e.pts, others);
    let origNodeHits = 0;
    const evalPath = pts => {
      let nh = 0;
      for (const n of ir.nodes) { if (skip.has(n.id)) continue; nh += Seg.hitsRect(pts, n.geomBox, 1); }
      return { nh, nc: this._crossCount(pts, others) };
    };
    for (const n of ir.nodes) { if (skip.has(n.id)) continue; origNodeHits += Seg.hitsRect(e.pts, n.geomBox, 1); }

    const lCands = vertical
      ? [[{ x: S.x, y: S.y }, { x: S.x, y: T.y }, { x: T.x, y: T.y }],
         [{ x: S.x, y: S.y }, { x: T.x, y: S.y }, { x: T.x, y: T.y }]]
      : [[{ x: S.x, y: S.y }, { x: T.x, y: S.y }, { x: T.x, y: T.y }],
         [{ x: S.x, y: S.y }, { x: S.x, y: T.y }, { x: T.x, y: T.y }]];
    /* L 形兜底：保持原有的「零节点穿越」硬门，另加 F8 的「不增加边交叉」软门 */
    const tryL = () => {
      let best = null;
      for (const c of lCands) {
        const s = evalPath(c);
        const sc = s.nh * 1000 + s.nc;
        if (!best || sc < best.sc) best = { c, sc, s };
      }
      if (best && best.s.nh === 0 && best.s.nc <= origCross) {
        return { pts: Seg.simplifyOrtho(best.c), avoided, fallback: 'L',
                 nodeHits: 0, edgeCross: best.s.nc, origEdgeCross: origCross };
      }
      return null;
    };
    const toI = p => ({ i: clamp(Math.round(p.x / cell), 0, nx - 1), j: clamp(Math.round(p.y / cell), 0, ny - 1) });
    const s = toI(S), t = toI(T);
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const key = (i, j, d) => (j * nx + i) * 4 + d;
    const gScore = new Float64Array(nx * ny * 4).fill(Infinity);
    const prev = new Int32Array(nx * ny * 4).fill(-1);
    const heap = [];
    const push = (f, k) => { heap.push([f, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const h = (i, j) => Math.abs(i - t.i) + Math.abs(j - t.j);
    let found = -1;
    for (let d = 0; d < 4; d++) { const k = key(s.i, s.j, d); gScore[k] = 0; push(h(s.i, s.j), k); }
    const freeCell = (i, j) => {
      if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
      if (blocked[idx(i, j)] && !(i === s.i && j === s.j) && !(i === t.i && j === t.j)) return false;
      return true;
    };
    let guard = 0;
    while (heap.length && guard++ < 200000) {
      const [, k] = pop();
      const d = k % 4, cellIdx = (k - d) / 4;
      const i = cellIdx % nx, j = (cellIdx - i) / nx;
      if (i === t.i && j === t.j) { found = k; break; }
      const g0 = gScore[k];
      for (let nd = 0; nd < 4; nd++) {
        const ni = i + DIRS[nd][0], nj = j + DIRS[nd][1];
        if (!freeCell(ni, nj)) continue;
        const nk = key(ni, nj, nd);
        const cost = g0 + 1 + (nd === d ? 0 : 2.2) + (edgeOcc[idx(ni, nj)] ? EDGE_PEN : 0);
        if (cost < gScore[nk]) { gScore[nk] = cost; prev[nk] = k; push(cost + h(ni, nj), nk); }
      }
    }
    if (found < 0) {
      /* 退化为 L 形：两个方向都试，取「零节点穿越 + 不增加边交叉」者 */
      const l = tryL();
      if (l) return l;
      return { failed: true, avoided, reason: 'A* 与 L 形均未找到「零节点穿越且不增加边交叉」的路径',
               origNodeHits, origEdgeCross: origCross };
    }
    const cells = [];
    let k = found;
    while (k >= 0) { const d = k % 4, ci = (k - d) / 4; cells.push({ i: ci % nx, j: (ci - (ci % nx)) / nx }); k = prev[k]; }
    cells.reverse();
    let pts = cells.map(c => ({ x: r2(c.i * cell), y: r2(c.j * cell) }));
    pts[0] = S; pts[pts.length - 1] = T;
    pts = Seg.simplifyOrtho(pts, cell * 0.5);
    /* 校正：保证首尾段与端口垂直/水平对齐 */
    if (pts.length >= 2) {
      if (Math.abs(pts[0].x - S.x) > 0.6 || Math.abs(pts[0].y - S.y) > 0.6) pts.unshift(S);
      const last = pts[pts.length - 1];
      if (Math.abs(last.x - T.x) > 0.6 || Math.abs(last.y - T.y) > 0.6) pts.push(T);
      pts = Seg.simplifyOrtho(pts, 0.5);
    }
    /* ★F8 接受判据：绝不更差（节点穿越数不增加 且 边交叉数不增加）。
     * 旧实现**无条件**接受 A* 结果，因此「重路由」有可能反而增加交叉（Analyzer 会扣分，
     * 而几何层自认为修好了）。这里补上否决权；被否决时先退 L 形，再不行返回 failed
     * （不发 op）—— 保证「要么更好、要么不动」。 */
    const as = evalPath(pts);
    if (as.nh <= origNodeHits && as.nc <= origCross) {
      return { pts, avoided, fallback: 'astar', nodeHits: as.nh, edgeCross: as.nc, origEdgeCross: origCross };
    }
    const l2 = tryL();
    if (l2) return l2;
    return { failed: true, avoided,
             reason: 'A* 路径在「节点穿越 / 边交叉」上不优于原路径，且 L 形不可行',
             astarNodeHits: as.nh, astarEdgeCross: as.nc, origNodeHits, origEdgeCross: origCross };
  },

  /* ==================== DOM 应用原语 ==================== */
  applyTranslate(item, dx, dy) {
    if (!dx && !dy) return;
    const el = item.elem || item;
    const t = tagOf(el);
    const v = item.kind === 'node' || item.shapeElem ? item.shapeElem : el;
    const vt = tagOf(v);
    if (vt === 'rect') { setA(v, 'x', r2(numA(v, 'x', 0) + dx)); setA(v, 'y', r2(numA(v, 'y', 0) + dy)); }
    else if (vt === 'circle') { setA(v, 'cx', r2(numA(v, 'cx', 0) + dx)); setA(v, 'cy', r2(numA(v, 'cy', 0) + dy)); }
    else if (vt === 'ellipse') { setA(v, 'cx', r2(numA(v, 'cx', 0) + dx)); setA(v, 'cy', r2(numA(v, 'cy', 0) + dy)); }
    else if (vt === 'text') { setA(v, 'x', r2(numA(v, 'x', 0) + dx)); setA(v, 'y', r2(numA(v, 'y', 0) + dy)); }
    else if (vt === 'polygon' || vt === 'polyline') {
      const pts = getA(v, 'points', '').trim().split(/[\s,]+/).map(Number);
      const out = [];
      for (let i = 0; i + 1 < pts.length; i += 2) out.push(r2(pts[i] + dx) + ',' + r2(pts[i + 1] + dy));
      setA(v, 'points', out.join(' '));
    } else {
      const old = getA(v, 'transform', '');
      setA(v, 'transform', `translate(${r2(dx)},${r2(dy)})` + (old ? ' ' + old : ''));
    }
    /* 节点内的标签一并跟随 */
    if (item.labels && item.labels.length) for (const l of item.labels) this.applyTranslate(l.elem, dx, dy);
  },

  applyResize(node, x, y, w, h) {
    const g = node.shapeElem || node.elem;
    const t = tagOf(g);
    if (t === 'rect') {
      setA(g, 'x', x); setA(g, 'y', y); setA(g, 'width', w); setA(g, 'height', h);
      /* 标签跟随：**整体平移**到新容器的中心，不改标签之间的相对间距。
       * ★ 旧实现把多标签强行按固定 20px 行距重排（`cy − spread/2 + i*20`），
       *   30px 标题与 19px 副标题只隔 20px → 直接叠字（用户反馈 #2「文字被遮挡」）。
       *   改为：算出容器中心位移 (dcx, dcy)，每个标签各平移相同量 —— 内部版式原样保留。 */
      if (node.labels && node.labels.length && node.geomBox) {
        const dcx = r2((x + w / 2) - R.cx(node.geomBox));
        const dcy = r2((y + h / 2) - R.cy(node.geomBox));
        if (Math.abs(dcx) >= 0.3 || Math.abs(dcy) >= 0.3) {
          for (const l of node.labels) {
            const v = l.elem;
            setA(v, 'x', r2(numA(v, 'x', 0) + dcx));
            setA(v, 'y', r2(numA(v, 'y', 0) + dcy));
          }
        }
      }
    } else if (t === 'ellipse') {
      setA(g, 'rx', r2(w / 2)); setA(g, 'ry', r2(h / 2));
      setA(g, 'cx', r2(x + w / 2)); setA(g, 'cy', r2(y + h / 2));
    } else if (t === 'circle') {
      const r = r2(Math.min(w, h) / 2);
      setA(g, 'r', r); setA(g, 'cx', r2(x + w / 2)); setA(g, 'cy', r2(y + h / 2));
    } else {
      const old = getA(g, 'transform', '');
      setA(g, 'transform', `translate(${r2(x)},${r2(y)}) scale(${nf(w / Math.max(1, node.geomBox.w), 4)},${nf(h / Math.max(1, node.geomBox.h), 4)})` + (old ? ' ' + old : ''));
    }
  },

  applyPath(edge, pts) {
    const el = edge.elem;
    if (tagOf(el) === 'path') { setA(el, 'd', Seg.toPathD(pts)); return; }
    if (tagOf(el) === 'line') { setA(el, 'x1', pts[0].x); setA(el, 'y1', pts[0].y); setA(el, 'x2', pts[pts.length - 1].x); setA(el, 'y2', pts[pts.length - 1].y); return; }
    if (tagOf(el) === 'polyline' || tagOf(el) === 'polygon') { setA(el, 'points', pts.map(p => `${p.x},${p.y}`).join(' ')); return; }
  }
};

/* 文本换行：CJK 逐字、拉丁按词，用真实测量宽度切分 */
function wrapText(text, maxW, cssFont) {
  const s = String(text || '');
  if (!s) return [];
  const w = t => Runtime.measure(t, cssFont).w;
  if (w(s) <= maxW) return [s];
  const tokens = [];
  let buf = '';
  for (const ch of s) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
      if (buf) { tokens.push(buf); buf = ''; }
      tokens.push(ch);
    } else if (ch === ' ' || ch === '/' || ch === '·' || ch === ',') {
      buf += ch; tokens.push(buf); buf = '';
    } else buf += ch;
  }
  if (buf) tokens.push(buf);
  const lines = [];
  let cur = '';
  for (const tk of tokens) {
    const test = cur + tk;
    if (cur && w(test) > maxW) { lines.push(cur.trim()); cur = tk.trim() === '' ? '' : tk; }
    else cur = test;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.slice(0, 5);
}

function styleKey(rec) {
  if (!rec) return 'technical';
  if (typeof rec === 'string') return rec;
  return rec.choice || 'technical';
}

/* 六个对齐族的坐标取值（与 Analyzer.alignment 的族定义必须一致） */
function famVal(n, family) {
  switch (family) {
    case 'left': return n.bbox.x;
    case 'centerX': return R.cx(n.bbox);
    case 'right': return R.right(n.bbox);
    case 'top': return n.bbox.y;
    case 'centerY': return R.cy(n.bbox);
    case 'bottom': return R.bottom(n.bbox);
    default: return 0;
  }
}

/* ==================== 颜色工具（填充归一的护栏用） ====================
 * 背景：修复前 `normalize_style` 直接取 `an.raw.style.fills[0].color`（=全局最高频填充色）
 * 当 main，然后**无任何颜色距离阈值**地把其余每个节点的 fill 刷成它。
 * 实测 real-05：fills[0] 恰是出现 2 次的品牌蓝 #1769e0，于是整幅 15 种填充
 * （含 #f7fbff 画布底、#fff 白色容器、5 种浅色卡）全被刷成饱和蓝 → 「大面积蓝色异常」。
 * 正确语义应当是：**只归一族内的近重复色**（同一角色用了几个肉眼难分的色），
 * 而不是把整幅图的配色压成一个色。 */

/* '#rrggbb' → [r,g,b]；非 hex（含 url(#grad)、none、命名色）返回 null */
function hexTriple(c) {
  const s = String(c || '').trim().toLowerCase();
  if (s.length !== 7 || s[0] !== '#') return null;
  if (!/^#[0-9a-f]{6}$/.test(s)) return null;
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}

/* 是否「可直接比较的实色」：排除渐变/图案引用、none、命名色与 CSS 变量 */
function isPaintColor(c) {
  return !!hexTriple(c);
}

/* 8bit RGB 欧氏色距；任一侧不可比较则返回 Infinity（=永不归一） */
function colorDist(a, b) {
  const x = hexTriple(a), y = hexTriple(b);
  if (!x || !y) return Infinity;
  const dr = x[0] - y[0], dg = x[1] - y[1], db = x[2] - y[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/* 感知亮度（0..1，Rec.601）—— 用来禁止「浅底 → 饱和深色」这类跨明度归一 */
function lumaOf(c) {
  const t = hexTriple(c);
  if (!t) return NaN;
  return (0.299 * t[0] + 0.587 * t[1] + 0.114 * t[2]) / 255;
}

/* 对比度（WCAG 简化版）—— 保证归一后文字仍可读 */
function contrastRatio(c1, c2) {
  const t1 = hexTriple(c1), t2 = hexTriple(c2);
  if (!t1 || !t2) return NaN;
  const L = t => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(t[0]) + 0.7152 * f(t[1]) + 0.0722 * f(t[2]);
  };
  const a = L(t1), b = L(t2);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* 把一组「填充色 + 出现次数」聚成色族。
 * 语义：**代表锚定聚簇**（只与族代表比距离，不在成员间传递），
 * 这样族内直径 ≤ tol，不会出现「浅蓝→中蓝→深蓝→品牌蓝」的链式漂移。 */
function clusterFills(fills, tol) {
  const groups = [];
  for (const f of fills) {                        /* fills 已按出现次数降序 */
    const c = f && f.color;
    if (!isPaintColor(c)) continue;               /* 渐变/命名色不参与 */
    let g = groups.find(x => colorDist(x.rep, c) <= tol);
    if (!g) { g = { rep: c, members: [], n: 0, best: -1 }; groups.push(g); }
    g.members.push(c);
    g.n += (f.n || 0);
  }
  /* 族代表取「族内最高频色」—— 语义上等于「该角色的主流画法」 */
  for (const g of groups) {
    for (const m of g.members) {
      const rec = fills.find(f => f.color === m);
      const n = rec ? (rec.n || 0) : 0;
      if (n > g.best) { g.best = n; g.rep = m; }
    }
  }
  return groups;
}

/* 归一某节点填充是否安全：面积过大（背景板/容器）、跨明度、伤害文字对比度 → 不安全 */
function fillSwapSafe(n, from, to, canvasArea) {
  if (R.area(n.geomBox) > canvasArea * 0.08) return false;      /* 大件是版式骨架，不动 */
  const lf = lumaOf(from), lt = lumaOf(to);
  if (isFinite(lf) && isFinite(lt) && Math.abs(lf - lt) > 0.10) return false;
  for (const l of (n.labels || [])) {
    const tf = l.fill;
    if (!isPaintColor(tf)) continue;
    const c0 = contrastRatio(tf, from), c1 = contrastRatio(tf, to);
    if (isFinite(c0) && isFinite(c1) && c1 < Math.max(3.0, c0 * 0.7)) return false;
  }
  return true;
}
