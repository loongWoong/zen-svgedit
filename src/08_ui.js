/* =============================================================================
 * SVG Beautifier · 08 非侵入叠加视图（Design doc v1.1 专题）
 *
 * 宪法级约束：**Wireframe 是 View，不是 Mutation**。
 *   本层只在 canvas 之上叠一个独立的 <svg class="svgb-ovl">，
 *   内容 DOM 一个字节都不改；切换视图 = 清空叠加层重画。
 *
 * Wireframe / 白板模式（用户两轮反馈后定稿）：
 *   不做「隐藏内容 + 画 IR 骨架」——那会让骨架盖在真内容上、且仍透出颜色。
 *   改为：用 CSS（ui.html 的 #stage.wireframe 规则）把**真实内容**去色为纯黑白
 *   （形状去填充/描边转黑、文字转黑、背景转白、图片灰度），与官方 SVG-Edit 白板
 *   语义一致；本层 wireframe() 只负责清空叠加层。
 *
 * 四种视图：
 *   original    —— 什么都不画（原始 DOM 即结果）
 *   wireframe   —— 真实内容由 CSS 去色为黑白（见 ui.html 的 #stage.wireframe 规则）；
 *                 本层只清空叠加层，不画任何骨架（与官方 SVG-Edit 白板语义一致）。
 *   diagnostic  —— 每个 issue 的落点高亮 + 优先级配色
 *   proposed    —— 每个待执行 op 的 before（虚线）/ after（实线）
 * ===========================================================================*/
'use strict';

const Views = {
  NS: 'http://www.w3.org/2000/svg',
  ovl: null,
  host: null,

  PAL: {
    node: '#2f6fed', nodeFill: 'rgba(47,111,237,0.06)',
    edge: '#0d9488', baseline: '#c2740a',
    critical: '#d64545', high: '#c2740a', medium: '#2f6fed', low: '#98a2b3',
    before: '#98a2b3', after: '#0d9488'
  },

  /* hostEl = 叠加层的宿主元素（必须是 svgcanvas 挂载点的**兄弟容器**，
   * 因为 svgcanvas 会重建自己容器内的 DOM，把叠加层塞进去会被连带清掉）。
   * 支持两种用法：显式 Views.ensure(stage) 或在 render 的 ctx 里带 host。 */
  ensure(hostEl) {
    const h = hostEl || this.host;
    if (!h) return null;
    if (this.ovl && this.ovl.parentNode === h) return this.ovl;
    let o = null;
    try { o = h.querySelector('svg.svgb-ovl'); } catch (e) { o = null; }
    if (!o) {
      o = document.createElementNS(this.NS, 'svg');
      o.setAttribute('class', 'svgb-ovl');
      o.setAttribute('xmlns', this.NS);
      h.appendChild(o);
    }
    this.ovl = o; this.host = h;
    return o;
  },

  /* 把叠加层对齐到 svgcanvas 根的屏幕矩形（host 可能带内边距） */
  sync(rt) {
    const o = this.ovl, root = rt.root();
    if (!o || !root || !this.host) return null;
    const r = root.getBoundingClientRect(), h = this.host.getBoundingClientRect();
    const s = o.style;
    s.left = r2(r.left - h.left) + 'px';
    s.top = r2(r.top - h.top) + 'px';
    s.width = r2(r.width) + 'px';
    s.height = r2(r.height) + 'px';
    o.setAttribute('viewBox', `0 0 ${r2(r.width)} ${r2(r.height)}`);
    return o;
  },

  clear() {
    if (!this.ovl) return;
    while (this.ovl.firstChild) this.ovl.removeChild(this.ovl.firstChild);
  },

  /* 建一个已套好「根用户空间 → 叠加层本地」矩阵的 <g> */
  begin(rt, cls) {
    const o = this.ensure(this.host); if (!o) return null;
    this.clear(); rt && this.sync(rt);
    const g = document.createElementNS(this.NS, 'g');
    const m = rt ? rt.overlayMatrix(o) : M.id();
    g.setAttribute('transform', `matrix(${nf(m.a, 5)},${nf(m.b, 5)},${nf(m.c, 5)},${nf(m.d, 5)},${r2(m.e)},${r2(m.f)})`);
    if (cls) g.setAttribute('class', cls);
    o.appendChild(g);
    return g;
  },

  el(g, tag, attrs) {
    const e = document.createElementNS(this.NS, tag);
    for (const k of Object.keys(attrs)) if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    g.appendChild(e);
    return e;
  },

  rect(g, r, attrs) {
    return this.el(g, 'rect', Object.assign({ x: r2(r.x), y: r2(r.y), width: r2(r.w), height: r2(r.h) }, attrs || {}));
  },

  text(g, x, y, s, attrs) {
    const t = this.el(g, 'text', Object.assign({ x: r2(x), y: r2(y) }, attrs || {}));
    t.textContent = s;
    return t;
  },

  /* ============================ 视图入口 ============================ */
  render(mode, ctx) {
    const { rt, ir, an, ops, zoom, host } = ctx || {};
    if (host) this.host = host;
    if (!mode || mode === 'original' || !rt || !ir) { this.ensure(this.host); this.clear(); return { drawn: 0, level: 0 }; }
    if (mode === 'wireframe') return this.wireframe();
    if (mode === 'diagnostic') return this.diagnostic(rt, ir, an);
    if (mode === 'proposed') return this.proposed(rt, ir, ops || []);
    this.clear();
    return { drawn: 0 };
  },

  /* ---------------------------- Wireframe ----------------------------
   * 白板模式：渲染**真实内容**为纯黑白（官方 SVG-Edit 同款做法）。
   *   视觉完全交给 CSS（ui.html 的 #stage.wireframe 规则：去填充、描边转黑、
   *   文字转黑、背景转白、图片灰度）。本方法**只清空叠加层、不画任何骨架**——
   *   否则又会像早期版本那样「叠一层黑白骨架盖在真内容上」，与官方白板语义相悖。 */
  wireframe() {
    this.ensure(this.host);
    this.clear();
    return { drawn: 0, level: 0 };
  },

  /* ---------------------------- Diagnostic ---------------------------- */
  diagnostic(rt, ir, an) {
    const g = this.begin(rt, 'dg'); if (!g) return { drawn: 0 };
    if (!an) return { drawn: 0 };
    /* 结构底噪：极淡的节点框，便于把高亮定位到图上 */
    for (const nd of ir.nodes) this.rect(g, nd.geomBox, { fill: 'none', stroke: '#dfe4ea', 'stroke-width': 0.8 });
    let n = 0;
    const byId = new Map();
    for (const nd of ir.nodes) byId.set(nd.id, nd);
    const byEdge = new Map();
    for (const e of ir.edges) byEdge.set(e.id, e);

    an.issues.forEach((it, idx) => {
      const col = this.PAL[it.priority] || this.PAL.low;
      const boxes = [];
      /* targets 是元素 id（节点 id / 边 id），按类型分派查表 */
      for (const id of (it.targets || [])) {
        const nd = byId.get(id); if (nd) { boxes.push(nd.bbox); continue; }
        const e = byEdge.get(id); if (e) boxes.push(R.fromPoints(e.pts));
      }
      /* evidence 的落点矩形键名随 issue 类型不同（04_analyzer.js#issues）：
       *   overlap        → evidence.where（碰撞交集矩形）
       *   text_overflow  → evidence.nodeRef（节点引用，取 bbox）
       * 其余类型没有落点矩形，靠 targets 的并集定位。 */
      const ev = it.evidence || {};
      if (ev.where) boxes.push(ev.where);
      if (ev.rect) boxes.push(ev.rect);
      if (!boxes.length && ev.nodeRef && ev.nodeRef.bbox) boxes.push(ev.nodeRef.bbox);
      const u = R.union(boxes);
      if (!u) return;
      const r = R.expand(u, 5, 5);
      this.rect(g, r, { fill: 'none', stroke: col, 'stroke-width': 1.4, rx: 3 });

      /* 序号气泡：编号与右侧 Issue 面板严格一一对应 */
      const bx = r.x + 7, by = r.y - 5;
      this.el(g, 'circle', { cx: r2(bx), cy: r2(by), r: 7.5, fill: col, opacity: 0.94 });
      this.text(g, bx, by + 3, String(idx + 1), {
        fill: '#fff', 'font-size': 9, 'font-weight': '700', 'text-anchor': 'middle',
        'font-family': 'ui-monospace,monospace'
      });
      /* L3 才写类型名：低倍下文字会糊成一团（与 wireframe 同一分层理由） */
      const zoom = (rt && rt.zoom) || 1;
      if (zoom > 0.8) {
        this.text(g, r2(bx + 10), r2(by + 3), String(it.type || ''), {
          fill: col, 'font-size': 8.5, 'font-family': 'ui-monospace,monospace',
          'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 2.4, 'stroke-opacity': 0.85
        });
      }
      n++;
    });
    return { drawn: n, issues: an.issues.length };
  },

  /* ----------------------------- Proposed ----------------------------- */
  proposed(rt, ir, ops) {
    const g = this.begin(rt, 'pp'); if (!g) return { drawn: 0 };
    if (!ops || !ops.length) return { drawn: 0 };
    let n = 0;
    for (const op of ops) {
      const pv = op.preview;
      if (!pv) continue;
      if (pv.before) this.rect(g, pv.before, {
        fill: 'none', stroke: this.PAL.before, 'stroke-width': 1, 'stroke-dasharray': '4 3', rx: 2
      });
      if (pv.path) {
        this.el(g, 'polyline', {
          points: pv.path.map(p => `${r2(p.x)},${r2(p.y)}`).join(' '),
          fill: 'none', stroke: this.PAL.after, 'stroke-width': 1.4
        });
        if (pv.before) this.rect(g, pv.before, { fill: 'none', stroke: this.PAL.before, 'stroke-width': 1, 'stroke-dasharray': '4 3' });
      } else if (pv.after) {
        this.rect(g, pv.after, { fill: 'rgba(13,148,136,0.07)', stroke: this.PAL.after, 'stroke-width': 1.4, rx: 2 });
      }
      n++;
    }
    return { drawn: n };
  }
};
