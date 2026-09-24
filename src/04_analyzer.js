/* =============================================================================
 * SVG Beautifier · 04 几何诊断器 + 质量评分
 *
 * 设计文档 §14：SVGQualityScore =
 *   0.25·collision + 0.20·textFit + 0.15·alignment + 0.15·spacing
 * + 0.10·edgeRouting + 0.10·style + 0.05·canvasBalance        （每项 0~100）
 *
 * 设计文档 §21：「能用几何解决的问题，不交给 AI」——
 * 本层是纯确定性断言，全部以世界坐标矩形的四则运算实现，不依赖任何模型。
 * 所有 density 都是「缺陷密度」，统一用 score = 100·clamp(1 − d/dSat, 0, 1) 映射，
 * 保证单调、可解释、可回归比对。
 * ===========================================================================*/
'use strict';

const Analyzer = {
  DEF: {
    minPad: 6,          /* 标签到容器边框的期望最小内边距 px */
    alignTol: 8,        /* 认为「本应对齐」的坐标容差 px */
    alignMin: 0.5,      /* 小于此偏差视为已对齐 */
    rowTol: 12,         /* 行/列聚类的中心容差 px（相对画布自适应） */
    cvSat: 0.6,         /* 间距变异系数到多少分归零 */
    collSat: 0.5,       /* 碰撞密度到多少分归零 */
    fitSat: 0.5,
    alignSat: 0.5,
    edgeSat: 1.0,
    styleSat: 0.5,
    minGap: 10,         /* 期望最小节点间距 px */
    fillPalette: 3,     /* 允许的配色档位数 */
    fontTiers: 2        /* 允许的字号档位数（主标题 / 副标题） */
  },

  WEIGHTS: { collision: 0.25, textFit: 0.20, alignment: 0.15, spacing: 0.15, edgeRouting: 0.10, style: 0.10, canvas: 0.05 },

  METRIC_KEYS: ['collision', 'textFit', 'alignment', 'spacing', 'edgeRouting', 'style', 'canvas'],
  METRIC_CN: { collision: '节点碰撞', textFit: '文本适配', alignment: '对齐', spacing: '间距', edgeRouting: '连线', style: '样式一致', canvas: '画布平衡' },

  sc(d, sat) { return r2(100 * clamp(1 - d / sat, 0, 1)); },

  run(ir, sopt) {
    const o = Object.assign({}, this.DEF, sopt || {});
    const W = ir.canvas.w, H = ir.canvas.h;
    const diag = Math.hypot(W, H) || 1000;
    o.rowTol = Math.max(6, Math.min(20, diag * 0.018));
    o.alignTol = Math.max(4, Math.min(14, diag * 0.014));

    const raw = {};
    raw.collision = this.collision(ir, o);
    raw.occlusion = this.occlusion(ir, o);
    raw.textFit = this.textFit(ir, o);
    raw.alignment = this.alignment(ir, o);
    raw.spacing = this.spacing(ir, o);
    raw.edgeRouting = this.edgeRouting(ir, o);
    raw.style = this.style(ir, o);
    raw.canvas = this.canvas(ir, o);
    raw.region = this.regionMetrics(ir, o);

    const metrics = {
      collision: this.sc(raw.collision.density + raw.occlusion.density, o.collSat),
      textFit: this.sc(raw.textFit.density, o.fitSat),
      alignment: this.sc(raw.alignment.density, o.alignSat),
      /* spacing 直接用变异系数比较，不走 density 归一 */
      spacing: r2(100 * clamp(1 - raw.spacing.cv / o.cvSat, 0, 1)),
      edgeRouting: this.sc(raw.edgeRouting.density, o.edgeSat),
      style: this.sc(raw.style.density, o.styleSat),
      canvas: this.sc(raw.canvas.density, 1.0)
    };

    const score = r2(this.METRIC_KEYS.reduce((a, k) => a + this.WEIGHTS[k] * metrics[k], 0));

    const issues = this.issues(ir, raw, o);
    const counts = {};
    for (const it of issues) counts[it.type] = (counts[it.type] || 0) + 1;

    return { ok: true, metrics, score, raw, issues, counts, weights: this.WEIGHTS, opts: o };
  },

  /* ==================== 区域级度量（F6 · 第一段：可观不可修） ====================
   * 动机：评分里唯一的"布局"维度是全画布 canvas（边距/溢出/利用率），没有任何
   * 区域级的密度、留白、视觉层级。于是「中央板块过挤、两侧过空」这类**全局布局**
   * 问题在评分里不可表达，门也就无从拦截 —— 这正是"局部规则正确、全局布局恶化"
   * 的机制性原因（不是观感问题）。
   *
   * ★ 第一段只写入 raw，**不进 METRIC_KEYS / WEIGHTS / score**。
   * 理由：现有维度已经在幻灯片域误报（实测 6 张真实图 style / spacing 恒为 0），
   * 在观测到新维度在全部样例上的分布之前就给它权重，等于把误报直接写进总分。
   * 流程：先用既有 sweep 收集分布 → 定标 sat → 再提升为"可修"（第二段）。
   *
   * ★ 不适用（applicable=false）必须解释为"满分且不报 issue"，**不能**解释为 0 分：
   * 否则每一张没有分组结构的扁平 SVG 都会被凭空扣分。
   *
   * 口径说明：视觉权重用「区域面积占比 × 平均字号」而**不含对比度** ——
   * contrastRatio 在 06_geometry.js（本文件之后加载），第一段刻意不引入该耦合；
   * 提升为第二段时再补，届时可一并纳入 sweep 定标。 */
  regionMetrics(ir, o) {
    const na = { applicable: false, n: 0, balance: 1, whitespace: 0, hierarchy: 0 };
    const rg = ir && ir.regions;
    if (!rg || !rg.regions || !rg.regions.length) return na;
    const panels = rg.regions.filter(r => r.kind === 'panel' || r.kind === 'card');
    if (panels.length < 2) return Object.assign({}, na, { n: panels.length });

    const cvA = Math.max(1, (ir.canvas.w || 0) * (ir.canvas.h || 0));
    const nById = new Map((ir.nodes || []).map(n => [n.id, n]));
    const membersOf = r => (r.members || []).map(id => nById.get(id)).filter(Boolean);
    const labeledOf = r => membersOf(r).filter(n => n.labels && n.labels.length).length;
    const avgFontOf = r => {
      let s = 0, c = 0;
      for (const n of membersOf(r)) for (const l of (n.labels || [])) { s += (l.fontSize || 0); c++; }
      return c ? Math.max(1, s / c) : 1;
    };

    /* ① 区域均衡：面板墨密度的极差（按最大值归一，故 d ∈ [0,1)） */
    const dens = panels.map(r => (typeof r.inkDensity === 'number' ? r.inkDensity : 0));
    const mx = Math.max.apply(null, dens), mn = Math.min.apply(null, dens);
    const balance = mx > 0 ? (mx - mn) / mx : 0;
    const worst = panels[dens.indexOf(mx)] || null, best = panels[dens.indexOf(mn)] || null;

    /* ② 留白：只统计「本应承载内容」的面板（≥2 个成员且 ≥1 个带标签成员）。
     * ★ 只有"过挤"方向计入 d；"过空"方向单独记入 looseItems 仅作报警 ——
     *   大片留白可能是有意设计，而且几何引擎**无法生成内容去填满留白**
     *   （那是语义生成，超出能力）；强行做只会把文字挪来挪去。 */
    const elig = panels.filter(r => (r.members || []).length >= 2 && labeledOf(r) >= 1);
    let tightSum = 0;
    const looseItems = [], tightItems = [];
    for (const r of elig) {
      const w = (typeof r.whitespace === 'number') ? r.whitespace : 0;
      const tight = clamp((0.22 - w) / 0.22, 0, 1);
      const loose = clamp((w - 0.62) / 0.38, 0, 1);
      tightSum += tight;
      if (tight > 0) tightItems.push({ id: r.id, name: r.name || '', whitespace: r2(w), pen: r2(tight) });
      if (loose > 0) looseItems.push({ id: r.id, name: r.name || '', whitespace: r2(w), pen: r2(loose) });
    }
    const whitespace = elig.length ? tightSum / elig.length : 0;

    /* ③ 视觉层级：语义重要性秩 与 视觉权重秩 的不一致率（逆序对比例） */
    const visOf = r => (R.area(r.bbox) / cvA) * (avgFontOf(r) / 16);
    const semOf = r => (r.name ? 1 : 0) + ((r.members || []).length >= 2 ? 1 : 0) + (labeledOf(r) >= 1 ? 1 : 0);
    let disc = 0, pairs = 0;
    for (let i = 0; i < panels.length; i++) {
      for (let j = i + 1; j < panels.length; j++) {
        const ds = semOf(panels[i]) - semOf(panels[j]);
        const dv = visOf(panels[i]) - visOf(panels[j]);
        if (ds === 0 || dv === 0) continue;      /* 并列不计入，避免把平局算成不一致 */
        pairs++;
        if ((ds > 0) !== (dv > 0)) disc++;
      }
    }

    return {
      applicable: true, n: panels.length,
      balance: r2(balance), whitespace: r2(whitespace), hierarchy: pairs ? r2(disc / pairs) : 0,
      worstRegion: worst ? { id: worst.id, name: worst.name || '', inkDensity: r2(dens[dens.indexOf(mx)]) } : null,
      bestRegion: best ? { id: best.id, name: best.name || '', inkDensity: r2(mn) } : null,
      tiePairs: pairs, looseItems, tightItems,
      regions: panels.map(r => ({ id: r.id, kind: r.kind, name: r.name || '',
                                   inkDensity: r2(r.inkDensity || 0), whitespace: r2(r.whitespace || 0),
                                   members: (r.members || []).length }))
    };
  },

  /* ========================== 1. 节点碰撞 ========================== */
  collision(ir, o) {
    const ns = ir.nodes, pairs = [];
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const a = ns[i], b = ns[j];
        const inter = R.intersect(a.bbox, b.bbox);
        if (!inter) continue;
        const cover = R.coverRatio(a.bbox, b.bbox);
        if (cover >= 0.95) continue;                       /* 完全包含 = 合法嵌套容器 */
        if (inter.w < 2 && inter.h < 2) continue;          /* stroke 外扩造成的发丝级接触 */
        pairs.push({
          a: a.id, b: b.id, aDesc: a.describe, bDesc: b.describe,
          rect: { x: r2(inter.x), y: r2(inter.y), w: r2(inter.w), h: r2(inter.h) },
          cover: r2(cover), overlapW: r2(inter.w), overlapH: r2(inter.h),
          depth: r2(Math.min(inter.w, inter.h)), aRef: a, bRef: b, interRect: inter
        });
      }
    }
    const density = pairs.reduce((s, p) => s + clamp(p.cover, 0, 1), 0) / Math.max(1, ns.length);
    return { density: r2(density), pairs, count: pairs.length, worst: pairs.length ? Math.max(...pairs.map(p => p.cover)) : 0 };
  },

  /* ========================== 1b. 文字遮挡（text behind opaque shape） ==========================
   * ★ real-02 缺陷：标题文字被后绘制的海军蓝胶囊遮住（"训练场" 看不见）。
   *   旧 collision 只比 node-vs-node，文字（自由文本 / 节点的标签）从不在比较里，
   *   所以「文字被不透明形状压在底下」永远检不出。
   *   判定：对每个文字（自由文本 + 所有节点标签），若存在**非背景、不透明填充**的节点
   *   ① 与文字 bbox 有实质交叠（覆盖 ≥30% 或文字中心落入该形状），
   *   ② 且该形状在文档顺序上**晚于**文字绘制（compareDocumentPosition FOLLOWING，
   *      即它会盖在文字之上），则记为 occlusion（critical / high）。
   *   修复策略：nudge_text（把文字平移出形状，优先，视觉最干净）或
   *   raise_text（把文字提到该形状之上重绘，兜底，保证可见）。 */
  occlusion(ir, o) {
    const FOLLOWING = (typeof Node !== 'undefined' && Node.DOCUMENT_POSITION_FOLLOWING) || 4;
    const texts = [];
    for (const t of (ir.texts || [])) texts.push({ t, owner: null });
    for (const n of ir.nodes) for (const l of (n.labels || [])) texts.push({ t: l, owner: n });
    const items = [];
    for (const e of texts) {
      const t = e.t, owner = e.owner;
      if (!t || !t.bbox || !t.elem) continue;
      const tb = t.bbox, tArea = R.area(tb);
      if (tArea <= 0) continue;
      for (const m of ir.nodes) {
        if (m === owner || m.isBg) continue;
        const c = normColor(m.fill);
        if (!c) continue;                                       /* 无填充/透明/命名色 → 不遮挡 */
        const inter = R.intersect(R.expand(tb, 2), m.geomBox);
        if (!inter) continue;
        /* ★ 关键修正（real-02 实测）：长标题只有“尾巴”压在不透明形状下时，
         *   整段文字被形状覆盖的比例极低（本例 ≈7%），若按 ≥30% 覆盖才判定，
         *   这种“文字被切掉一截”的遮挡永远检不出。改为：**只要文字 bbox 与
         *   不透明形状有实质交叠（两维都 ≥6px，排除发丝级接触）且形状晚于文字绘制，
         *   即记为遮挡**——被压住的那截字形本就不可见，是真实缺陷。 */
        const meaningful = inter.w >= 6 && inter.h >= 6;
        if (!meaningful) continue;
        let after = false;                                       /* 形状是否晚于文字绘制（盖在上方） */
        try { after = (t.elem.compareDocumentPosition(m.shapeElem || m.elem) & FOLLOWING) !== 0; } catch (x) {}
        if (!after) continue;
        const cover = R.area(inter) / tArea;
        const centerIn = R.has(m.geomBox, { x: R.cx(tb), y: R.cy(tb) });
        items.push({
          textId: t.id, shapeId: m.id,
          textDesc: (t.text ? ('“' + t.text.slice(0, 16) + '”') : t.id),
          shapeDesc: m.describe, cover: r2(cover), centerIn, area: r2(R.area(inter)),
          rect: { x: r2(inter.x), y: r2(inter.y), w: r2(inter.w), h: r2(inter.h) },
          textRef: t, shapeRef: m, ownerRef: owner
        });
      }
    }
    /* 密度按「条数」计（每条遮挡至少 0.25，封顶 1），让存在遮挡时分数有可见落差，
     * 修复后才能越过 op 级门（Δ0 会被拒）。旧实现除以全部文字数 ≈43 → 单条仅 0.003，修复零收益。 */
    const density = r2(clamp(items.reduce((s, it) => s + Math.max(it.cover, 0.25), 0), 0, 1));
    return { items, count: items.length, density, worst: items.length ? Math.max(...items.map(it => it.cover)) : 0 };
  },

  /* ========================== 2. 文本适配 ========================== */
  textFit(ir, o) {
    const items = [];
    for (const n of ir.nodes) {
      if (!n.labels.length || !n.pad) continue;
      const p = n.pad, g = n.geomBox;
      if (g.w <= 0 || g.h <= 0) continue;
      const dL = Math.max(0, o.minPad - p.l), dR = Math.max(0, o.minPad - p.r);
      const dT = Math.max(0, o.minPad - p.t), dB = Math.max(0, o.minPad - p.b);
      const pen = (dL + dR) / g.w + (dT + dB) / g.h;
      if (pen <= 1e-6) continue;
      items.push({
        node: n.id, desc: n.describe, pen: r2(pen),
        label: n.labels.map(l => l.text).join(' / ').slice(0, 40),
        boxW: r2(g.w), boxH: r2(g.h),
        textW: r2(n.textW), textH: r2(n.textH),
        pad: p, dL: r2(dL), dR: r2(dR), dT: r2(dT), dB: r2(dB),
        overflowX: r2(Math.max(0, n.textW - g.w)), overflowY: r2(Math.max(0, n.textH - g.h)),
        nodeRef: n, worstSide: (dL + dR) >= (dT + dB) ? 'x' : 'y'
      });
    }
    const density = items.reduce((s, i) => s + i.pen, 0) / Math.max(1, ir.nodes.reduce((a, n) => a + (n.labels.length ? 1 : 0), 0));
    return { density: r2(density), items, count: items.length, worst: items.length ? Math.max(...items.map(i => i.pen)) : 0 };
  },

  /* ========================== 3. 对齐 ========================== */
  alignment(ir, o) {
    const ns = ir.nodes;
    if (ns.length < 2) return { density: 0, clusters: [], error: 0, count: 0 };
    const fams = [
      { k: 'left', f: n => n.bbox.x, cn: '左边' },
      { k: 'centerX', f: n => R.cx(n.bbox), cn: '水平中心' },
      { k: 'right', f: n => R.right(n.bbox), cn: '右边' },
      { k: 'top', f: n => n.bbox.y, cn: '上边' },
      { k: 'centerY', f: n => R.cy(n.bbox), cn: '垂直中心' },
      { k: 'bottom', f: n => R.bottom(n.bbox), cn: '下边' }
    ];
    const clusters = [];
    let error = 0;
    for (const fam of fams) {
      const vals = ns.map(n => ({ v: fam.f(n), n })).sort((a, b) => a.v - b.v);
      let cur = [vals[0]];
      const flush = () => {
        if (cur.length >= 2) {
          const spread = cur[cur.length - 1].v - cur[0].v;
          if (spread > o.alignMin && spread <= o.alignTol) {
            error += spread;
            clusters.push({
              family: fam.k, cn: fam.cn, spread: r2(spread),
              members: cur.map(c => c.n.id), descs: cur.map(c => c.n.describe),
              target: r2(cur.map(c => c.v).sort((a, b) => a - b)[Math.floor(cur.length / 2)])
            });
          }
        }
      };
      for (let i = 1; i < vals.length; i++) {
        if (vals[i].v - cur[cur.length - 1].v <= o.alignTol) cur.push(vals[i]);
        else { flush(); cur = [vals[i]]; }
      }
      flush();
    }
    const density = error / Math.max(1, ns.length * o.alignTol);
    return { density: r2(density), clusters, error: r2(error), count: clusters.length };
  },

  /* ========================== 4. 间距 ========================== */
  spacing(ir, o) {
    const rows = this.gapsAlong(ir, 'x', o);   /* 同一行内沿 x 排开的间隙 */
    const cols = this.gapsAlong(ir, 'y', o);   /* 同一列内沿 y */
    const all = rows.concat(cols).filter(g => g.gaps.length >= 2);
    let cv = 0, worst = null;
    for (const g of all) {
      if (g.cv > cv) { cv = g.cv; worst = g; }
    }
    return { density: r2(cv), cv: r2(cv), groups: all, count: all.length, worst, totalGaps: all.reduce((a, g) => a + g.gaps.length, 0) };
  },

  gapsAlong(ir, axis, o) {
    const tol = o.rowTol;
    const perp = axis === 'x' ? 'y' : 'x';
    const key = n => axis === 'x' ? R.cy(n.bbox) : R.cx(n.bbox);
    const sorted = ir.nodes.slice().sort((a, b) => key(a) - key(b));
    const groups = [];
    for (const n of sorted) {
      const g = groups[groups.length - 1];
      /* ★ 锚定聚类：与**组锚**（该组第一个成员）比较，不再与「上一个成员」比较。
       * 单链式比较会让中心缓慢漂移的元素一路串成同一组 —— 容差 20px 时，
       * 二十几个节点足以从页顶串到页底。实测 real-01 的 x 向分组把
       * 「页头横条 + 中央大容器 + 左侧卡片 + 三个圆点」串成一行，
       * 间距算成 −1846.5px，均分直接把卡片横向扔出 339px（节点碰撞 100→62）。 */
      if (g && Math.abs(key(n) - g.anchor) <= tol) g.members.push(n);
      else groups.push({ anchor: key(n), members: [n] });
    }
    const out = [];
    for (const g of groups) {
      if (g.members.length < 3) continue;
      const line = g.members.slice().sort((a, b) => axis === 'x' ? a.bbox.x - b.bbox.x : a.bbox.y - b.bbox.y);
      const gaps = [];
      for (let i = 1; i < line.length; i++) gaps.push(r2(R.gap(line[i - 1].bbox, line[i].bbox, axis)));
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
      const cv = mean > 1e-6 ? sd / Math.abs(mean) : (sd > 1 ? 1 : 0);
      out.push({
        axis, perp, members: line.map(n => n.id), descs: line.map(n => n.describe),
        gaps, mean: r2(mean), sd: r2(sd), cv: r2(cv),
        minGap: r2(Math.min(...gaps)), maxGap: r2(Math.max(...gaps)),
        tooTight: gaps.filter(v => v < o.minGap).length
      });
    }
    return out;
  },

  /* ========================== 5. 连线 ========================== */
  edgeRouting(ir, o) {
    const nodeHits = [], edgeHits = [];
    /* (a) 连线穿过「非端点」节点的几何盒 */
    for (const e of ir.edges) {
      const self = new Set([e.source, e.target].filter(Boolean));
      for (const n of ir.nodes) {
        if (self.has(n.id)) continue;
        /* 端点贴近该节点 → 视为合法终止，不算穿越 */
        const dEnd = Math.min(R.distToPoint(n.geomBox, e.pts[0]), R.distToPoint(n.geomBox, e.pts[e.pts.length - 1]));
        if (dEnd <= o.minGap) continue;
        const k = Seg.hitsRect(e.pts, n.geomBox, 1.0);
        if (k > 0) nodeHits.push({ edge: e.id, node: n.id, edgeDesc: e.describe, nodeDesc: n.describe, hits: k, edgeRef: e, nodeRef: n });
      }
    }
    /* (b) 连线互相交叉 */
    const es = ir.edges;
    const share = (x, y) => {
      /* 共享端点节点的两条边会自然汇合（如同一个目标的合并线），不应判为交叉（实测误报根因） */
      for (const s of [x.source, x.target]) if (s && (s === y.source || s === y.target)) return true;
      return false;
    };
    for (let i = 0; i < es.length; i++) {
      for (let j = i + 1; j < es.length; j++) {
        if (share(es[i], es[j])) continue;
        let cnt = 0;
        const A = es[i].pts, B = es[j].pts;
        for (let a = 1; a < A.length; a++) {
          for (let b = 1; b < B.length; b++) {
            const p = Seg.cross(A[a - 1], A[a], B[b - 1], B[b]);
            if (!p) continue;
            /* 端点相接（共享端口）不算交叉 */
            const nearEnd = [A[0], A[A.length - 1]].some(q => Math.hypot(q.x - p.x, q.y - p.y) < 5) &&
                            [B[0], B[B.length - 1]].some(q => Math.hypot(q.x - p.x, q.y - p.y) < 5);
            if (nearEnd) continue;
            /* 交叉点落在任一折线的顶点上 = 汇合/T 形接点，不算交叉 */
            const onVertex = [...A, ...B].some(q => Math.hypot(q.x - p.x, q.y - p.y) < 1.5);
            if (onVertex) continue;
            cnt++;
          }
        }
        if (cnt > 0) edgeHits.push({ a: es[i].id, b: es[j].id, aDesc: es[i].describe, bDesc: es[j].describe, count: cnt, aRef: es[i], bRef: es[j] });
      }
    }
    const density = (nodeHits.length + 0.5 * edgeHits.length) / Math.max(1, ir.edges.length);
    return { density: r2(density), nodeHits, edgeHits, count: nodeHits.length + edgeHits.length };
  },

  /* ========================== 6. 样式一致 ========================== */
  style(ir, o) {
    const fonts = [];
    for (const n of ir.nodes) for (const l of n.labels) fonts.push({ v: l.fontSize, id: n.id, desc: n.describe });
    for (const t of ir.texts) fonts.push({ v: t.fontSize, id: t.id, desc: 'text' });
    const sizes = [...new Set(fonts.map(f => r2(f.v)))].filter(v => v > 0).sort((a, b) => a - b);
    const fontExcess = Math.max(0, sizes.length - o.fontTiers);
    const fontSpread = (fontExcess > 0 && sizes.length) ? (sizes[sizes.length - 1] - sizes[0]) / sizes[sizes.length - 1] : 0;

    const fills = {};
    for (const n of ir.nodes) {
      const c = normColor(n.fill);
      if (!c) continue;
      fills[c] = (fills[c] || 0) + 1;
    }
    const fillList = Object.keys(fills).sort((a, b) => fills[b] - fills[a]);
    const fillExcess = Math.max(0, fillList.length - o.fillPalette);
    const maxFill = fillList.length ? fills[fillList[0]] / ir.nodes.length : 1;
    const fillSpread = fillExcess > 0 ? clamp(1 - maxFill, 0, 1) : 0;

    const density = 0.6 * fontSpread + 0.4 * fillSpread;
    return {
      density: r2(density), sizes, fontExcess, fontSpread: r2(fontSpread),
      fills: fillList.map(k => ({ color: k, n: fills[k] })), fillExcess, fillSpread: r2(fillSpread),
      nFonts: fonts.length,
      outliers: fontExcess > 0 ? fonts.filter(f => r2(f.v) !== sizes[0] && r2(f.v) !== sizes[sizes.length - 1]).map(f => ({ v: f.v, desc: f.desc })) : []
    };
  },

  /* ========================== 7. 画布平衡 ========================== */
  canvas(ir, o) {
    const W = ir.canvas.w, H = ir.canvas.h, cb = ir.contentBox;
    if (!cb || W <= 0 || H <= 0) return { density: 0, margins: null };
    const margins = { l: r2(cb.x), t: r2(cb.y), r: r2(W - R.right(cb)), b: r2(H - R.bottom(cb)) };
    const vals = [margins.l, margins.t, margins.r, margins.b];
    const overflow = Math.max(0, -Math.min(...vals));
    const mean = vals.reduce((a, b) => a + b, 0) / 4;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / 4);
    const balance = mean > 1e-6 ? clamp(sd / mean, 0, 2) : 0;
    const u = R.area(cb) / (W * H);
    let d = 0.5 * clamp(balance, 0, 1);
    d += overflow > 0 ? clamp(overflow / 40, 0, 1) : 0;
    d += u > 0.92 ? clamp((u - 0.92) / 0.08, 0, 1) * 0.4 : 0;
    d += u < 0.15 ? clamp((0.15 - u) / 0.15, 0, 1) * 0.3 : 0;
    return { density: r2(clamp(d, 0, 2)), margins, balance: r2(balance), utilization: r2(u), overflow: r2(overflow), contentBox: cb };
  },

  /* ========================== Issue 模型 ========================== */
  issues(ir, raw, o) {
    const out = [];
    let k = 0;
    const add = (type, targets, priority, evidence, candidates, fixable) =>
      out.push({ id: 'ISS-' + (++k), type, targets, priority, evidence, candidates, fixable: fixable !== false });

    for (const p of raw.collision.pairs) {
      add('overlap', [p.a, p.b], p.cover >= 0.25 ? 'critical' : 'high',
        { cover: p.cover, overlapW: p.overlapW, overlapH: p.overlapH, depth: p.depth, where: p.rect },
        ['move_apart', 'grow_spacing', 'global_relayout']);
    }
    for (const it of raw.occlusion.items) {
      add('occlusion', [it.textId, it.shapeId], (it.centerIn || it.area >= 400) ? 'critical' : 'high',
        { cover: it.cover, where: it.rect, shapeDesc: it.shapeDesc, textDesc: it.textDesc, centerIn: it.centerIn, area: it.area,
          textRef: it.textRef, shapeRef: it.shapeRef, ownerRef: it.ownerRef },
        ['nudge_text', 'raise_text']);
    }
    for (const i of raw.textFit.items) {
      add('text_overflow', [i.node], i.pen >= 0.25 ? 'critical' : 'high',
        { pen: i.pen, textW: i.textW, boxW: i.boxW, boxH: i.boxH, textH: i.textH, pad: i.pad,
          dL: i.dL, dR: i.dR, dT: i.dT, dB: i.dB, label: i.label, worstSide: i.worstSide,
          /* 修复策略需要节点引用才能算出精确数值；漏掉它会导致「策略选中但产出 0 个 op」 */
          nodeRef: i.nodeRef },
        ['reflow_body', 'resize_container', 'move_text', 'wrap_text', 'reduce_font']);
    }
    for (const c of raw.alignment.clusters) {
      /* 只报「配对」级问题，同一个节点可能进多个簇，交给规则去重 */
      add('misalignment', c.members, c.spread > 6 ? 'medium' : 'low',
        { family: c.family, cn: c.cn, spread: c.spread, target: c.target, descs: c.descs },
        ['snap_edges', 'snap_centers']);
    }
    for (const g of raw.spacing.groups) {
      if (g.cv <= 0.18 && g.tooTight === 0) continue;
      add('spacing', g.members, (g.cv > 0.35 || g.tooTight > 0) ? 'high' : 'medium',
        { cv: g.cv, mean: g.mean, sd: g.sd, gaps: g.gaps, axis: g.axis, tooTight: g.tooTight, minGap: g.minGap },
        ['distribute_equal', 'distribute_weighted']);
    }
    for (const h of raw.edgeRouting.nodeHits) {
      add('edge_crossing', [h.edge, h.node], 'high',
        { kind: 'edge_through_node', hits: h.hits, edgeDesc: h.edgeDesc, nodeDesc: h.nodeDesc },
        ['orthogonal_reroute', 'keep_and_shift']);
    }
    for (const h of raw.edgeRouting.edgeHits) {
      add('edge_crossing', [h.a, h.b], 'medium',
        { kind: 'edge_over_edge', count: h.count, aDesc: h.aDesc, bDesc: h.bDesc },
        ['orthogonal_reroute', 'keep_and_shift']);
    }
    if (raw.style.density > 0.08) {
      add('style_inconsistency', ir.nodes.slice(0, 0), 'low',
        { fontSizes: raw.style.sizes, fontExcess: raw.style.fontExcess, fills: raw.style.fills.slice(0, 6), fillExcess: raw.style.fillExcess },
        ['normalize_style', 'keep_style']);
    }
    if (raw.canvas.overflow > 0 || raw.canvas.density > 0.35) {
      add('canvas_margin', [], (raw.canvas.overflow > 0 ? 'high' : 'low'),
        { margins: raw.canvas.margins, utilization: raw.canvas.utilization, overflow: raw.canvas.overflow },
        ['rebalance_canvas', 'keep_canvas']);
    }
    /* tiny_element：有标签但远小于中位面积的节点（标签必然不可读）
     * ★F7 防御性收窄：容器/装饰件不进此类。**请注意这不是本体图那 8 条的成因** ——
     * 实测那 8 条全部是真实的有标签数据节点（Validator / Repository / 数据语义化 …），
     * 该样本 decoration 数为 **0**，所以这条过滤在它上面是 no-op。
     * 它防的是另一类图：带标签的图例色块、带 `data-role="decoration"` 的方言标注件。
     * 本体图 tiny_element 成批放大导致 collision 96→16 的问题由 **F1 的 item 级增量提交**
     * 解决（每个 tiny 节点本就是独立 item，按 item 提交后只有不撞的那些会生效）。 */
    const tinyEligible = n => n.role === 'data' || n.role === undefined;
    const tiny = ir.nodes.filter(n => n.area < ir.medArea * (ir.opts.tinyRatio || 0.35)
      && n.labels.length > 0 && tinyEligible(n));
    for (const n of tiny) {
      add('tiny_element', [n.id], 'low',
        { area: r2(n.area), medArea: r2(ir.medArea), ratio: r2(n.area / Math.max(1, ir.medArea)), desc: n.describe },
        ['grow_to_min', 'ignore'], true);
    }
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    out.sort((a, b) => (order[a.priority] - order[b.priority]) || a.type.localeCompare(b.type));
    return out;
  },

  /* ---------- 指标 → 喂给模型的精简文本（设计文档 §7） ---------- */
  stateText(ir, an, label) {
    const m = an.metrics, c = an.counts, L = [];
    L.push(`task: ${label || 'svg layout quality repair'}`);
    L.push(`diagram: architecture svg  canvas: ${ir.canvas.w}x${ir.canvas.h}`);
    L.push(`nodes: ${ir.stats.nodes}  edges: ${ir.stats.edges}  labels: ${ir.stats.labels}  groups: ${ir.stats.groups}`);
    L.push(`semantic dialect: ${ir.dialect === 'semantic' ? 'data-role present' : 'heuristic inference'}`);
    L.push(`preserved elements: ${ir.stats.preserved}`);
    L.push(`quality: overall ${m.collision !== undefined ? '' : ''}${an.score}`);
    L.push(`metrics: collision ${m.collision}  textFit ${m.textFit}  alignment ${m.alignment}  spacing ${m.spacing}  edgeRouting ${m.edgeRouting}  style ${m.style}  canvas ${m.canvas}`);
    const cLine = Object.keys(c).sort().map(k => `${k} x${c[k]}`).join(', ');
    L.push(`issues: ${cLine || 'none'}`);
    if (an.raw.collision.count) L.push(`worst overlap: ${pct(an.raw.collision.worst)} of smaller node`);
    if (an.raw.occlusion.count) L.push(`worst occlusion: ${pct(an.raw.occlusion.worst)} of text hidden by opaque shape`);
    if (an.raw.textFit.count) L.push(`worst text overflow: ${nf(an.raw.textFit.worst * 100, 1)}% of box`);
    if (an.raw.alignment.count) L.push(`worst misalignment: ${nf(Math.max(...an.raw.alignment.clusters.map(x => x.spread)), 1)}px`);
    if (an.raw.spacing.count) L.push(`worst spacing cv: ${nf(an.raw.spacing.cv, 2)}`);
    if (an.raw.style.sizes.length) L.push(`font sizes: ${an.raw.style.sizes.join(', ')}  fills: ${an.raw.style.fills.slice(0, 4).map(f => f.color).join(', ')}`);
    return L.join('\n');
  }
};

/* paint 引用解析缓存：normColor 在 occlusion 的 O(文字 × 节点) 循环里被反复调用，
 * 每个 url(#id) 都去查 DOM 会明显变慢，故按引用串缓存解析结果。 */
const PAINT_REF_CACHE = new Map();

function paintRefExists(id) {
  if (PAINT_REF_CACHE.has(id)) return PAINT_REF_CACHE.get(id);
  let ok = false;
  try {
    const root = (typeof Runtime !== 'undefined' && Runtime.root) ? Runtime.root() : null;
    if (root) {
      ok = !!(root.getElementById ? root.getElementById(id) : null);
      if (!ok && root.querySelector) ok = !!root.querySelector('#' + id);
    }
  } catch (x) { ok = false; }
  PAINT_REF_CACHE.set(id, ok);
  return ok;
}

function normColor(c) {
  if (!c) return '';
  let s = String(c).trim().toLowerCase();
  if (s === 'none' || s === 'transparent' || s === 'currentcolor') return '';
  /* ★F9：**悬空**的 paint 引用按「无填充」处理。
   * 在 SVG 里 `fill="url(#id)"` 若解析不到对应的渐变/图案，元素根本不会被绘制；
   * 旧实现对此返回非空字符串，于是 04 的 occlusion 与 06 的 _nudgePlan 会把它
   * 当成不透明遮挡源，**凭空报出「文字被遮挡」**（实测 normColor('url(#nonexistent)')
   * 返回 'url(#nonexistent)'）。
   * 注意方向：**能解析到**的 url(#id) 仍然返回非空 —— 渐变按不透明处理，这是对的。
   * 设计文档原设想「渐变被当成不遮挡 → 遮挡漏检」与代码事实相反（已用探针核实：
   * normColor 对 url/命名色都返回非空），故此项只修悬空引用，不引入 stop-opacity 解析。 */
  if (s.indexOf('url(') === 0) {
    const m = s.match(/#([^)]+)\)/);
    if (!m) return '';
    return paintRefExists(m[1]) ? s.slice(0, 20) : '';
  }
  if (s[0] === '#') {
    if (s.length === 4) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return s.slice(0, 7);
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[\s,\/]+/).map(Number);
    if (p.length >= 4 && p[3] === 0) return '';
    return '#' + p.slice(0, 3).map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }
  return s.slice(0, 20);
}
