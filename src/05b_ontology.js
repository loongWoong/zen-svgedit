/* =============================================================================
 * SVG Beautifier · 05b 内置本体 + 规则围栏（Ontology & Rule Fence）
 *
 * ── 为什么需要这一层（实测驱动，见 svgb_ontology_feasibility-v1.md）──
 * 现有管线是「扁平 IR + 症状检测器 + 贪心 op + 分数门」。它能看见 40 个节点，
 * 但看不见「4 条层叠 bar 是一个堆叠」「6 个卫星是一个径向组」「这条箭头锚在那个方块上」。
 * 于是 op 逐对独立地移动元素，破坏了共享导引、把方块和它的箭头拆散、把 bar 推出卡片。
 * 实测归因（.svgbuild/palantir_attr.cjs）：一轮美化让分数 +8.4（30.35→38.75），同时
 *   · 平台栈左边缘极差 211.83 → 266.1
 *   · 卡片 3 箭头错位 21.5/42.01 → 36/72
 *   · 平台栈 2 条 bar 整条跑出卡片；+3 条路径退化为零尺寸
 *   · 为消除一个 7.8px 的重叠，把一个卫星沿 x 推了 214px
 *
 * ── 三条设计纪律（都是实测结论，不是偏好）──
 * ① **几何优先**：所有事实只从几何/属性推出。实测 10 个文件里 id 可用数 = 0/582
 *    （9 个手写原稿一个 id 都没有；palantir 的 137 个 id 全是 svgcanvas 机生的 svg_\d+），
 *    class 只在 6/10 文件存在，注释通道还会被本工具自己的保存摧毁（相邻率 100%→25%，
 *    而注释正是 onto 那张图的唯一结构线索）。**唯一 10/10 可用的通道是几何。**
 *    因此本模块不读 id、不读 class、不读 XML 注释。
 * ② **约束是布尔硬门，不是加权分**：加权分会被其它维度增益抵消 —— 实测那轮 +
 *    edgeRouting +5.4 抵消了全部结构损失（把两条 1942/1957px 装饰样条压成 y=540 一条直线，
 *    同时让 5 条连线退化）。把结构量混进 WEIGHTS 会原样重演这个失败。
 * ③ **fail-closed**：置信度不足时**收窄动作集**，而不是照常输出 op。
 *
 * ── 边界 ──
 * 本层只回答「这张图的结构是什么、哪些动作会破坏它」，**不产生任何坐标**。
 * 数值真相仍在几何引擎（设计文档 §5：Laya 只回答「做什么」）。
 * ===========================================================================*/
'use strict';

const Ontology = {
  /* 全部阈值集中在此，便于定标与消融。单位：px（K 结尾的是相对系数） */
  DEF: {
    frameMinInside: 2,     /* 一个节点要被认定为「容器框」，至少需包含几个其它节点中心 */
    containPad: 12,        /* 内框余量：溢出超过它才算越界（吸收描边/圆角噪声） */
    guideTol: 2.0,         /* 「已经对齐」的容差 τ_g */
    guideIntentK: 0.12,    /* 「本应对齐」的意图容差 = 作用域短边 × k */
    guideIntentMax: 48,    /* 意图容差上限 */
    guideMin: 3,           /* 一条导引至少几个成员 */
    anchorTol: 2.0,        /* 锚点错位容差：超过才算「箭头没对准」 */
    decoOpacity: 0.3,      /* 透明度 ≤ 此值 → 装饰件（不参与重叠/重路由） */
    stackMin: 3,           /* 堆叠/成行至少几个成员 */
    sizeTolK: 0.08,        /* 同尺寸容差（相对） */
    radialMin: 4,          /* 径向组至少几个成员 */
    radialRadiusTol: 0.25, /* 径向半径相对极差上限（超过则不认作径向组） */
    confMin: 0.5,          /* 置信度下限：低于此值走 fail-closed */
    displaceK: 1.5,        /* ★ 位移上限系数：d_max = max(displaceK × 重叠量, displaceFrac × 画布短边) */
    displaceFrac: 0.06
  },

  /* --------------------------------------------------------------------------
   * 小工具
   * ------------------------------------------------------------------------ */
  num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; },
  opacityOf(el) {
    if (!el || !el.getAttribute) return 1;
    const cands = [getA(el, 'opacity', ''), getA(el, 'fill-opacity', ''), getA(el, 'stroke-opacity', '')];
    for (const c of cands) { const v = parseFloat(c); if (isFinite(v)) return v; }
    try { const v = parseFloat(cssPrio(el, 'opacity')); if (isFinite(v)) return v; } catch (e) { /* 无 CSS 上下文 */ }
    return 1;
  },
  /* fill 是否「不填充」（描边件） */
  fillNoneOf(el, fill) {
    if (!el) return false;
    const f = String(fill || getA(el, 'fill', '') || '').trim().toLowerCase();
    return !f || f === 'none' || f === 'transparent' || f === 'rgba(0, 0, 0, 0)';
  },

  /* --------------------------------------------------------------------------
   * 本体构建：事实层 + 结构层
   * 输入：IR（ir.nodes / ir.edges / ir.canvas / ir.opts）+ 分析态（an，只用于读候选）
   * 输出：本体对象（纯数据、可序列化、确定性）
   * ------------------------------------------------------------------------ */
  build(ir, an, o) {
    o = o || {};
    const D = this.DEF;
    const T = {
      frameMinInside: this.num(o.ontFrameMin, D.frameMinInside),
      containPad: this.num(o.ontContainPad, D.containPad),
      guideTol: this.num(o.ontGuideTol, D.guideTol),
      guideIntentK: this.num(o.ontGuideIntentK, D.guideIntentK),
      guideIntentMax: this.num(o.ontGuideIntentMax, D.guideIntentMax),
      guideMin: this.num(o.ontGuideMin, D.guideMin),
      anchorTol: this.num(o.ontAnchorTol, D.anchorTol),
      decoOpacity: this.num(o.ontDecoOpacity, D.decoOpacity),
      stackMin: this.num(o.ontStackMin, D.stackMin),
      sizeTolK: this.num(o.ontSizeTolK, D.sizeTolK),
      radialMin: this.num(o.ontRadialMin, D.radialMin),
      radialRadiusTol: this.num(o.ontRadialRadiusTol, D.radialRadiusTol),
      confMin: this.num(o.ontConfMin, D.confMin)
    };
    const notes = [];
    const empty = () => ({ ok: false, conf: 0, notes, frames: [], owner: Object.create(null), guides: [],
                           patterns: { stacks: [], rows: [], radials: [] }, attachments: [],
                           decorative: { nodes: [], edges: [] }, degenerate: [], stats: {
                             nodes: 0, edges: 0, frames: 0, guides: 0, guideBreaks: 0,
                             guideSpreadMax: 0, guideInfoBreaks: 0,
                             attachments: 0, attachErrMax: 0, radials: 0, stacks: 0, rows: 0,
                             decoNodes: 0, decoEdges: 0, degenerate: 0,
                             containViolations: 0, containPx: 0, unowned: 0
                           } });
    if (!ir || !ir.ok || !(ir.nodes || []).length) { notes.push('IR 为空 → 本体不可用'); return empty(); }

    const nodes = ir.nodes.filter(n => n && n.bbox && n.geomBox);
    const edges = (ir.edges || []).filter(e => e && e.pts && e.pts.length >= 2);
    const canvas = R.mk(0, 0, (ir.canvas && ir.canvas.w) || 0, (ir.canvas && ir.canvas.h) || 0);

    /* ---------- 1. 事实层：装饰件 / 退化路径 ----------
     * 装饰件判据只用「画笔画属性」，不看 class/id（纪律①）。
     * ★ 容器优先：一个包裹了多个节点中心的描边件（如卡片外框 fill=none）不是装饰，
     *   先算 insideCount，再决定谁是装饰 —— 否则会把卡片外框当装饰件排除掉。 */
    const insideCount = new Map();
    for (const n of nodes) {
      let c = 0;
      for (const m of nodes) {
        if (m === n) continue;
        if (R.has(n.geomBox, { x: R.cx(m.geomBox), y: R.cy(m.geomBox) })) c++;
      }
      insideCount.set(n.id, c);
    }
    /* 容器框只可能是**矩形类**图元。圆形/椭圆/路径是装饰环与波纹 ——
     * 实测 4 个同心装饰圆（svg_27/28/29/55）会「顺带包含」5 个节点中心，
     * 于是先被当容器框、又因「容器优先」被豁免装饰判定，凭空造出 6 条假越界。 */
    const FRAME_SHAPES = ['rect', 'polygon', 'polyline', 'image', 'use'];
    const isFrameShape = n => FRAME_SHAPES.indexOf(String(n.shape || '').toLowerCase()) >= 0;
    const decorativeNodes = [];
    for (const n of nodes) {
      /* 容器优先：矩形类容器永不算装饰。★ 判据必须带 isFrameShape，
       * 否则装饰圆会被这条豁免挡住（实测 decoNodes=0）。 */
      if (isFrameShape(n) && (insideCount.get(n.id) || 0) >= T.frameMinInside) continue;
      if (n.isBg) continue;
      const op = this.opacityOf(n.shapeElem || n.elem);
      if (op <= T.decoOpacity) { decorativeNodes.push(n.id); continue; }
      /* 描边件（fill=none）+ 无标签 + 无子 → 装饰（圆环 / 细线 / 分隔件） */
      if (this.fillNoneOf(n.shapeElem || n.elem, n.fill) && !n.labels.length && (n.strokeWidth > 0 || n.stroke)) {
        decorativeNodes.push(n.id);
      }
    }
    const decoNodeSet = new Set(decorativeNodes);
    const decorativeEdges = [];
    for (const e of edges) {
      if (this.opacityOf(e.elem) <= T.decoOpacity) decorativeEdges.push(e.id);
    }
    const decoEdgeSet = new Set(decorativeEdges);

    /* 退化路径：两端包围盒塌缩成一个点（实测 orthogonal_reroute 把 5 条连线改成 w=0,h=0）。
     * 注意「竖直/水平连线」的 w 或 h 本来就为 0，**不算退化** —— 必须两者都塌缩。 */
    const degenerate = [];
    for (const e of edges) {
      const b = R.fromPoints(e.pts);
      if (b.w < 1 && b.h < 1) { degenerate.push(e.id); continue; }
      if (Seg.len(e.pts) < 1) degenerate.push(e.id);
    }

    /* ---------- 2. 结构层：容器框（frame）与唯一归属 ----------
     * 归属唯一性由「最小包含框」规则**构造性保证**，不依赖 RegionGraph 的 members
     * （实测 RegionGraph 在 palantir 上 invariant=false、sumMembers 51 > 40 节点、
     *   r10/r11 包围盒完全相同、r6/r7 横跨两张卡片 —— 它的成员表会重复计数）。
     * ★ 容器框必须是矩形类图元（FRAME_SHAPES，见 §1）。 */
    const frameCands = nodes
      .filter(n => !n.isBg && !decoNodeSet.has(n.id) && isFrameShape(n)
                && (insideCount.get(n.id) || 0) >= T.frameMinInside)
      .sort((a, b) => (R.area(b.geomBox) - R.area(a.geomBox)) || (a.id < b.id ? -1 : 1));
    const frames = frameCands.map(n => ({ id: 'F:' + n.id, nodeId: n.id, node: n, box: n.geomBox,
                                         inner: R.expand(n.geomBox, -T.containPad), members: [] }));
    const frameById = new Map(frames.map(f => [f.id, f]));
    const owner = Object.create(null);
    for (const n of nodes) {
      let best = null;
      for (const f of frames) {
        if (f.nodeId === n.id) continue;
        if (!R.has(f.box, { x: R.cx(n.geomBox), y: R.cy(n.geomBox) })) continue;
        if (!best || R.area(f.box) < R.area(best.box)) best = f;   /* 最小包含者 = 归属 */
      }
      owner[n.id] = best ? best.id : null;
      /* members 只登记**真实内容**：装饰件与背景不参与容器成员表
       * （实测背景整幅矩形的中心必然落在容器内，不过滤就会把背景算成成员）。 */
      if (best && !decoNodeSet.has(n.id) && !n.isBg) best.members.push(n.id);
    }
    for (const f of frames) f.members.sort();
    const unowned = nodes.filter(n => !owner[n.id] && !decoNodeSet.has(n.id)).length;

    /* ---------- 3. 结构层：容器越界（containment）----------
     * 判据：节点中心落在某容器框内 → 它整框都应落在该框内（留 containPad 余量）。
     * 这正是实测缺陷的形状：卡片 4 的 Ontology bar 中心 x=1033.17 > 1010（在卡片内），
     * 但左边缘 853.17 → 溢出 156.83px；卡片 2 的星图同理溢出 429.36px。 */
    const containViolations = [];
    let containPx = 0;
    for (const n of nodes) {
      if (decoNodeSet.has(n.id) || n.isBg) continue;
      const fid = owner[n.id];
      if (!fid) continue;
      const f = frameById.get(fid);
      if (!f) continue;
      const ov = {
        l: Math.max(0, f.box.x - n.geomBox.x),
        r: Math.max(0, R.right(n.geomBox) - R.right(f.box)),
        t: Math.max(0, f.box.y - n.geomBox.y),
        b: Math.max(0, R.bottom(n.geomBox) - R.bottom(f.box))
      };
      const worst = Math.max(ov.l, ov.r, ov.t, ov.b);
      if (worst > T.containPad) {
        containPx += r2(worst);
        containViolations.push({ nodeId: n.id, frameId: fid, describe: n.describe, overflow: r2(worst), side: worst === ov.l ? 'left' : worst === ov.r ? 'right' : worst === ov.t ? 'top' : 'bottom' });
      }
    }
    containViolations.sort((a, b) => b.overflow - a.overflow);

    /* ---------- 4. 结构层：导引（guides）----------
     * 两级容差：guideTol = 「已经对齐」；意图容差 = 「本应对齐」（作用域短边 × k）。
     * 单靠紧容差聚类无法发现「4 条 bar 本该左对齐却散开 211.83px」——
     * 散得太开就永远聚不成类。所以先按意图容差聚，再把类内实际极差当作缺陷量。 */
    const AXES = [
      { axis: 'x', key: 'left', val: r => r.x },
      { axis: 'x', key: 'right', val: r => R.right(r) },
      { axis: 'x', key: 'centerX', val: r => R.cx(r) },
      { axis: 'y', key: 'top', val: r => r.y },
      { axis: 'y', key: 'bottom', val: r => R.bottom(r) },
      { axis: 'y', key: 'centerY', val: r => R.cy(r) }
    ];
    const guides = [];
    const scopeOf = n => (owner[n.id] || 'canvas');
    const scopes = new Map();
    for (const n of nodes) {
      if (decoNodeSet.has(n.id)) continue;
      const s = scopeOf(n);
      if (!scopes.has(s)) scopes.set(s, []);
      scopes.get(s).push(n);
    }
    for (const [scopeId, mem] of [...scopes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (mem.length < T.guideMin) continue;
      const f = frameById.get(scopeId);
      const shortSide = f ? Math.min(f.box.w, f.box.h) : Math.min(canvas.w, canvas.h);
      const intentTol = Math.min(T.guideIntentMax, Math.max(6, shortSide * T.guideIntentK));
      for (const A of AXES) {
        const pts = mem.map(n => ({ n, v: A.val(n.geomBox) })).sort((a, b) => (a.v - b.v) || (a.n.id < b.n.id ? -1 : 1));
        let i = 0;
        while (i < pts.length) {
          let j = i;
          while (j + 1 < pts.length && (pts[j + 1].v - pts[i].v) <= intentTol) j++;
          const grp = pts.slice(i, j + 1);
          i = Math.max(j, i + 1);
          if (grp.length < T.guideMin) continue;
          const vals = grp.map(g => g.v);
          const spread = r2(Math.max(...vals) - Math.min(...vals));
          /* 值取中位数，避免被离群者拖动 */
          const sortedV = vals.slice().sort((a, b) => a - b);
          const value = r2(sortedV[Math.floor(sortedV.length / 2)]);
          const members = grp.map(g => g.n.id).sort();
          guides.push({ scope: scopeId, axis: A.axis, key: A.key, value, spread,
                        aligned: spread <= T.guideTol, members,
                        outliers: grp.filter(g => Math.abs(g.v - value) > T.guideTol * 2).map(g => g.n.id).sort() });
        }
      }
    }
    const brokenGuides = guides.filter(g => !g.aligned);

    /* ---------- 5. 结构层：附着（attachments）----------
     * ★ 必须**自己**解附着，不能信 IR 的 e.source/e.target。
     *   实测本文件 13 条边的 26 个端点**全部**被判给 n14 —— 那是整幅背景 rect
     *   `(0,0,1920,1080)`，它包含每一个端点，点到框距离恒为 0，最近节点永远是它。
     *   于是 `e.attached` 恒真、附着信息完全不可用（这是 IR 的一个真实缺陷，登记为 F7）。
     *   本层改为在**排除背景/容器**后重新求最近节点，再量化**锚点错位** ——
     *   端点没对准锚点形状的中心轴。后者正是实测的「箭头与上方方块对齐不够精确」：
     *   卡片 3 的箭头 x=228/490/752，方块中心 x=228/469/710 → 错位 0 / 21 / 42px。 */
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const attachTol = this.num(o.ontAttachTol, IR.DEF.portSlack);
    const attachCand = nodes.filter(n => !n.isBg && !decoNodeSet.has(n.id) && n.role !== 'container');
    /* ★ 必须是「贴到**边界**」才算附着，不能只看「在框内」。
     *   在框内的点对整框距离恒为 0，于是任何**终止在容器内部空处**的连线都会被
     *   算成锚在容器上（实测：合成图里两支不到底的箭头的下端落在卡片内部空处，
     *   被算成锚在卡片上，凭空多出 2 条 err=0 的假附着）。
     *   这也是「背景整幅矩形抢走全部端点」的同一类错误的通用形态。 */
    const distToEdge = (p, b) => {
      const dx = Math.max(b.x - p.x, 0, p.x - R.right(b));
      const dy = Math.max(b.y - p.y, 0, p.y - R.bottom(b));
      if (dx === 0 && dy === 0) return Math.min(p.x - b.x, R.right(b) - p.x, p.y - b.y, R.bottom(b) - p.y);
      return Math.hypot(dx, dy);
    };
    /* 距离相同（端点落在框线上）时取**面积最小**者 —— 否则大容器永远赢 */
    const resolveAttach = p => {
      let best = null;
      for (const n of attachCand) {
        const d = distToEdge(p, n.geomBox);
        if (d > attachTol) continue;
        if (!best || d < best.d - 1e-6
            || (Math.abs(d - best.d) <= 1e-6 && R.area(n.geomBox) < R.area(best.n.geomBox))) best = { n, d };
      }
      return best;
    };
    const attachments = [];
    for (const e of edges) {
      /* 装饰边的端点没有锚定语义 —— 它是一条波纹/样条扫过画面，
       * 端点落点纯属巧合（实测 e15/e16 扫过容器侧边 → 假错位 365–395px）。 */
      if (decoEdgeSet.has(e.id)) continue;
      const ends = [{ end: 'source', p: e.pts[0] }, { end: 'target', p: e.pts[e.pts.length - 1] }];
      let prevNode = null;
      for (const en of ends) {
        if (!en.p) continue;
        const hit = resolveAttach(en.p);
        if (!hit) continue;
        /* 两端落在同一节点上 = 这条线没有连接两个形状（自环/经过），只记一端 */
        if (prevNode && hit.n.id === prevNode) continue;
        const n = hit.n, b = n.geomBox;
        prevNode = n.id;
        /* ★ 贴边判定必须用「离哪条边最近」，不能用区间包含：
         *   端点落在底边上时，它同时满足 inX 与 inY（y 正好等于底边），
         *   旧写法 `inX && !inY` 会把它判成角点 → err=0 → 实测 21/42px 错位全部漏掉。 */
        const ST = 2;
        const onVert = (Math.abs(en.p.y - b.y) <= ST || Math.abs(en.p.y - R.bottom(b)) <= ST)
                    && en.p.x >= b.x - ST && en.p.x <= R.right(b) + ST;
        const onHorz = (Math.abs(en.p.x - b.x) <= ST || Math.abs(en.p.x - R.right(b)) <= ST)
                    && en.p.y >= b.y - ST && en.p.y <= R.bottom(b) + ST;
        let err = 0, kind = 'corner';
        if (onVert && !onHorz) { err = Math.abs(en.p.x - R.cx(b)); kind = 'vertical'; }
        else if (onHorz && !onVert) { err = Math.abs(en.p.y - R.cy(b)); kind = 'horizontal'; }
        /* 合理性上限用 **min(w,h)**：连接线只能相对「紧凑的方框」谈对齐，
         * 对上一根长条（底座 772×58）时端点本来就该分散落位 ——
         * 用 max 会把「三条箭头扇形汇入底座」误判成 262px 错位（实测）。 */
        const plausible = err <= 0.5 * Math.min(b.w, b.h);
        attachments.push({ edge: e.id, end: en.end, nodeId: n.id, dist: r2(hit.d),
                           kind, err: r2(err), plausible,
                           misaligned: err > T.anchorTol && plausible,
                           px: r2(en.p.x), py: r2(en.p.y) });
      }
    }
    const badAnchors = attachments.filter(a => a.misaligned);
    /* 只统计**可信**的错位：不可信的（线只是经过该节点）不计入不变量，
     * 否则「三条箭头扇形汇入底座」会把 attachErrMax 顶到 262px（实测）。 */
    const attachErrMax = attachments.reduce((m, a) => Math.max(m, a.plausible ? a.err : 0), 0);

    /* ---------- 6. 结构层：模式（堆叠 / 成行 / 径向）----------
     * 模式的作用是**实例化约束**：单靠紧容差聚类发现不了「本该对齐」，
     * 必须先认出「这一组是同一列里的层叠条」，才能断言它们应当共享左边缘。 */
    /* 容器框本身不是「内容」，不参与模式识别 —— 否则四张尺寸全等的卡片
     * 会互相被认成「一行」或「一列」（它们确实是完美网格，但那是容器网格，不是内容节奏）。 */
    const frameNodeIds = new Set(frames.map(f => f.nodeId));
    const visible = nodes.filter(n => !decoNodeSet.has(n.id) && !n.isBg && !frameNodeIds.has(n.id));
    const patterns = { stacks: [], rows: [], radials: [] };
    const sizeClose = (a, b, k) => Math.abs(a - b) <= k * Math.max(1, Math.max(a, b));
    /* ★ 必须在**作用域内**扫描，不能全局排序：卡片 4 的 4 条 bar 与卡片 3 的方块
     *   纵向交错，全局按 y 排序会被交错打断，永远凑不出这一列。 */
    const scopeMembers = new Map();
    for (const n of visible) {
      const s = owner[n.id] || 'canvas';
      if (!scopeMembers.has(s)) scopeMembers.set(s, []);
      scopeMembers.get(s).push(n);
    }
    /* ★ 还必须按**尺寸分档**，再在档内找连续段。
     *   实测教训：卡片 4 的 4 条 bar 之间插着两个 120×36 的反馈标签（y=706/714），
     *   不分类就会把这一列切成 [n72,n70] 与 [n68,n66] 两段（各 2 个 < stackMin），
     *   于是「左边缘本该对齐却散开 211.83px」完全不可见（stacks=0）。 */
    const sizeClasses = (list, ax, ay) => {
      const cls = [];
      for (const n of list) {
        const w = ax ? n.geomBox.w : n.geomBox.h;
        const h = ay ? n.geomBox.h : n.geomBox.w;
        let hit = null;
        for (const c of cls) if (sizeClose(w, c.w, T.sizeTolK) && sizeClose(h, c.h, T.sizeTolK)) { hit = c; break; }
        if (!hit) { hit = { w, h, items: [] }; cls.push(hit); }
        hit.items.push(n);
      }
      return cls.filter(c => c.items.length >= T.stackMin);
    };
    const firstById = (a, b) => (a.id < b.id ? -1 : 1);
    for (const sid of [...scopeMembers.keys()].sort((a, b) => (a < b ? -1 : 1))) {
      const mem = scopeMembers.get(sid);
      if (mem.length < T.stackMin) continue;
      /* 堆叠：同尺寸类内、同一列里按 y 相接的成员 */
      for (const c of sizeClasses(mem, true, true)) {
        const sy = c.items.slice().sort((a, b) => (a.geomBox.y - b.geomBox.y) || firstById(a, b));
        let run = [];
        for (const n of sy) {
          if (!run.length) { run = [n]; continue; }
          const prev = run[run.length - 1];
          const band = Math.min(R.right(n.geomBox), R.right(run[0].geomBox)) - Math.max(n.geomBox.x, run[0].geomBox.x);
          const vGap = n.geomBox.y - R.bottom(prev.geomBox);
          /* 带相交只要「有重叠」（不是 50%）：被打散后的列本来就只重叠 41%。
           * 纵向相接允许小负值 —— 层叠 bar 本来就可能轻微压边（实测 vGap = 12 / 0 / 24）。 */
          const contiguous = vGap > -0.5 * Math.min(n.geomBox.h, prev.geomBox.h)
                          && vGap <= Math.max(40, 1.5 * Math.min(n.geomBox.h, prev.geomBox.h));
          if (band > 0.15 * Math.min(n.geomBox.w, run[0].geomBox.w) && contiguous) run.push(n);
          else { if (run.length >= T.stackMin) patterns.stacks.push(this._seq(run, 'y', T)); run = [n]; }
        }
        if (run.length >= T.stackMin) patterns.stacks.push(this._seq(run, 'y', T));
      }
      /* 成行：镜像逻辑 */
      for (const c of sizeClasses(mem, true, true)) {
        const sx = c.items.slice().sort((a, b) => (a.geomBox.x - b.geomBox.x) || firstById(a, b));
        let rrow = [];
        for (const n of sx) {
          if (!rrow.length) { rrow = [n]; continue; }
          const prev = rrow[rrow.length - 1];
          const band = Math.min(R.bottom(n.geomBox), R.bottom(rrow[0].geomBox)) - Math.max(n.geomBox.y, rrow[0].geomBox.y);
          const hGap = n.geomBox.x - R.right(prev.geomBox);
          const contiguous = hGap > -0.5 * Math.min(n.geomBox.w, prev.geomBox.w)
                          && hGap <= Math.max(40, 1.5 * Math.min(n.geomBox.w, prev.geomBox.w));
          if (band > 0.15 * Math.min(n.geomBox.h, rrow[0].geomBox.h) && contiguous) rrow.push(n);
          else { if (rrow.length >= T.stackMin) patterns.rows.push(this._seq(rrow, 'x', T)); rrow = [n]; }
        }
        if (rrow.length >= T.stackMin) patterns.rows.push(this._seq(rrow, 'x', T));
      }
    }
    /* 径向：在一个作用域内，围绕该作用域中心的**同尺寸卫星**成员。
     * ★ 三道限制缺一不可（实测：不加就出 6 个垃圾径向组、成员 20 个、半径极差 366）：
     *   ① 只取「相对作用域很小」的成员 —— 否则卡片/大容器本身也进来；
     *   ② **同尺寸**成组 —— 径向组的成员是同级卫星，尺寸应当一致。
     *      这条是决定性的：卡片 2 里卫星(36px) 与 需求/App/FDE(56/50/48px) 到卡片中心的
     *      距离相近，只按半径分档会把它们混成 8 个成员、理想步长降到 45°，反而判不出径向；
     *      按尺寸分档后正好留下 6 个卫星（实测半径 127–154.8、角间隔 44.9°–70.0°）。
     *   ③ 角度要大致铺满（任一步长 ≤ 1.4 × 理想步长）。 */
    for (const sid of [...scopeMembers.keys()].sort((a, b) => (a < b ? -1 : 1))) {
      const mem = scopeMembers.get(sid);
      if (mem.length < T.radialMin) continue;
      const f = frameById.get(sid);
      const c = f ? { x: R.cx(f.box), y: R.cy(f.box) } : { x: R.cx(canvas), y: R.cy(canvas) };
      const shortSide = f ? Math.min(f.box.w, f.box.h) : Math.min(canvas.w, canvas.h);
      const maxDim = 0.35 * shortSide;
      const cand = mem.filter(n => Math.max(n.geomBox.w, n.geomBox.h) <= maxDim
                                && Math.hypot(R.cx(n.geomBox) - c.x, R.cy(n.geomBox) - c.y) > 1);
      if (cand.length < T.radialMin) continue;
      let best = null;
      for (const anchor of cand) {
        const dim = Math.max(anchor.geomBox.w, anchor.geomBox.h);
        const grp0 = cand.filter(n => sizeClose(Math.max(n.geomBox.w, n.geomBox.h), dim, T.sizeTolK));
        if (grp0.length < T.radialMin) continue;
        const withR = grp0.map(n => ({ n, r: Math.hypot(R.cx(n.geomBox) - c.x, R.cy(n.geomBox) - c.y),
                                       a: Math.atan2(R.cy(n.geomBox) - c.y, R.cx(n.geomBox) - c.x) }));
        const rs = withR.map(w => w.r).slice().sort((a, b) => a - b);
        const medR = rs[Math.floor(rs.length / 2)];
        const grp = withR.filter(w => Math.abs(w.r - medR) <= T.radialRadiusTol * Math.max(1, medR));
        if (grp.length < T.radialMin) continue;
        /* ③ 角度铺满：任一步长不得超过 1.4 × 理想步长 */
        const ideal = 360 / grp.length;
        const aSorted = grp.map(g => g.a * 180 / Math.PI).sort((a, b) => a - b);
        const st = [];
        for (let i = 1; i < aSorted.length; i++) st.push(aSorted[i] - aSorted[i - 1]);
        st.push(aSorted[0] + 360 - aSorted[aSorted.length - 1]);
        if (Math.max(...st) > ideal * 1.4) continue;
        if (!best || grp.length > best.grp.length) best = { grp, st, ideal, aSorted, medR };
      }
      if (!best) continue;
      const g2 = best.grp.map(g => g.r);
      patterns.radials.push({
        scope: sid,
        center: { x: r2(c.x), y: r2(c.y) },
        members: best.grp.map(g => g.n.id).sort(),
        radii: best.grp.map(g => r2(g.r)).sort((a, b) => a - b),
        radiusSpread: r2(Math.max(...g2) - Math.min(...g2)),
        angles: best.aSorted.map(a => r2(a)),
        angleSteps: best.st.map(s => r2(s)),
        idealStep: r2(best.ideal),
        angleDevMax: r2(Math.max(...best.st.map(s => Math.abs(s - best.ideal))))
      });
    }

    /* ---------- 7. 置信度（fail-closed 的依据）----------
     * 置信度 = 结构证据的可判程度。它**不是**质量分，只回答「该不该信这一层」。 */
    /* ★「断裂导引」只按**模式**判定，不按松容差聚类判定。
     *   实测教训：星状图成员本来就不该轴对齐，按聚类判定会报出 24 条假断裂
     *   （卡片 2 一条就占 10 条），而真正该报的「4 条 bar 左边缘散开 211.83px」
     *   反而因为散得太开聚不成类而漏报。模式已经实例化了约束
     *   （「这一组本该共享左边缘」），于是断裂 = 模式领边散开。 */
    const patternBreaks = [];
    let patternSpreadMax = 0;
    for (const s of patterns.stacks.concat(patterns.rows)) {
      const sp = (s.lead && s.lead.spread) || 0;
      patternSpreadMax = Math.max(patternSpreadMax, sp);
      if (sp > T.anchorTol * 4) patternBreaks.push({ axis: s.axis, key: s.lead.key, spread: sp, members: s.members });
    }
    let conf = 0.5;
    if (nodes.length >= 6) conf += 0.15;
    if (frames.length) conf += 0.15;
    else conf -= 0.2;
    if (R.area(canvas) > 0) conf += 0.1;
    if (nodes.length && unowned / nodes.length < 0.5) conf += 0.1;
    if (edges.length && attachments.length === 0) conf -= 0.15;   /* 有连线却一条都锚不上 = 几何可疑 */
    conf = clamp(r2(conf), 0, 1);

    const ont = {
      ok: true, conf, notes, canvas,
      frames, owner, guides, patterns, attachments, patternBreaks,
      decorative: { nodes: decorativeNodes.sort(), edges: decorativeEdges.sort() },
      degenerate, containViolations,
      nodeById,
      stats: {
        nodes: nodes.length, edges: edges.length, frames: frames.length,
        guides: guides.length, guideInfoBreaks: brokenGuides.length,
        guideBreaks: patternBreaks.length, guideSpreadMax: r2(patternSpreadMax),
        attachments: attachments.length, attachErrMax: r2(attachErrMax), badAnchors: badAnchors.length,
        radials: patterns.radials.length, stacks: patterns.stacks.length, rows: patterns.rows.length,
        decoNodes: decorativeNodes.length, decoEdges: decorativeEdges.length,
        degenerate: degenerate.length,
        containViolations: containViolations.length, containPx: r2(containPx), unowned
      }
    };
    if (frames.length === 0) notes.push('未识别出任何容器框 → 容器契约不适用');
    if (unowned) notes.push(`${unowned} 个节点不在任何容器框内（归画布）`);
    if (conf < T.confMin) notes.push(`结构置信度 ${conf} < ${T.confMin} → 围栏按 fail-closed 收窄动作集`);
    return ont;
  },

  _seq(run, axis, T) {
    const vals = run.map(n => axis === 'y' ? n.geomBox.y : n.geomBox.x);
    const gaps = [];
    for (let i = 1; i < vals.length; i++) gaps.push(r2(vals[i] - vals[i - 1]));
    const sizes = run.map(n => axis === 'y' ? n.geomBox.h : n.geomBox.w);
    return {
      axis, members: run.map(n => n.id).sort(),
      lead: { key: axis === 'y' ? 'left' : 'top', spread: r2(Math.max(...run.map(n => axis === 'y' ? n.geomBox.x : n.geomBox.y)) - Math.min(...run.map(n => axis === 'y' ? n.geomBox.x : n.geomBox.y))) },
      gaps,
      gapCv: (() => { const m = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
                      const v = gaps.reduce((a, g) => a + (g - m) * (g - m), 0) / Math.max(1, gaps.length);
                      return m > 0 ? r2(Math.sqrt(v) / m) : 0; })(),
      sizeSpread: r2(Math.max(...sizes) - Math.min(...sizes))
    };
  },

  /* --------------------------------------------------------------------------
   * 不变量：全部是「越小越好」，且**单调可判**（用于硬门，不参与打分）
   * ------------------------------------------------------------------------ */
  invariants(ont, an) {
    const s = (ont && ont.stats) || {};
    let depth = 0;
    const pairs = (an && an.raw && an.raw.collision && an.raw.collision.pairs) || [];
    for (const p of pairs) depth = Math.max(depth, this.num(p.depth, 0));
    const cv = (ont && ont.canvas) || R.mk(0, 0, 1920, 1080);
    return {
      containViolations: this.num(s.containViolations, 0),
      containPx: this.num(s.containPx, 0),
      guideBreaks: this.num(s.guideBreaks, 0),
      guideSpreadMax: this.num(s.guideSpreadMax, 0),
      guideInfoBreaks: this.num(s.guideInfoBreaks, 0),
      attachErrMax: this.num(s.attachErrMax, 0),
      badAnchors: this.num(s.badAnchors, 0),
      edgeDegeneracy: this.num(s.degenerate, 0),
      decoNodes: this.num(s.decoNodes, 0),
      decoEdges: this.num(s.decoEdges, 0),
      confidence: this.num(ont && ont.conf, 0),
      /* ★ 位移上限：max(1.5 × 当前最大重叠量, 0.06 × 画布短边)。
       * 实测依据：为消除 7.8px 重叠曾被位移 214px（27 倍）。本式给出 max(11.7, 64.8) = 64.8px。 */
      dMax: r2(Math.max(this.DEF.displaceK * depth, this.DEF.displaceFrac * Math.min(cv.w || 1920, cv.h || 1080)))
    };
  },

  /* --------------------------------------------------------------------------
   * 规则表：声明式。每条规则只回答「哪些动作会破坏本图的结构」。
   * effect 形态：
   *   forbid: ['issueType|strategy', ...]   禁止这批动作
   *   force:  { 'strategy_<type>': key }    强制改选（沿决策层已排好的顺位）
   *   gate:   { safeAll:false }             收紧后再进几何引擎
   *   note:   触发说明（会进决策台账，可审计）
   * kind='work' 的规则不产生动作，只报告缺口（供后续实现新策略）
   * ------------------------------------------------------------------------ */
  RULES: [
    {
      id: 'displace_cap', cn: '位移上限', severity: 'high', kind: 'cap',
      /* 触发：任何重叠问题都存在 —— 上限本身由几何引擎在 separation() 里执行 */
      when(ont, an, T) {
        const pairs = (an && an.raw && an.raw.collision && an.raw.collision.pairs) || [];
        if (!pairs.length) return null;
        let depth = 0, worst = null;
        for (const p of pairs) if (Ontology.num(p.depth, 0) > depth) { depth = Ontology.num(p.depth, 0); worst = p; }
        const cv = ont.canvas || R.mk(0, 0, 1920, 1080);
        const dMax = Math.max(Ontology.DEF.displaceK * depth, Ontology.DEF.displaceFrac * Math.min(cv.w || 1920, cv.h || 1080));
        /* 只在「存在被过度修正的风险」时提示：候选位移若远超重叠量级 */
        const need = worst && worst.aRef ? Math.max(worst.aRef.geomBox.w, worst.aRef.geomBox.h) : 0;
        return { depth: r2(depth), dMax: r2(dMax), need: r2(need) };
      },
      reason(e) { return `最大重叠 ${e.depth}px → 位移上限 ${e.dMax}px（实测曾有 7.8px 重叠被位移 214px）`; }
    },
    {
      id: 'attach_guard', cn: '附着跟随围栏', severity: 'high', kind: 'forbid',
      /* 触发：**本图**存在「锚定形状被带连接体的策略移动」的风险。
       * 现有引擎移动形状时只带标签（applyTranslate 只跟随 n.labels），**不搬连接体**，
       * 实测把卡片 3 的箭头错位从 21.5/42.01px 恶化到 36/72px。
       * 因此在这些形状被移动类策略命中时，禁止该策略 —— 直到附着跟随真正实现。 */
      when(ont, an, T) {
        if (!ont.attachments.length) return null;
        const anchored = new Set(ont.attachments.map(a => a.nodeId));
        const hits = [];
        for (const type of ['spacing', 'overlap']) {
          for (const it of ((an && an.issues) || [])) {
            if (it.type !== type) continue;
            const inter = (it.targets || []).filter(t => anchored.has(t));
            if (inter.length) hits.push({ type, targets: inter });
          }
        }
        if (!hits.length) return null;
        const byType = {};
        for (const h of hits) byType[h.type] = (byType[h.type] || 0) + 1;
        return { byType, anchored: anchored.size };
      },
      forbid: () => ['spacing|distribute_equal', 'spacing|distribute_weighted', 'spacing|grow_spacing', 'overlap|move_apart'],
      reason(e) { return `「${Object.keys(e.byType).join('/')}」将移动 ${e.anchored} 个带连接体的形状；`
                       + `而 applyTranslate 不搬连接体（实测箭头错位 21.5→36 / 42.01→72）→ 禁止移动类策略`; }
    },
    {
      id: 'deco_edge_guard', cn: '装饰边保护', severity: 'high', kind: 'forbid',
      /* 触发：edge_crossing 的候选里含装饰路径（透明度 ≤ 0.3 / 淡色波纹）。
       * 实测：orthogonal_reroute 把两条 1942/1957px 样条压成 y=540 的贯穿直线，
       * 代价换回 +5.4 分 —— 全轮 64% 的增益来自这个破坏性动作。 */
      when(ont, an, T) {
        if (!ont.decorative.edges.length) return null;
        const deco = new Set(ont.decorative.edges);
        for (const it of ((an && an.issues) || [])) {
          if (it.type !== 'edge_crossing') continue;
          const inter = (it.targets || []).filter(t => deco.has(t));
          if (inter.length) return { edges: inter };
        }
        return null;
      },
      forbid: () => ['edge_crossing|orthogonal_reroute'],
      reason(e) { return `候选含 ${e.edges.length} 条装饰路径（透明度 ≤ ${Ontology.DEF.decoOpacity}）→ 禁止重路由（会把装饰样条压成直线）`; }
    },
    {
      id: 'contain_guard', cn: '容器契约围栏', severity: 'medium', kind: 'forbid',
      /* 触发：已有元素越出容器（实测卡片 4 两条 bar 整条在外、卡片 2 溢出 429px）。
       * 在这种图上做整体重排/画布重平衡风险最高 —— 先把动作集收窄到局部修正。 */
      when(ont, an, T) {
        const bad = ont.containViolations;
        if (!bad.length) return null;
        return { count: bad.length, px: Ontology.num(ont.stats.containPx, 0),
                 worst: bad[0] ? `${bad[0].describe} 越出 ${bad[0].side} ${bad[0].overflow}px` : '' };
      },
      forbid: () => ['overlap|global_relayout', 'canvas_margin|rebalance_canvas'],
      gate: () => ({ safeAll: false }),
      reason(e) { return `${e.count} 个元素越出所属容器（合计 ${e.px}px，最严重：${e.worst}）→ 禁止整体重排/画布重平衡，且不触碰 critical 项`; }
    },
    {
      id: 'pattern_gap', cn: '节奏缺口（仅报告）', severity: 'low', kind: 'work',
      /* 只报告，不动作：现有引擎没有「按模式重排」的策略。
       * 这条规则的作用是把缺口记进台账，为后续新增策略提供依据。 */
      when(ont, an, T) {
        const bad = [];
        for (const seq of ont.patterns.stacks.concat(ont.patterns.rows)) {
          /* 领边散开 = 本该对齐却没对齐；只在超过锚点容差时报 */
          if (seq.lead && seq.lead.spread > T.anchorTol * 4) bad.push({ axis: seq.axis, kind: 'lead', spread: seq.lead.spread, n: seq.members.length });
          if (seq.gapCv > 0.15 && seq.gaps.some(g => g > 8)) bad.push({ axis: seq.axis, kind: 'gap', cv: seq.gapCv, n: seq.members.length });
        }
        for (const r of ont.patterns.radials) {
          if (r.angleDevMax > r.idealStep * 0.2) bad.push({ axis: 'radial', kind: 'angle', dev: r.angleDevMax, ideal: r.idealStep, n: r.members.length });
        }
        return bad.length ? { count: bad.length, first: bad[0] } : null;
      },
      reason(e) { return `${e.count} 处模式节奏缺口（${e.first.axis}/${e.first.kind}），现有策略集无法修复 → 仅记录`; }
    },
    {
      id: 'low_conf', cn: '低置信度收窄', severity: 'medium', kind: 'forge',
      when(ont, an, T) { return ont.conf < T.confMin ? { conf: ont.conf } : null; },
      forbid: () => ['overlap|global_relayout'],
      gate: () => ({ safeAll: false }),
      reason(e) { return `结构置信度 ${e.conf} 低于下限 → fail-closed：禁止整体重排、不触碰 critical 项`; }
    }
  ],

  /* --------------------------------------------------------------------------
   * 围栏：把本体+规则施加到 Laya 的决策结果上
   *
   * 设计对齐既有架构：05_laya.js 已有的后置门禁（should_relayout 为假时从 ranks 里
   * 摘掉 global_relayout）就是同一形态。本函数沿用「改 applied、留痕迹」的做法，
   * 因此几何引擎（Geo.plan 读 dec.applied['strategy_<type>'].choice）**无需改动**。
   *
   * 副作用是刻意的：它只**收窄**动作集，绝不新增动作 —— 这是 fail-closed 的实现方式。
   * ------------------------------------------------------------------------ */
  fence(ir, an, applied, gate, o) {
    const o2 = o || {};
    const T = { confMin: this.num(o2.ontConfMin, this.DEF.confMin) };
    /* ★ 默认**顾问模式**（advisory）：只报告规则命中，不改动作集。
     * 为什么默认不强制 —— 实测定价（.svgbuild/rule_price.cjs、palantir_value.cjs）：
     *   · 36 份语料：强制围栏总分代价 −22.35，而不变量改善只有 1 份样本的 6.5px；
     *     逐规则定价显示 100% 的代价来自 attach_guard，其余规则代价为 0。
     *   · 目标文件 palantir：强制围栏代价 −11.00 分，且**结构不变量全部变差**
     *     （containPx 128→253.71、guideSpreadMax 183→211.83、attachErrMax 36→42.01）——
     *     因为它把 5 个被接受的动作全挡掉了（0 accepted），而正是这些动作在修复几何
     *     （开围栏时输出确实优于输入：253.71→128、211.83→183、42.01→36）。
     * 结论：「美化在本图上会破坏结构」这个前提在**当前代码 + 本文件**上不成立。
     * 因此强制门必须逐条定价后再开，默认只做事实与规则的呈现。
     * 开启方式：sopt.ontEnforce = true。 */
    const enforce = o2.ontEnforce === true;
    const trace = { ok: true, mode: enforce ? 'enforce' : 'advisory', conf: 0, fired: [], blocked: [],
                    gates: [], notes: [], ont: null, inv: null };
    if (o2.ontOff) { trace.notes.push('本体围栏被显式关闭（ontOff）'); return trace; }
    let ont;
    try { ont = this.build(ir, an, o2); }
    catch (e) { trace.ok = false; trace.notes.push('本体构建异常 → 围栏整体放行（不因本体报错而阻断修复）：' + (e && e.message ? e.message : String(e))); return trace; }
    if (!ont.ok) { trace.ok = false; trace.notes.push('本体不可用 → 围栏整体放行'); return trace; }
    trace.ont = ont;
    trace.conf = ont.conf;
    const inv = this.invariants(ont, an);
    trace.inv = inv;
    for (const n of ont.notes) trace.notes.push(n);

    const gateOut = Object.assign({}, gate || {});
    const forbid = new Set();
    /* 逐规则消融：o.ontOffRules = ['attach_guard', ...] 用于定标，
     * 只有**代价与收益都量过**的规则才允许留在生效集里。 */
    const offRules = Array.isArray(o2.ontOffRules) ? new Set(o2.ontOffRules) : new Set();
    for (const R0 of this.RULES) {
      if (offRules.has(R0.id)) { trace.notes.push(`规则 ${R0.id} 被消融关闭`); continue; }
      let ev = null;
      try { ev = R0.when(ont, an, T); } catch (e) { ev = null; }
      if (!ev) continue;
      const rec = { id: R0.id, cn: R0.cn, kind: R0.kind, severity: R0.severity,
                    reason: (() => { try { return R0.reason ? R0.reason(ev) : ''; } catch (e) { return ''; } })(),
                    effect: ev };
      if (R0.forbid && enforce) for (const k of R0.forbid(ev)) { forbid.add(k); rec.blocked = (rec.blocked || []).concat(k); }
      if (R0.gate && enforce) { const g = R0.gate(ev); Object.assign(gateOut, g); trace.gates.push({ id: R0.id, set: g }); }
      if (R0.kind === 'cap') rec.cap = { dMax: inv.dMax };
      trace.fired.push(rec);
    }
    /* 位移上限：几何引擎自行读取（见 06_geometry.js separation 的本体段落）。
     * 这里把它写进 gate，便于台账与测试断言。 */
    gateOut.dMax = inv.dMax;
    gateOut.ontology = { conf: ont.conf, stats: ont.stats };

    /* ---- 施加：收窄 ranks，并让 choice 沿顺位落回合法项 ---- */
    if (enforce && forbid.size) {
      for (const qid of Object.keys(applied)) {
        if (qid.indexOf('strategy_') !== 0) continue;
        const rec = applied[qid];
        if (!rec || !rec.ranks) continue;
        const before = rec.ranks.length;
        rec.ranks = rec.ranks.filter(x => !forbid.has(qid.replace('strategy_', '') + '|' + x.key));
        if (rec.ranks.length === before) continue;
        const type = qid.replace('strategy_', '');
        const legal = rec.ranks.map(x => x.key);
        trace.blocked.push({ qid, type, removed: before - rec.ranks.length, legal });
        if (!legal.length) {
          /* 全被禁 → 该类本轮放弃（几何引擎看到空 ranks 会走 skipped） */
          rec.choice = null;
          rec.fence = { blocked: true, rule: trace.fired.filter(r => r.blocked).map(r => r.id) };
          continue;
        }
        if (legal.indexOf(rec.choice) < 0) {
          const old = rec.choice;
          rec.choice = legal[0];
          rec.fence = { blocked: true, from: old, to: rec.choice, source: rec.source, rule: trace.fired.filter(r => r.blocked).map(r => r.id) };
          /* 若原选择来自模型/mix，被围栏否决后回退来源必须如实记为 rule */
          rec.source = 'fence';
        } else {
          rec.fence = { blocked: false, rule: trace.fired.filter(r => r.blocked).map(r => r.id) };
        }
      }
    }
    /* ---- 通用归一：choice 必须仍然落在 ranks 内 ----
     * 覆盖既有后置门禁的缺口：05_laya 只把 global_relayout 从 ranks 里摘掉，
     * 却不改 choice —— 于是「不该整体重排」的图上仍会按 global_relayout 出 op。
     * 顺带保证本围栏的替换结果不会指向一个已被禁掉的策略。
     * 用 o.ontNormalize === false 可单独消融本步（定标用）。
     * 与强制门一同挂在 enforce 下：顾问模式保证**完全不改动作集**。 */
    if (enforce && o2.ontNormalize !== false) {
      for (const qid of Object.keys(applied)) {
        if (qid.indexOf('strategy_') !== 0) continue;
        const rec = applied[qid];
        if (!rec || !rec.ranks || !rec.ranks.length || rec.choice == null) continue;
        if (rec.ranks.some(x => x.key === rec.choice)) continue;
        const old = rec.choice;
        rec.choice = rec.ranks[0].key;
        rec.fence = Object.assign({}, rec.fence || {}, { normalized: true, from: old, to: rec.choice });
        if (rec.source === 'rule') rec.source = 'fence';
        trace.blocked.push({ qid, type: qid.replace('strategy_', ''), removed: 0,
                            legal: rec.ranks.map(x => x.key), normalizedFrom: old });
      }
    }
    if (!trace.blocked.length) trace.notes.push('围栏未触任何动作（本图未命中规则）');
    trace.gate = gateOut;
    return trace;
  },

  /* 人类可读摘要（台账/UI 用） */
  summary(trace) {
    if (!trace || !trace.ok) return '本体围栏：不可用（已放行）';
    const s = (trace.ont && trace.ont.stats) || {};
    const parts = [`置信度 ${trace.conf}`,
      `容器 ${s.frames}`, `导引 ${s.guides}（断裂 ${s.guideBreaks}）`,
      `附着 ${s.attachments}（错位 ${s.badAnchors}，最大 ${s.attachErrMax}px）`,
      `径向组 ${s.radials}`, `装饰 ${s.decoNodes}/${s.decoEdges}`, `退化 ${s.degenerate}`,
      `越界 ${s.containViolations}（${s.containPx}px）`, `位移上限 ${trace.gate ? trace.gate.dMax : '—'}px`];
    return '本体围栏：' + parts.join(' · ');
  }
};
