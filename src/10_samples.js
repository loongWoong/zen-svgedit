/* =============================================================================
 * SVG Beautifier · 10 样例集（含缺陷注入 + 真值标签）
 *
 * 设计文档 §24：不靠手工标注，用「干净 SVG → 故意制造问题 → 问题标签 → 正确修复」
 * 自动产出可回归的数据。注入发生在**模型层**而不是字符串层，因此真值精确。
 *
 * 两套方言（对应设计文档 §13 与 §10）：
 *   semantic  → data-role / data-id / data-source / data-target（协议路径）
 *   raw       → 无任何语义标记，<g>+rect+text 与 marker-end 箭头（启发式路径）
 *
 * 布局用等宽列网格，因此「干净样例」在 alignment / spacing 上应接近满分——
 * 这是打分器的自洽性锚点：干净样例若被判有缺陷，说明打分器本身有 bug。
 * ===========================================================================*/
'use strict';

const Sampler = {
  PAD: 24,          /* 生成时的容器内边距：比 minPad(6) 宽出安全余量 */
  GAP_X: 60,
  GAP_Y: 32,
  COL_W: 158,
  ROW_H: 62,
  FILLS: {
    blue: ['#E6F1FB', '#185FA5', '#0C447C'],
    green: ['#E1F5EE', '#0F6E56', '#085041'],
    gray: ['#F1EFE8', '#5F5E5A', '#2C2C2A']
  },
  STROKE: '#4a5568',

  /* 用运行时同款测量器估算字号宽度，保证「干净」样例真的干净 */
  tw(text, size, weight) {
    if (typeof Runtime === 'undefined' || !Runtime.ready) return String(text).length * size * 0.6;
    return Runtime.measure(text, `${weight || 400} ${size}px sans-serif`).w;
  },

  /* ---------------------- 布局配方（干净模型） ---------------------- */
  recipes: {
    /* 纵向分层：4 层，中间层 2 个并列 */
    layered() {
      const rows = [
        [{ label: '数据源接入', sub: 'Kafka / CDC / 日志' }],
        [{ label: '实时计算', sub: 'Flink SQL' }, { label: '离线计算', sub: 'Spark 批处理' }],
        [{ label: '湖仓存储', sub: 'Hudi / Doris / Hive' }],
        [{ label: '本体建模', sub: 'OntoHub 语义层' }, { label: '指标服务', sub: 'Metric API' }]
      ];
      return { rows, cols: 2 };
    },
    /* 网格：3 列 × 3 行，用来压满对齐与间距 */
    grid() {
      return {
        rows: [
          [{ label: '采集' }, { label: '解析' }, { label: '入库' }],
          [{ label: '清洗' }, { label: '校验' }, { label: '聚合' }],
          [{ label: '建模' }, { label: '推理' }, { label: '服务' }]
        ], cols: 3
      };
    },
    /* 中心辐射：3 行，中间一个跨 3 列的大节点 */
    hub() {
      return {
        rows: [
          [{ label: '接入网关', sub: 'API Gateway' }],
          [{ label: '本体内核', sub: 'Ontology Runtime', span: 3, center: true }],
          [{ label: '推理引擎', sub: 'Reasoner' }, { label: '语义服务', sub: 'Semantic API' }]
        ],
        cols: 3
      };
    },
    /* 流水线：5 段一条线，间距单调 */
    pipeline() {
      return { rows: [[{ label: '抽取' }, { label: '转换' }, { label: '装载' }, { label: '校验' }, { label: '发布' }]], cols: 5 };
    }
  },

  /* 生成干净模型：等宽列 + 等间距，行列对齐严格成立 */
  layout(name, seed) {
    const rc = this.recipes[name]();
    const cols = rc.cols || 3;
    const originX = 40, originY = 40;
    const nodes = [], edges = [];
    const rows = rc.rows || [];
    /* 逐行排布；每行内等间距、整行居中到画布 */
    const canvasW = originX * 2 + cols * this.COL_W + (cols - 1) * this.GAP_X;
    const items = [];
    rows.forEach((row, ri) => {
      if (!row) return;
      const y = originY + ri * (this.ROW_H + this.GAP_Y);
      const total = row.length;
      const spanW = (n) => (n.span || 1) * this.COL_W + ((n.span || 1) - 1) * this.GAP_X;
      const rowW = row.reduce((a, n) => a + spanW(n), 0) + (total - 1) * this.GAP_X;
      let x = originX + (canvasW - originX * 2 - rowW) / 2;
      row.forEach((spec, ci) => {
        const w = spanW(spec);
        const h = this.ROW_H + (spec.sub ? 18 : 0);
        const id = `n${ri}_${ci}`;
        nodes.push(Object.assign({ id, ri, ci, x, y, w, h }, spec));
        x += w + this.GAP_X;
      });
    });
    /* 边：相邻行之间连；同列直下，跨列走行间水平通道 */
    const byRow = {};
    for (const n of nodes) (byRow[n.ri] = byRow[n.ri] || []).push(n);
    const rowIdx = Object.keys(byRow).map(Number).sort((a, b) => a - b);
    for (let k = 0; k < rowIdx.length - 1; k++) {
      const A = byRow[rowIdx[k]], B = byRow[rowIdx[k + 1]];
      if (A.length === 1 && B.length > 1) {
        /* 一对多：全部连到唯一的源（分层图常见） */
        B.forEach((b, j) => edges.push({ id: `e${k}_${j}`, from: A[0].id, to: b.id, pts: this.route(A[0], b) }));
      } else if (B.length === 1 && A.length > 1) {
        A.forEach((a, i) => edges.push({ id: `e${k}_${i}`, from: a.id, to: B[0].id, pts: this.route(a, B[0]) }));
      } else {
        for (let i = 0; i < A.length; i++) {
          const b = B.length === A.length ? B[i] : B[Math.min(i, B.length - 1)];
          edges.push({ id: `e${k}_${i}`, from: A[i].id, to: b.id, pts: this.route(A[i], b) });
        }
      }
    }
    /* 画布高度按实际内容盒 + 上边距求，保证四边留白对称（否则「干净样例」会被判画布失衡） */
    const cb = R.union(nodes.map(n => ({ x: n.x, y: n.y, w: n.w, h: n.h })));
    const canvasH = Math.round(R.bottom(cb) + originY);
    return { nodes, edges, canvasW: Math.round(canvasW), canvasH };
  },

  /* 正交路由：同列直下；跨列走两行之间的水平通道（该通道内无节点） */
  route(a, b) {
    const ax = r2(R.cx(a)), bx = r2(R.cx(b));
    const aBottom = r2(R.bottom(a)), bTop = r2(b.y);
    if (Math.abs(ax - bx) < 1) return [{ x: ax, y: aBottom }, { x: ax, y: bTop }];
    const midY = r2((aBottom + bTop) / 2);
    return [{ x: ax, y: aBottom }, { x: ax, y: midY }, { x: bx, y: midY }, { x: bx, y: bTop }];
  },

  /* --------------------------- 序列化 --------------------------- */
  serialize(model, dialect) {
    const { nodes, edges, canvasW, canvasH } = model;
    const L = [];
    L.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}">`);
    L.push(`<title>${dialect === 'semantic' ? 'Semantic dialect sample' : 'AI-generated architecture diagram'}</title>`);
    L.push(`<defs><marker id="arw" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">` +
      `<path d="M2 1L8 5L2 9" fill="none" stroke="${this.STROKE}" stroke-width="1.2" stroke-linecap="round"/></marker></defs>`);
    for (const n of nodes) {
      const p = this.STROKE;
      if (dialect === 'semantic') {
        L.push(`<g data-role="node" data-id="${n.id}">`);
        L.push(`<rect x="${r2(n.x)}" y="${r2(n.y)}" width="${r2(n.w)}" height="${r2(n.h)}" rx="8" fill="${n.fill}" stroke="${p}" stroke-width="0.8"/>`);
        L.push(`<text data-role="label" x="${r2(R.cx(n))}" y="${r2(n.y + (n.sub ? 26 : n.h / 2))}" font-family="sans-serif" font-size="${n.fs}" fill="${n.tc}" text-anchor="middle" dominant-baseline="central">${esc(n.label)}</text>`);
        if (n.sub) L.push(`<text x="${r2(R.cx(n))}" y="${r2(n.y + 46)}" font-family="sans-serif" font-size="${n.fsSub}" fill="${n.tc}" text-anchor="middle" dominant-baseline="central">${esc(n.sub)}</text>`);
        L.push(`</g>`);
      } else {
        L.push(`<g>`);
        L.push(`<rect x="${r2(n.x)}" y="${r2(n.y)}" width="${r2(n.w)}" height="${r2(n.h)}" rx="8" fill="${n.fill}" stroke="${p}" stroke-width="0.8"/>`);
        L.push(`<text x="${r2(R.cx(n))}" y="${r2(n.y + (n.sub ? 26 : n.h / 2))}" font-family="sans-serif" font-size="${n.fs}" fill="${n.tc}" text-anchor="middle" dominant-baseline="central">${esc(n.label)}</text>`);
        if (n.sub) L.push(`<text x="${r2(R.cx(n))}" y="${r2(n.y + 46)}" font-family="sans-serif" font-size="${n.fsSub}" fill="${n.tc}" text-anchor="middle" dominant-baseline="central">${esc(n.sub)}</text>`);
        L.push(`</g>`);
      }
    }
    for (const e of edges) {
      const d = Seg.toPathD(e.pts);
      const extra = dialect === 'semantic' ? ` data-role="edge" data-source="${e.from}" data-target="${e.to}"` : '';
      L.push(`<path${extra} d="${d}" fill="none" stroke="${this.STROKE}" stroke-width="1.4" marker-end="url(#arw)"/>`);
    }
    L.push('</svg>');
    return L.join('\n');
  },

  /* --------------------------- 缺陷注入 ---------------------------
   * 全部在模型层做，返回真值清单 injected=[{type, target, detail}] */
  inject(model, seed, kinds) {
    const rnd = mulberry32(seed);
    const injected = [];
    const nodes = model.nodes, edges = model.edges;
    const pickNode = (pred) => {
      const c = nodes.filter(pred || (() => true));
      return c.length ? c[Math.floor(rnd() * c.length) % c.length] : null;
    };
    const has = k => kinds.indexOf(k) >= 0;

    if (has('overlap')) {
      const a = pickNode(n => n.ri === 1) || nodes[1];
      const cand = nodes.filter(n => n !== a && Math.abs(R.cy(n) - R.cy(a)) < 4);
      const b = cand.find(n => n.x > a.x) || cand[0];
      if (b) {
        const shift = -(r2(b.w) * (0.35 + rnd() * 0.25));
        b.x = r2(b.x + shift);
        injected.push({ type: 'overlap', target: b.id, detail: `${b.id} 向 ${a.id} 平移 ${r2(shift)}px` });
      }
    }
    if (has('text_overflow')) {
      const n = pickNode(x => x.sub) || pickNode();
      if (n) {
        const add = '（含实时离线双链路一致性校验与补偿）';
        n.label = n.label + add;
        injected.push({ type: 'text_overflow', target: n.id, detail: `${n.id} 标签追加 ${add.length} 字` });
      }
    }
    if (has('misalignment')) {
      /* 必须选一个「有同行兄弟」的节点，否则偏移后不构成任何可比较的对齐簇（实测漏检根因） */
      /* 偏移量必须**大于打分器的对齐容忍带**（Analyzer.alignTol = min(14, diag·0.014) ≤ 14），
       * 否则偏移后簇内离散度仍落在容忍带内，缺陷根本不会被检出（实测 3~7.5px 全部漏检）。 */
      const withSib = nodes.filter(n => n.ri >= 1 && nodes.filter(m => m.ri === n.ri).length >= 2);
      const d = 12 + rnd() * 6;
      if (withSib.length) {
        const n = withSib[Math.floor(rnd() * withSib.length) % withSib.length];
        n.y = r2(n.y + d);
        injected.push({ type: 'misalignment', target: n.id, detail: `${n.id} y 偏移 ${r2(d)}px（同排对照）` });
      } else {
        /* 单节点排的配方（layered / pipeline）：改为横向偏移，破坏 left / centerX 列对齐 */
        const stack = nodes.filter(n => n.ri >= 1);
        const n = stack.length ? stack[Math.floor(rnd() * stack.length) % stack.length] : nodes[1];
        if (n) {
          n.x = r2(n.x + d);
          injected.push({ type: 'misalignment', target: n.id, detail: `${n.id} x 偏移 ${r2(d)}px（列对齐对照）` });
        }
      }
    }
    if (has('spacing')) {
      /* 需要至少 3 个同排节点才能定义「间距一致性」，否则本注入不成立 */
      const rowsWith3 = {};
      for (const n of nodes) rowsWith3[n.ri] = (rowsWith3[n.ri] || 0) + 1;
      const ri = Object.keys(rowsWith3).find(k => rowsWith3[k] >= 3);
      const row = ri === undefined ? null : nodes.filter(n => n.ri === Number(ri));
      const last = row ? row[row.length - 1] : null;
      if (last) {
        const d = 22 + rnd() * 26;
        last.x = r2(last.x + d);
        injected.push({ type: 'spacing', target: last.id, detail: `${last.id} x 外推 ${r2(d)}px，破坏行内等距` });
      }
    }
    if (has('edge_crossing')) {
      /* AI 生成图最典型的穿节点缺陷：一条跨层直线。这里扫描所有跨层节点对，
       * 选「直线穿过的节点数最多」的那一对，保证注入一定产生可检测的穿越。 */
      let best = null;
      for (const a of nodes) for (const b of nodes) {
        if (b.ri - a.ri < 2) continue;
        const seg = [{ x: r2(R.cx(a)), y: r2(R.bottom(a)) }, { x: r2(R.cx(b)), y: r2(b.y) }];
        let hits = 0, crossed = [];
        for (const m of nodes) {
          if (m === a || m === b) continue;
          if (Seg.hitsRect(seg, { x: m.x, y: m.y, w: m.w, h: m.h }, 1) > 0) { hits++; crossed.push(m.id); }
        }
        if (!best || hits > best.hits) best = { a, b, seg, hits, crossed };
      }
      if (best && best.hits > 0) {
        const id = 'ex_cross';
        edges.push({ id, from: best.a.id, to: best.b.id, pts: best.seg });
        injected.push({ type: 'edge_crossing', id, detail: `新增跨层直线 ${best.a.id}→${best.b.id}，穿过 ${best.crossed.join(',')}` });
      } else if (best) {
        const id = 'ex_cross';
        edges.push({ id, from: best.a.id, to: best.b.id, pts: best.seg });
        injected.push({ type: 'edge_crossing', id, detail: `新增跨层直线 ${best.a.id}→${best.b.id}` });
      }
    }
    if (has('style_noise')) {
      /* 需要突破「两档字号 / 三色配色」的容忍模型才会被判为不一致：
       * 至少造出 3 种字号与 4 种填充色。 */
      const fsPool = nodes.filter(n => n.ri === 0);
      const fsPool2 = nodes.filter(n => n.ri >= 1);
      if (fsPool[0]) { fsPool[0].fs = 19; injected.push({ type: 'style_inconsistency', target: fsPool[0].id, detail: `${fsPool[0].id} 字号 → 19` }); }
      if (fsPool2[0]) { fsPool2[0].fs = 17; injected.push({ type: 'style_inconsistency', target: fsPool2[0].id, detail: `${fsPool2[0].id} 字号 → 17` }); }
      const fills = [['#F3E8FF', '#6B21A8'], ['#FEF3C7', '#92400E'], ['#FFE4E6', '#9F1239']];
      const rest = nodes.filter(n => n !== fsPool[0] && n !== fsPool2[0]).slice(0, 3);
      rest.forEach((n, i) => {
        n.fill = fills[i % fills.length][0]; n.tc = fills[i % fills.length][1];
        injected.push({ type: 'style_inconsistency', target: n.id, detail: `${n.id} 填充 → ${fills[i % fills.length][0]}` });
      });
    }
    if (has('tiny_element')) {
      const n = pickNode(x => x.ri >= 1);
      if (n) {
        n.w = 46; n.h = 24;
        injected.push({ type: 'tiny_element', target: n.id, detail: `${n.id} 缩至 46×24，标签不可读` });
      }
    }
    if (has('canvas_margin')) {
      /* 画布只比内容大一点点 → 右/下留白失衡 */
      const cb = R.union(nodes.map(x => ({ x: x.x, y: x.y, w: x.w, h: x.h })));
      model.canvasW = Math.round(R.right(cb) + 4);
      model.canvasH = Math.round(R.bottom(cb) + 4);
      injected.push({ type: 'canvas_margin', detail: `画布收紧至 ${model.canvasW}×${model.canvasH}` });
    }
    return injected;
  },

  /* --------------------------- 统一出口 --------------------------- */
  build(recipeName, seed, opts) {
    const o = Object.assign({ dialect: 'raw', defects: [], style: 'blue' }, opts || {});
    const model = this.layout(recipeName, seed);
    /* 默认样式 */
    for (const n of model.nodes) {
      const pal = this.FILLS[n.center ? 'green' : o.style] || this.FILLS.blue;
      n.fill = pal[0]; n.tc = pal[2];
      n.fs = 14;                 /* 字号统一两档：正文 14 / 副标题 12 —— 与打分器的 fontTiers 模型一致 */
      n.fsSub = 12;
    }
    const injected = this.inject(model, seed, o.defects);
    const svg = this.serialize(model, o.dialect);
    return {
      id: `${o.dialect}-${recipeName}-${o.defects.join('+') || 'clean'}-s${seed}`,
      name: `${recipeName} · ${o.dialect === 'semantic' ? '语义方言' : 'AI 原味'} · ${o.defects.length ? o.defects.length + ' 处缺陷' : '干净'}`,
      sub: `${model.nodes.length} 节点 / ${model.edges.length} 边 / seed=${seed}`,
      dialect: o.dialect, recipe: recipeName, seed, defects: o.defects.slice(), injected, model, svg,
      expectClean: o.defects.length === 0
    };
  }
};

/* 真值类型 → 打分器 issue type 的映射（用于端到端断言） */
const DEFECT_TO_ISSUE = {
  overlap: 'overlap',
  text_overflow: 'text_overflow',
  misalignment: 'misalignment',
  spacing: 'spacing',
  edge_crossing: 'edge_crossing',
  style_inconsistency: 'style_inconsistency',
  tiny_element: 'tiny_element',
  canvas_margin: 'canvas_margin'
};

/* 出厂样例表：由 UI 与端到端 harness 共用 */
const RECIPE_FOR = {
  overlap: ['layered', 'grid'],
  text_overflow: ['layered', 'grid'],
  misalignment: ['grid', 'pipeline'],
  spacing: ['grid', 'pipeline'],
  edge_crossing: ['layered', 'grid'],
  style_noise: ['layered', 'grid'],
  tiny_element: ['layered', 'grid'],
  canvas_margin: ['layered', 'pipeline']
};

function buildSampleTable() {
  const T = [];
  const D = (d) => d;
  /* 干净基线：打分器自洽性锚点 */
  T.push(Sampler.build('layered', 1, { dialect: 'raw', defects: D([]) }));
  T.push(Sampler.build('grid', 2, { dialect: 'raw', defects: D([]) }));
  T.push(Sampler.build('hub', 3, { dialect: 'raw', defects: D([]) }));
  T.push(Sampler.build('pipeline', 4, { dialect: 'raw', defects: D([]) }));
  /* 单缺陷：逐项验证「检出 → 修复」。配方按缺陷可测性配对：
   * spacing / misalignment 需要 ≥3 个同排节点，因此用 grid / pipeline。 */
  let sd = 11;
  for (const k of ['overlap', 'text_overflow', 'misalignment', 'spacing', 'edge_crossing', 'style_noise', 'tiny_element', 'canvas_margin']) {
    for (const rc of (RECIPE_FOR[k] || ['layered', 'grid'])) {
      T.push(Sampler.build(rc, sd, { dialect: 'raw', defects: D([k]) }));
      sd++;
    }
  }
  /* 混合缺陷 */
  T.push(Sampler.build('layered', 21, { dialect: 'raw', defects: D(['overlap', 'text_overflow', 'misalignment', 'spacing']) }));
  T.push(Sampler.build('grid', 22, { dialect: 'raw', defects: D(['text_overflow', 'edge_crossing', 'style_noise']) }));
  T.push(Sampler.build('pipeline', 23, { dialect: 'raw', defects: D(['overlap', 'spacing', 'canvas_margin']) }));
  T.push(Sampler.build('grid', 24, { dialect: 'raw', defects: D(['overlap', 'text_overflow', 'misalignment', 'spacing', 'edge_crossing', 'style_noise']) }));
  /* 语义方言对照：同一布局走 data-role 协议 */
  T.push(Sampler.build('layered', 31, { dialect: 'semantic', defects: D([]) }));
  T.push(Sampler.build('layered', 32, { dialect: 'semantic', defects: D(['overlap', 'text_overflow', 'spacing']) }));
  T.push(Sampler.build('grid', 33, { dialect: 'semantic', defects: D(['misalignment', 'edge_crossing', 'style_noise']) }));
  /* 真实产出图（由 .svgbuild/gen_realsvgs.py 注入）。
   * ★ 注意：这些**不是**干净件 —— 它们是 1920×1080 幻灯片式排版，天然带标题/副标题/
   *   正文/脚注 4 级字号与绝对定位装饰块，落在本打分器（面向 456×442 图谱式排版的
   *   fontTiers / 等距行列模型）的标定域之外，实测得分 58.8~70.25、issue 12~46 条。
   *   因此这里 expectClean=false，它们只承担一个职责：
   *   **「不得越改越丑」回归件** —— 任何美化必须 Δ ≥ -0.05。 */
  for (const r of (typeof REAL_SVGS !== 'undefined' ? REAL_SVGS : [])) {
    T.push({ id: r.id, name: r.name, sub: '真实图 · 标定域外（回归件：不得越改越丑）',
             dialect: 'raw', recipe: 'real', seed: 0, defects: [], injected: [],
             svg: r.svg, expectClean: false, real: true, file: r.file || '', bytes: r.bytes || 0 });
  }
  return T;
}
