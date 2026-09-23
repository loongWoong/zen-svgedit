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
    raw.textFit = this.textFit(ir, o);
    raw.alignment = this.alignment(ir, o);
    raw.spacing = this.spacing(ir, o);
    raw.edgeRouting = this.edgeRouting(ir, o);
    raw.style = this.style(ir, o);
    raw.canvas = this.canvas(ir, o);

    const metrics = {
      collision: this.sc(raw.collision.density, o.collSat),
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
    /* tiny_element：有标签但远小于中位面积的节点（标签必然不可读） */
    const tiny = ir.nodes.filter(n => n.area < ir.medArea * (ir.opts.tinyRatio || 0.35) && n.labels.length > 0);
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
    if (an.raw.textFit.count) L.push(`worst text overflow: ${nf(an.raw.textFit.worst * 100, 1)}% of box`);
    if (an.raw.alignment.count) L.push(`worst misalignment: ${nf(Math.max(...an.raw.alignment.clusters.map(x => x.spread)), 1)}px`);
    if (an.raw.spacing.count) L.push(`worst spacing cv: ${nf(an.raw.spacing.cv, 2)}`);
    if (an.raw.style.sizes.length) L.push(`font sizes: ${an.raw.style.sizes.join(', ')}  fills: ${an.raw.style.fills.slice(0, 4).map(f => f.color).join(', ')}`);
    return L.join('\n');
  }
};

function normColor(c) {
  if (!c) return '';
  let s = String(c).trim().toLowerCase();
  if (s === 'none' || s === 'transparent' || s === 'currentcolor') return '';
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
