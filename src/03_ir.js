/* =============================================================================
 * SVG Beautifier · 03 Diagram IR（SVG → 语义模型）
 *
 * 设计文档 §8/§9/§10：SVG 是绘图语言，不携带「这是节点 / 这是边」的信息。
 * 推断优先级：语义方言（data-role，文档 §13）> 几何规则（文档 §10）。
 * 只读层：不修改任何属性，元素上的中间结果挂在 JS 属性 `__svgb` 上（不污染导出）。
 * ===========================================================================*/
'use strict';

const IR = {
  /* 判定阈值（全部可在 UI 覆盖） */
  DEF: {
    minNodeArea: 380,     /* 世界坐标下成为「节点」的最小面积 px² */
    maxAspect: 24,        /* 过窄过长的矩形视为分隔线 */
    edgeMinLen: 10,       /* 边的最短折线长度 */
    labelSlack: 2,        /* 文本中心落在形状内时允许的外扩 */
    portSlack: 26,        /* 端点距节点边框多近算「连到这个节点」 */
    tinyRatio: 0.35       /* 小于节点面积中位数 × 该比例 → tiny_element */
  },

  SKIP_INSIDE: ['defs', 'marker', 'clippath', 'mask', 'pattern', 'symbol', 'filter',
                'lineargradient', 'radialgradient', 'title', 'desc', 'metadata', 'style', 'script'],

  /* svgcanvas 往画布里塞的编辑器辅助层：不算内容 */
  EDITOR_ARTIFACT: ['#canvasBackground', '#svgroot', '#selectorGroup', '#grid', '#guide',
                    '#rulers', '#ruler_x', '#ruler_y', '#sidepanels', '#wireframe_rules'],

  isEditorArtifact(el) {
    if (!el) return true;
    const id = el.id || '';
    if (this.EDITOR_ARTIFACT.indexOf('#' + id) >= 0) return true;
    if (hasClass(el, 'selectable') && !el.getAttribute('data-role')) { /* 正常内容也可能带 */ }
    let p = el.parentNode;
    while (p && tagOf(p) !== 'svg') {
      if (this.SKIP_INSIDE.indexOf(tagOf(p)) >= 0) return true;
      if (p.id === 'canvasBackground' || p.id === 'selectorGroup') return true;
      p = p.parentNode;
    }
    return false;
  },

  tagsIn(list, names) { return list.filter(el => names.indexOf(tagOf(el)) >= 0); },

  /* ============================ 主入口 ============================ */
  build(rt, sopt) {
    const o = Object.assign({}, this.DEF, sopt || {});
    const root = rt.root(), content = rt.contentGroup();
    const notes = [];
    if (!root || !content) return { ok: false, err: '未载入 SVG' };

    const box = { w: rt.canvas.contentW || 0, h: rt.canvas.contentH || 0 };
    const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const canvas = {
      w: box.w, h: box.h,
      viewBox: vb.length === 4 ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : { x: 0, y: 0, w: box.w, h: box.h },
      root, content
    };

    /* ---------- 1. 收集候选元素 ---------- */
    const all = [];
    const walk = el => {
      for (const c of el.children) {
        if (this.SKIP_INSIDE.indexOf(tagOf(c)) >= 0) continue;
        all.push(c);
        walk(c);
      }
    };
    walk(content);

    const preserved = [];
    const candidates = [];
    for (const el of all) {
      const t = tagOf(el);
      if (Runtime.PRESERVE_TAGS.indexOf(t) >= 0) { if (!this.hasPreservedAncestor(el, preserved)) preserved.push(el); continue; }
      if (t === 'title' || t === 'desc' || t === 'metadata' || t === 'defs') continue;
      candidates.push(el);
    }

    /* ---------- 2. 语义方言优先 ---------- */
    const roleOf = el => (el.getAttribute && el.getAttribute('data-role')) || '';
    const dialect = all.some(el => roleOf(el)) ? 'semantic' : 'heuristic';

    /* ---------- 3. 组 → 节点（文档 §10：<g> 且空间关系一致 → Group = Node） ---------- */
    const groupNodes = new Set();
    const absorbed = new Set();
    /* 由深到浅处理，避免嵌套组重复吸收 */
    const groups = candidates.filter(el => tagOf(el) === 'g').reverse();
    for (const g of groups) {
      if (roleOf(g) === 'node') { groupNodes.add(g); for (const c of g.children) absorbed.add(c); continue; }
      const kids = [...g.children].filter(c => this.SKIP_INSIDE.indexOf(tagOf(c)) < 0 && tagOf(c) !== 'title' && tagOf(c) !== 'desc');
      const shapes = kids.filter(c => ['rect', 'circle', 'ellipse', 'polygon'].indexOf(tagOf(c)) >= 0);
      const texts = kids.filter(c => tagOf(c) === 'text');
      const paths = kids.filter(c => ['path', 'line', 'polyline'].indexOf(tagOf(c)) >= 0);
      if (shapes.length === 1 && texts.length >= 1 && paths.length === 0) {
        groupNodes.add(g); shapes.concat(texts).forEach(c => absorbed.add(c));
      }
    }

    /* ---------- 4. 分类 ---------- */
    const nodes = [], edges = [], freeTexts = [], decorations = [];
    let seq = 0;
    const mkId = p => p + (++seq);

    for (const g of groupNodes) {
      const kids = [...g.children];
      const shape = kids.find(c => ['rect', 'circle', 'ellipse', 'polygon'].indexOf(tagOf(c)) >= 0);
      const texts = kids.filter(c => tagOf(c) === 'text');
      const n = this.makeNode(rt, g, shape, texts, o, mkId);
      if (n) nodes.push(n); else decorations.push(g);
    }

    for (const el of candidates) {
      if (groupNodes.has(el) || absorbed.has(el)) continue;
      const t = tagOf(el);
      const role = roleOf(el);
      if (role === 'node') {
        const shape = ['rect', 'circle', 'ellipse', 'polygon'].indexOf(t) >= 0 ? el : [...el.children].find(c => ['rect', 'circle', 'ellipse', 'polygon'].indexOf(tagOf(c)) >= 0) || el;
        const texts = [...el.children].filter(c => tagOf(c) === 'text');
        const n = this.makeNode(rt, el, shape, texts, o, mkId);
        if (n) nodes.push(n); else decorations.push(el);
        continue;
      }
      if (t === 'text') { if (!absorbed.has(el)) freeTexts.push(this.makeText(rt, el, mkId)); continue; }
      if (t === 'path' || t === 'line' || t === 'polyline') {
        const e = this.makeEdge(rt, el, o, mkId);
        if (e) edges.push(e); else decorations.push(el);
        continue;
      }
      if (t === 'rect' || t === 'circle' || t === 'ellipse' || t === 'polygon') {
        const n = this.makeNode(rt, el, el, [], o, mkId);
        if (n) nodes.push(n); else decorations.push(el);
        continue;
      }
      if (t === 'g') continue;      /* 纯容器组：下钻即可 */
      decorations.push(el);
    }

    /* ---------- 5. 文本归属：自由文本若落在某节点框内，归为该节点标签 ---------- */
    for (const n of nodes) {
      const inside = freeTexts.filter(ft => R.has(R.expand(n.geomBox, o.labelSlack + 4), { x: R.cx(ft.bbox), y: R.cy(ft.bbox) }));
      for (const ft of inside) {
        n.labels.push(ft); ft.attachedTo = n.id;
      }
    }
    const texts = freeTexts.filter(ft => !ft.attachedTo);

    /* ---------- 6. 节点内边距与标签度量 ---------- */
    for (const n of nodes) n.pad = this.padding(n);
    for (const n of nodes) {
      n.textW = n.labels.length ? Math.max(...n.labels.map(l => l.bbox.w)) : 0;
      n.textH = n.labels.length ? R.union(n.labels.map(l => l.bbox)).h : 0;
      n.importance = (n.labels.map(l => l.text.length).reduce((a, b) => a + b, 0) || 0) + 1;
      n.area = R.area(n.bbox);
    }
    const areas = nodes.map(n => n.area).sort((a, b) => a - b);
    const medArea = areas.length ? areas[Math.floor(areas.length / 2)] : 0;

    /* ---------- 7. 边端点 → 源/目标节点 ---------- */
    for (const e of edges) {
      const a = e.pts[0], b = e.pts[e.pts.length - 1];
      const rs = e.elem.getAttribute && e.elem.getAttribute('data-source');
      const rtp = e.elem.getAttribute && e.elem.getAttribute('data-target');
      if (rs) e.source = (nodes.find(n => n.domId === rs) || {}).id || rs;
      if (rtp) e.target = (nodes.find(n => n.domId === rtp) || {}).id || rtp;
      if (!e.source) { const cand = this.nearestNode(nodes, a, o.portSlack); e.source = cand ? cand.id : null; e.sourceDist = cand ? cand.dist : null; }
      if (!e.target) { const cand = this.nearestNode(nodes, b, o.portSlack); e.target = cand ? cand.id : null; e.targetDist = cand ? cand.dist : null; }
      e.attached = !!(e.source || e.target);
      e.crossings = [];   /* 由 analyzer 填 */
    }

    /* ---------- 8. 画布内容盒 ---------- */
    const boxes = nodes.map(n => n.bbox).concat(edges.map(e => R.fromPoints(e.pts)), texts.map(t => t.bbox));
    const contentBox = R.union(boxes) || R.mk(0, 0, canvas.w, canvas.h);

    const ir = {
      ok: true, canvas, nodes, edges, texts, freeTexts: texts, decorations, preserved,
      dialect, medArea, contentBox, opts: o,
      notes,
      stats: {
        nodes: nodes.length, edges: edges.length, labels: nodes.reduce((a, n) => a + n.labels.length, 0) + texts.length,
        groups: groupNodes.size, preserved: preserved.length, decorations: decorations.length,
        danglingEdges: edges.filter(e => !e.attached).length
      }
    };
    return ir;
  },

  hasPreservedAncestor(el, list) {
    let p = el.parentNode;
    while (p && tagOf(p) !== 'svg') {
      const t = tagOf(p);
      if (Runtime.PRESERVE_TAGS.indexOf(t) >= 0 || t === 'defs') return true;
      p = p.parentNode;
    }
    return false;
  },

  /* ------------------------------ 节点 ------------------------------ */
  makeNode(rt, outer, shape, textEls, o, mkId) {
    if (!shape) return null;
    if (Runtime.PRESERVE_TAGS.indexOf(tagOf(shape)) >= 0) return null;
    let bbox = rt.worldBBox(shape, { stroke: true });
    const geom = rt.shapeGeom(shape);
    if (!bbox || !geom) return null;
    const ctm = rt.elemCTM(shape);
    const geomWorld = R.transform({ x: geom.x, y: geom.y, w: geom.w, h: geom.h }, ctm);
    const area = R.area(geomWorld);
    const role = (outer.getAttribute && outer.getAttribute('data-role')) || '';
    if (role !== 'node') {
      if (area < o.minNodeArea) return null;
      const asp = Math.max(geomWorld.w / Math.max(1e-6, geomWorld.h), geomWorld.h / Math.max(1e-6, geomWorld.w));
      if (asp > o.maxAspect) return null;
    }
    const labels = textEls.map(t => {
      const b = rt.worldBBox(t, { stroke: false });
      return {
        kind: 'label', elem: t, text: textOf(t), bbox: b,
        fontSize: parseFloat(cssPrio(t, 'font-size')) || numA(t, 'font-size', 14),
        anchor: getA(t, 'text-anchor', 'start'),
        baseline: getA(t, 'dominant-baseline', ''),
        fontFamily: getA(t, 'font-family', '') || cssPrio(t, 'font-family'),
        fill: getA(t, 'fill', '') || cssPrio(t, 'fill'),
        role: (t.getAttribute && t.getAttribute('data-role')) || 'label'
      };
    }).filter(l => l.bbox);
    const n = {
      kind: 'node', id: mkId('n'), outer, elem: outer, shapeElem: shape, labels,
      bbox, geomBox: geomWorld, shape: geom.shape || geom.kind, ctm,
      group: (outer !== shape) ? outer : null,
      domId: (shape.getAttribute && shape.getAttribute('data-id')) || shape.id || '',
      fill: getA(shape, 'fill', '') || cssPrio(shape, 'fill'),
      stroke: getA(shape, 'stroke', '') || cssPrio(shape, 'stroke'),
      rx: geom.rx || 0, transform: outer.getAttribute && outer.getAttribute('transform')
    };
    shape.__svgb = { role: 'node', id: n.id };
    n.label = labels.map(l => l.text).join(' / ').slice(0, 28);
    n.describe = `${tagOf(shape)}${n.domId ? '#' + n.domId : ''}${n.label ? '(' + n.label + ')' : ''}`;
    return n;
  },

  makeText(rt, el, mkId) {
    const bbox = rt.worldBBox(el, { stroke: false });
    if (!bbox) return null;
    const m = rt.measureElem(el);
    return {
      kind: 'text', id: mkId('t'), elem: el, text: textOf(el), bbox,
      measured: m, fontSize: m.fontSize,
      anchor: getA(el, 'text-anchor', 'start'),
      baseline: getA(el, 'dominant-baseline', ''),
      fill: getA(el, 'fill', '') || cssPrio(el, 'fill')
    };
  },

  /* ------------------------------- 边 ------------------------------- */
  makeEdge(rt, el, o, mkId) {
    const local = rt.polyline(el);
    if (!local || local.length < 2) return null;
    const ctm = rt.elemCTM(el);
    const pts = rt.toWorld(local, ctm);
    const len = Seg.len(pts);
    if (len < o.edgeMinLen) return null;
    const markerEnd = getA(el, 'marker-end', '');
    const markerStart = getA(el, 'marker-start', '');
    const fill = getA(el, 'fill', '') || cssPrio(el, 'fill');
    const stroke = getA(el, 'stroke', '') || cssPrio(el, 'stroke');
    const strokeW = parseFloat(getA(el, 'stroke-width', '')) || parseFloat(cssPrio(el, 'stroke-width')) || 0;
    const fillNone = !fill || fill === 'none' || fill === 'transparent' || fill === 'rgba(0, 0, 0, 0)';
    const d = getA(el, 'd', '');
    const closed = /z\s*$/i.test(d);

    const role = (el.getAttribute && el.getAttribute('data-role')) || '';
    let isEdge = false;
    if (role === 'edge') isEdge = true;
    else if (role === 'node' || role === 'label') isEdge = false;
    else isEdge = (!closed && (markerEnd || markerStart) ) ||
                  (!closed && fillNone && strokeW > 0 && len > 24);
    if (!isEdge) return null;

    const e = {
      kind: 'edge', id: mkId('e'), elem: el, pts, local, len, ctm,
      markerEnd, markerStart, stroke, strokeWidth: strokeW, closed, domId: el.id || '',
      routing: this.guessRouting(pts),
      label: (getA(el, 'd', '') || '').slice(0, 26)
    };
    el.__svgb = { role: 'edge', id: e.id };
    e.describe = `${tagOf(el)}${e.domId ? '#' + e.domId : ''}(${e.routing},${Math.round(len)}px)`;
    return e;
  },

  guessRouting(pts) {
    if (pts.length <= 2) return 'straight';
    let allOrtho = true, hasCurve = false;
    for (let i = 1; i < pts.length; i++) {
      const dx = Math.abs(pts[i].x - pts[i - 1].x), dy = Math.abs(pts[i].y - pts[i - 1].y);
      if (dx > 1.5 && dy > 1.5) allOrtho = false;
    }
    /* 采样点若明显偏离折线弦 → 曲线 */
    if (pts.length > 4) {
      const a = pts[0], b = pts[pts.length - 1];
      let maxDev = 0;
      for (const p of pts) {
        const den = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const dev = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / den;
        maxDev = Math.max(maxDev, dev);
      }
      hasCurve = maxDev > 2.5;
    }
    if (hasCurve) return 'spline';
    return allOrtho ? 'orthogonal' : 'straight';
  },

  nearestNode(nodes, p, slack) {
    let best = null;
    for (const n of nodes) {
      const d = R.distToPoint(n.bbox, p);
      if (d <= slack && (!best || d < best.dist)) best = { id: n.id, dist: d, node: n };
    }
    return best;
  },

  /* 节点内边距：标签包围盒相对形状几何盒的四向内缩（负值代表溢出） */
  padding(n) {
    if (!n.labels.length) return null;
    const lb = R.union(n.labels.map(l => l.bbox));
    if (!lb) return null;
    return {
      l: r2(lb.x - n.geomBox.x),
      t: r2(lb.y - n.geomBox.y),
      r: r2(R.right(n.geomBox) - R.right(lb)),
      b: r2(R.bottom(n.geomBox) - R.bottom(lb)),
      box: lb
    };
  },

  /* 行/列聚类：按中心坐标容差分组（供对齐与间距分析复用） */
  cluster(nodes, axis, tol) {
    const cx = n => axis === 'x' ? R.cx(n.bbox) : R.cy(n.bbox);
    const sorted = nodes.slice().sort((a, b) => cx(a) - cx(b));
    const out = [];
    for (const n of sorted) {
      const g = out[out.length - 1];
      if (g && Math.abs(cx(n) - cx(g[g.length - 1])) <= tol) g.push(n);
      else out.push([n]);
    }
    return out.filter(g => g.length >= 1);
  }
};
