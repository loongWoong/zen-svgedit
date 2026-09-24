/* =============================================================================
 * tests/diag_batch.cjs —— 「批量应用 vs canvasTail」碰撞塌陷的机制定位探针（只读）
 *
 * 症状（本体图 real-onto_platform，rule 臂）：
 *   gateKey = text_overflow|move_text              （一批 10 个 op）
 *   gateKey = style_inconsistency|normalize_style  （一批 24 个 op）
 *   整批应用后 metrics.collision 96 → 0，Δscore ≈ −25 → 被 op 级门整批淘汰。
 *
 * 两个互斥候选：
 *   (A) op 之间互相打架（batch mutual interference）
 *   (B) 批内 Geo.canvasTail 的副作用（整幅平移 / setResolution 扩画布）
 *
 * ★ 关键提醒：metrics.collision 不是纯 node-vs-node ——
 *   04_analyzer.js:57   metrics.collision = sc(raw.collision.density + raw.occlusion.density, collSat)
 *   04_analyzer.js:149  raw.occlusion.density = clamp(Σ max(cover,0.25), 0, 1)
 *   所以 **只要出现 2 条 occlusion，collision 就直接归零**（2×0.25 = 0.5 = collSat）。
 *   探针因此对每一步都分列 collision.density / occlusion.density 及两类明细。
 *
 * 探针结构（全部在页面内完成，不改任何产品源码）：
 *   阶段 A：跑一次真实 Pipeline.beautify，monkey-patch 记录
 *           Pipeline.preview / Patch.applyAll / Geo.canvasTail / Runtime.setResolution；
 *           对目标 gateKey 的批，在**应用前**抓下 exportString() 全文与当时的
 *           reject/rejectItems —— 于是阶段 B 能从这个**精确的批前状态**复现，
 *           完全不需要复制管线循环（源码可能正被并行编辑，复制必然过期）。
 *   阶段 B：load(批前 SVG) → IR/Analyzer → Pipeline.preview(同一 reject) → 取该
 *           gateKey 的 batch（并与真实调用比对），然后 5 组实验：
 *             E1 tailOnly   ：只跑 canvasTail（不含 batch op）        → 反向假设
 *             E2 trajNoTail ：逐 op 应用、每步复测（不跑 tail）      → 找塌陷点
 *             E3 trajTail   ：逐 op 应用 + 每步复跑 canvasTail        → 管线语义轨迹
 *             E4 exact      ：applyAll(batch)→canvasTail→checkOp（逐字复刻生效校验）
 *             E5 culprit    ：只应用「塌陷那一步」的单个 op（±tail）  → 归因
 *           并对塌陷点做「节点位移普查」（按 Δx,Δy 聚类）+ DOM 祖先链取证。
 *
 * 运行：$env:NODE_PATH=".svgbuild\node_modules"; node tests\diag_batch.cjs
 * ===========================================================================*/
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const url = 'file:///' + path.resolve(ROOT, 'ui.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const TARGET_GKS = ['text_overflow|move_text', 'style_inconsistency|normalize_style'];

function fileStamp(rel) {
  try {
    const st = fs.statSync(path.resolve(ROOT, rel));
    return { file: rel, bytes: st.size, mtime: st.mtime.toISOString() };
  } catch (e) { return { file: rel, err: String((e && e.message) || e) }; }
}

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true });
  const p = await b.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  p.on('pageerror', e => pageErrors.push(String((e && e.message) || e)));
  p.on('console', m => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text()); });
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__out && window.__out.stage === 'ready', null, { timeout: 120000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 700));

  const out = await p.evaluate(async (TARGET_GKS) => {
    /* ======================= 0. 代码版本指纹 ======================= */
    const fh = s => { let h = 5381; const t = String(s); for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(16) + '@' + t.length; };
    const codeId = {
      beautify: fh(Pipeline.beautify),
      tryUnits: typeof Pipeline._tryUnits === 'function' ? fh(Pipeline._tryUnits) : 'absent',
      preview: fh(Pipeline.preview),
      canvasTail: fh(Geo.canvasTail),
      atomicity: typeof Geo.atomicity === 'function' ? fh(Geo.atomicity) : 'absent',
      collisionFn: fh(Analyzer.collision),
      occlusionFn: fh(Analyzer.occlusion),
      checkOp: fh(Validator.checkOp),
      guard: JSON.stringify(Validator.GUARD) + ' minGain=' + Validator.MIN_GAIN + ' minGainOp=' + Validator.MIN_GAIN_OP,
      collSat: Analyzer.DEF.collSat
    };

    const smp = UI.samples.find(s => s.id.indexOf('real-onto_platform') >= 0);
    if (!smp) return { err: 'sample real-onto_platform not found', codeId };
    const SOPT = {};
    const PAD = undefined;                    /* 与 Pipeline.beautify 默认一致：o.canvasPad = undefined */
    const RECT = r => (r ? { x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h) } : null);

    /* ======================= 1. 快照工具 ======================= */
    const snap = tag => {
      const t0 = performance.now();
      const ir = IR.build(Runtime, SOPT);
      if (!ir.ok) return { tag, irOk: false, err: ir.err || null };
      const an = Analyzer.run(ir, SOPT);
      const col = an.raw.collision, occ = an.raw.occlusion, cv = an.raw.canvas;
      return {
        tag, ms: r2(performance.now() - t0),
        score: an.score, metrics: an.metrics, colMetric: an.metrics.collision,
        colD: col.density, colN: col.count, colWorst: col.worst,
        occD: occ.density, occN: occ.count,
        collisionInput: r2(col.density + occ.density),      /* sc() 入参：≥ collSat(0.5) 即 collision=0 */
        pairs: col.pairs.map(q => ({ a: q.a, b: q.b, cover: q.cover, iw: q.overlapW, ih: q.overlapH, rect: q.rect, aDesc: String(q.aDesc || '').slice(0, 46), bDesc: String(q.bDesc || '').slice(0, 46) })),
        occItems: occ.items.map(it => ({ textId: it.textId, shapeId: it.shapeId, cover: it.cover, area: it.area, centerIn: !!it.centerIn, rect: it.rect, textDesc: String(it.textDesc || '').slice(0, 36), shapeDesc: String(it.shapeDesc || '').slice(0, 46) })),
        canvas: { w: ir.canvas.w, h: ir.canvas.h },
        contentBox: RECT(ir.contentBox), margins: cv.margins, util: cv.utilization, overflow: cv.overflow,
        nNodes: ir.nodes.length, nTexts: ir.texts.length, nEdges: ir.edges.length,
        nodes: ir.nodes.map(n => [n.id, n.describe, r2(n.bbox.x), r2(n.bbox.y), r2(n.bbox.w), r2(n.bbox.h), r2(n.geomBox.x), r2(n.geomBox.y), r2(n.geomBox.w), r2(n.geomBox.h)]),
        rt: { contentW: Runtime.canvas && Runtime.canvas.contentW, contentH: Runtime.canvas && Runtime.canvas.contentH, lastW: Runtime.lastW, lastH: Runtime.lastH }
      };
    };
    /* thin = 去掉 pairs（保留 nodes，位移普查要用），pairs 只在需要时看 */
    const thin = s => { if (!s) return null; const c = Object.assign({}, s); delete c.pairs; return c; };
    const census = (a, b) => {                 /* 节点位移普查：按 (Δx,Δy) 聚类 → 判断平移是否刚性 */
      if (!a || !a.nodes || !b || !b.nodes) return null;
      const m = new Map(a.nodes.map(n => [n[0], n]));
      const g = {};
      for (const n of b.nodes) {
        const o = m.get(n[0]);
        if (!o) { (g['NEW'] = g['NEW'] || []).push(n[0]); continue; }
        const k = r2(n[2] - o[2]) + ',' + r2(n[3] - o[3]);
        (g[k] = g[k] || []).push(String(n[1] || n[0]).slice(0, 30));
      }
      const res = {};
      for (const k of Object.keys(g)) res[k] = { n: g[k].length, sample: g[k].slice(0, 4) };
      return res;
    };
    const topPairs = s => (s && s.pairs ? s.pairs.slice().sort((x, y) => y.cover - x.cover).slice(0, 6) : []);
    const opDesc = op => ({
      kind: op.kind, strategy: op.strategy, issue: op.issueType, label: op.label || '',
      gateKey: op.gateKey || '', itemKey: op.itemKey || null,
      target: op.target ? (tagOf(op.target) + '#' + (op.target.id || '') + (op.target.getAttribute && op.target.getAttribute('data-id') ? '[' + op.target.getAttribute('data-id') + ']' : '')) : null,
      why: String(op.why || '').slice(0, 170),
      preview: op.preview ? { before: RECT(op.preview.before), after: RECT(op.preview.after), pathPts: op.preview.path ? op.preview.path.length : null } : null
    });
    const opSig = op => op.kind + '|' + op.strategy + '|' + op.issueType + '|' + (op.label || '');
    const tailInfo = t => ({ n: t.ops.length, grow: !!t.grow, dx: t.dx, dy: t.dy, pad: t.pad, flush: !!t.flush, note: t.note || null, canvas: t.canvas || null });
    const gkOf = op => op.gateKey || ('#' + (op.strategy || '') + '|' + (op.label || ''));
    const planByGK = pl => {
      const g = {};
      for (const op of pl.ops) {
        const k = gkOf(op);
        if (!g[k]) g[k] = { n: 0, kinds: {}, strategies: {}, issues: {} };
        const e = g[k]; e.n++;
        e.kinds[op.kind] = (e.kinds[op.kind] || 0) + 1;
        e.strategies[op.strategy] = (e.strategies[op.strategy] || 0) + 1;
        e.issues[op.issueType] = (e.issues[op.issueType] || 0) + 1;
      }
      return g;
    };

    /* ======================= 2. 阶段 A：真实管线 + 调用序取证 ======================= */
    const seqRef = { n: 0 };
    const log = { preview: [], applyAll: [], tail: [], setRes: [] };
    let lastPreview = null;
    const orig = { preview: Pipeline.preview, applyAll: Patch.applyAll, tail: Geo.canvasTail, setRes: Runtime.setResolution };

    Pipeline.preview = async function (rt, ir, an, strategy, temp, sopt) {
      const pv = await orig.preview.call(this, rt, ir, an, strategy, temp, sopt);
      const e = {
        seq: ++seqRef.n, side: 'preview', strategy, temp,
        reject: (sopt && sopt.reject) ? sopt.reject.slice() : [],
        rejectItems: (sopt && sopt.rejectItems) ? sopt.rejectItems.slice() : [],
        opsN: pv.pl.ops.length, byGateKey: planByGK(pv.pl), style: pv.pl.style, phase: pv.pl.phase,
        skippedN: (pv.pl.skipped || []).length
      };
      log.preview.push(e);
      lastPreview = { seq: e.seq, reject: e.reject, rejectItems: e.rejectItems, style: e.style, phase: e.phase, opsN: e.opsN };
      return pv;
    };
    const isTailOps = ops => ops.length > 0 && ops.every(o => o.strategy === 'rebalance_canvas');
    Patch.applyAll = function (ops) {
      const entry = {
        seq: ++seqRef.n, side: 'applyAll', n: ops.length,
        gk: ops.length ? (ops[0].gateKey || '') : '',
        issue: ops.length ? ops[0].issueType : '', strategy: ops.length ? ops[0].strategy : '',
        kind: isTailOps(ops) ? 'TAIL' : 'BATCH',
        labels: ops.slice(0, 6).map(o => String(o.label || '').slice(0, 44)),
        strategies: [...new Set(ops.map(o => o.strategy))],
        issues: [...new Set(ops.map(o => o.issueType))],
        preSvgHash: null, preSvgText: null, lastPreview: lastPreview, errors: null
      };
      if (entry.kind === 'BATCH' && TARGET_GKS.indexOf(entry.gk) >= 0) {
        try {
          const txt = Runtime.exportString();
          entry.preSvgText = txt;
          entry.preSvgHash = sha256Hex(txt).slice(0, 12);
          entry.preSnap = thin(snap('A-pre-batch'));
        } catch (e) { entry.captureErr = String((e && e.message) || e); }
      }
      log.applyAll.push(entry);
      const r = orig.applyAll.call(this, ops);
      entry.errors = r.errors;
      entry.applied = r.applied.length;
      return r;
    };
    Geo.canvasTail = function (ir, an, st, pad) {
      const t = orig.tail.call(this, ir, an, st, pad);
      log.tail.push(Object.assign({
        seq: ++seqRef.n, side: 'canvasTail', stType: typeof st, st: (typeof st === 'string' ? st : (st ? '[obj]' : null)),
        contentBox: RECT(ir.contentBox), cw: ir.canvas.w, ch: ir.canvas.h,
        collMetric: an.metrics.collision, colD: an.raw.collision.density, occD: an.raw.occlusion.density, occN: an.raw.occlusion.count
      }, tailInfo(t)));
      return t;
    };
    Runtime.setResolution = function (w, h) {
      const before = { contentW: this.canvas.contentW, contentH: this.canvas.contentH, lastW: this.lastW, lastH: this.lastH };
      const r = orig.setRes.call(this, w, h);
      log.setRes.push({ seq: ++seqRef.n, side: 'setResolution', w, h, ok: r, before, after: { contentW: this.canvas.contentW, contentH: this.canvas.contentH, lastW: this.lastW, lastH: this.lastH } });
      return r;
    };

    let real = null, realErr = null;
    try { real = await Pipeline.beautify(Runtime, smp.svg, { strategy: 'rule', temp: 3, maxRounds: 4, sopt: {} }); }
    catch (e) { realErr = String((e && e.stack) || e); }
    Pipeline.preview = orig.preview; Patch.applyAll = orig.applyAll; Geo.canvasTail = orig.tail; Runtime.setResolution = orig.setRes;

    const realSummary = real ? {
      ok: real.ok, beforeScore: real.before.score, afterScore: real.after.score, delta: real.delta,
      beforeMetrics: real.before.metrics, afterMetrics: real.after.metrics,
      beforeRaw: real.before.raw, afterRaw: real.after.raw, beforeCanvas: real.before.canvas,
      tailRounds: real.tailRounds, tailCanvasGrow: real.tailCanvasGrow, occFixedCount: real.occFixedCount, ms: real.ms,
      ledger: (real.ledger || []).map(rec => ({
        round: rec.round, before: rec.before, after: rec.after, commit: rec.commit, note: rec.note,
        accepted: rec.accepted, rejected: rec.rejected, beforeMetrics: rec.beforeMetrics, afterMetrics: rec.afterMetrics,
        gain: rec.gain, rolledBack: !!rec.rolledBack, rejectedKeys: rec.rejectedKeys || null, rejectedItems: rec.rejectedItems || null,
        tail: rec.tail ? { n: rec.tail.n, grow: rec.tail.grow, dx: rec.tail.dx, dy: rec.tail.dy, phase: rec.tail.phase, note: rec.tail.note } : null,
        steps: (rec.steps || []).map(s => ({
          i: s.i, itemKey: s.itemKey, issue: s.issue, strategy: s.strategy, mode: s.mode,
          nOps: s.nOps, nPlanned: s.nPlanned, accept: s.accept, before: s.before, after: s.after, gain: s.gain,
          reasons: (s.reasons || []).slice(0, 4),
          tail: (s.tail || []).map(t => ({ n: t.n, grow: t.grow, dx: t.dx, dy: t.dy })),
          units: s.units ? s.units.map(u => ({ itemKey: u.itemKey, nOps: u.nOps, accept: u.accept, gain: u.gain, reasons: (u.reasons || []).slice(0, 2) })) : undefined
        }))
      }))
    } : { err: realErr };

    /* 目标批在真实管线里的全部出现（含批前 DOM 全文，供阶段 B 精确复现） */
    const realCalls = [];
    log.applyAll.forEach((e, i) => {
      if (e.kind === 'BATCH' && TARGET_GKS.indexOf(e.gk) >= 0) {
        const nxtApply = log.applyAll[i + 1] || null;
        realCalls.push({
          seq: e.seq, gk: e.gk, n: e.n, labels: e.labels, issues: e.issues, strategies: e.strategies,
          applied: e.applied, errors: e.errors, preSvgHash: e.preSvgHash, preSvgText: e.preSvgText,
          captureErr: e.captureErr || null, lastPreview: e.lastPreview, preSnap: e.preSnap,
          nextCall: nxtApply ? { side: nxtApply.side, kind: nxtApply.kind, n: nxtApply.n, gk: nxtApply.gk } : null
        });
      }
    });
    const realCallByGK = {};
    for (const c of realCalls) if (!realCallByGK[c.gk]) realCallByGK[c.gk] = c;

    /* ======================= 3. 阶段 B：精确复现「一次生效校验」 ======================= */
    /* 复现某一 gateKey 的批前状态：优先用阶段 A 抓到的批前 DOM 全文 + 同一 reject。 */
    const stateFor = async gk => {
      const c = realCallByGK[gk];
      if (c && c.preSvgText) {
        Runtime.load(c.preSvgText);
        const ir = IR.build(Runtime, SOPT);
        const an = Analyzer.run(ir, SOPT);
        const sopt2 = Object.assign({}, SOPT, {
          reject: (c.lastPreview && c.lastPreview.reject) || [],
          rejectItems: (c.lastPreview && c.lastPreview.rejectItems) || []
        });
        const pv = await Pipeline.preview(Runtime, ir, an, 'rule', 3, sopt2);
        const back = Runtime.exportString();
        return {
          ir, an, pv, src: 'A.preSvgText', reject: sopt2.reject, rejectItems: sopt2.rejectItems,
          roundTripHash: sha256Hex(back).slice(0, 12), expectHash: c.preSvgHash,
          roundTripOk: sha256Hex(back).slice(0, 12) === c.preSvgHash
        };
      }
      /* 兜底：从样张全新载入 + 把别的 issueType 拉黑（近似） */
      Runtime.load(smp.svg);
      try { Pipeline._resolveOcclusions(Runtime, SOPT, { errors: [] }); } catch (e) { /* ignore */ }
      const ir = IR.build(Runtime, SOPT);
      const an = Analyzer.run(ir, SOPT);
      const probePl = await Pipeline.preview(Runtime, ir, an, 'rule', 3, Object.assign({}, SOPT, { reject: [], rejectItems: [] }));
      const rejs = [];
      for (const k of Object.keys(planByGK(probePl.pl))) { if (k !== gk && k.split('|')[0] !== gk.split('|')[0]) rejs.push(k); }
      const sopt2 = Object.assign({}, SOPT, { reject: rejs, rejectItems: [] });
      const pv = await Pipeline.preview(Runtime, ir, an, 'rule', 3, sopt2);
      return { ir, an, pv, src: 'fallback-fresh', reject: rejs, rejectItems: [], roundTripOk: null };
    };

    const basePlanStat = { note: '阶段 B 的每个实验都是「精确复现的批前状态 + 同一 reject 重新规划」，所以 ops 绑定在当前活 DOM 上' };
    const experiments = [];
    for (const gk of TARGET_GKS) {
      const rec = { gateKey: gk };
      const c = realCallByGK[gk] || null;
      rec.realCall = c ? { seq: c.seq, n: c.n, labels: c.labels, issues: c.issues, strategies: c.strategies, preSvgHash: c.preSvgHash, lastPreview: c.lastPreview, nextCall: c.nextCall, captureErr: c.captureErr } : null;
      const first = await stateFor(gk);
      rec.repro = { src: first.src, reject: first.reject, rejectItems: first.rejectItems, roundTripOk: first.roundTripOk, roundTripHash: first.roundTripHash, expectHash: first.expectHash || null };
      rec.planByGateKey = planByGK(first.pv.pl);
      rec.planOps = first.pv.pl.ops.length;
      rec.style = first.pv.pl.style;
      const refBatch = first.pv.pl.ops.filter(o => gkOf(o) === gk);
      rec.batch = { n: refBatch.length, sigs: refBatch.map(opSig), ops: refBatch.map(opDesc), itemKeys: [...new Set(refBatch.map(o => o.itemKey || ''))] };
      rec.batchMatchesRealCall = c ? (c.n === refBatch.length && JSON.stringify(c.labels) === JSON.stringify(refBatch.slice(0, 6).map(o => String(o.label || '').slice(0, 44)))) : null;
      rec.preSnap = thin(snap('B-pre'));

      if (!refBatch.length) { experiments.push(rec); continue; }

      /* 每次实验都重新取一次批前状态 → 新闭包（幂等） */
      const fresh = async () => {
        const st2 = await stateFor(gk);
        const batch = st2.pv.pl.ops.filter(o => gkOf(o) === gk);
        return { st: st2, batch, style: st2.pv.pl.style, sigs: batch.map(opSig) };
      };

      /* ---- E1：只跑 canvasTail（不含 batch op）—— 反向假设 ---- */
      {
        const st = await stateFor(gk);
        const pre = snap('E1-pre');
        const t = Geo.canvasTail(st.ir, st.an, st.pv.pl.style, PAD);
        const ti = tailInfo(t);
        let after = null;
        if (t.ops.length) { const ap = Patch.applyAll(t.ops); ti.errors = ap.errors; ti.applied = ap.applied.length; after = snap('E1-afterTailOnly'); }
        rec.E1_tailOnly = { pre: thin(pre), tail: ti, after: after ? thin(after) : null, census: after ? census(pre, after) : null };
      }

      /* ---- E2：逐 op 应用、每步复测（不跑 tail）→ 找塌陷点 ---- */
      {
        const f = await fresh();
        const pre = snap('E2-pre');
        const steps = [];
        for (let k = 0; k < f.batch.length; k++) {
          const ap = Patch.applyAll([f.batch[k]]);
          const s = snap('op' + (k + 1));
          steps.push({ k: k + 1, op: opDesc(f.batch[k]), errors: ap.errors, snap: thin(s) });
        }
        const last = steps.length ? steps[steps.length - 1].snap : null;
        rec.E2_trajNoTail = { sigsMatchRef: JSON.stringify(f.sigs) === JSON.stringify(rec.batch.sigs), pre: thin(pre), steps, censusLast: last ? census(pre, last) : null };
      }

      /* ---- E3：逐 op 应用 + 每步复跑 canvasTail（管线语义轨迹）---- */
      {
        const f = await fresh();
        const pre = snap('E3-pre');
        const steps = [];
        for (let k = 0; k < f.batch.length; k++) {
          const ap = Patch.applyAll([f.batch[k]]);
          const s1 = snap('op' + (k + 1) + '-noTail');
          const iA = IR.build(Runtime, SOPT);
          const aA = iA.ok ? Analyzer.run(iA, SOPT) : null;
          let ti = { n: 0 }, s2 = null, tErr = null;
          if (aA) {
            const t = Geo.canvasTail(iA, aA, f.style, PAD);
            ti = tailInfo(t);
            if (t.ops.length) { const ta = Patch.applyAll(t.ops); ti.errors = ta.errors; ti.applied = ta.applied.length; s2 = snap('op' + (k + 1) + '-afterTail'); }
          } else tErr = 'IR/Analyzer 失败';
          steps.push({ k: k + 1, op: opDesc(f.batch[k]), errors: ap.errors, beforeTail: thin(s1), tail: ti, afterTail: s2 ? thin(s2) : null, tailErr: tErr });
        }
        rec.E3_trajTail = { pre: thin(pre), steps };
      }

      /* ---- E4：逐字复刻生效校验链（applyAll(batch) → canvasTail → checkOp）---- */
      {
        const f = await fresh();
        const pre = snap('E4-pre');
        const preAn = f.st.an;
        const ap = Patch.applyAll(f.batch);
        const iT = IR.build(Runtime, SOPT);
        const aT = iT.ok ? Analyzer.run(iT, SOPT) : null;
        const sNoTail = aT ? snap('E4-afterBatchNoTail') : null;
        let ti = null, sT = null;
        if (aT) {
          const t = Geo.canvasTail(iT, aT, f.style, PAD);
          ti = tailInfo(t);
          if (t.ops.length) { const ta = Patch.applyAll(t.ops); ti.errors = ta.errors; ti.applied = ta.applied.length; sT = snap('E4-afterTail'); }
        }
        const i2 = IR.build(Runtime, SOPT);
        const a2 = i2.ok ? Analyzer.run(i2, SOPT) : null;
        const s2 = a2 ? snap('E4-final') : null;
        const gate = a2 ? Validator.checkOp(preAn, a2) : null;
        const gateNoTail = (aT && aT !== preAn) ? Validator.checkOp(preAn, aT) : null;
        rec.E4_exactCheck = {
          sigsMatchRef: JSON.stringify(f.sigs) === JSON.stringify(rec.batch.sigs),
          applyErrors: ap.errors,
          pre: thin(pre), tail: ti,
          afterBatchNoTail: sNoTail ? thin(sNoTail) : null,
          afterTail: sT ? thin(sT) : null, final: s2 ? thin(s2) : null,
          gateVerdict: gate ? { ok: gate.ok, gain: gate.gain, reasons: gate.reasons } : null,
          gateVerdictWithoutTail: gateNoTail ? { ok: gateNoTail.ok, gain: gateNoTail.gain, reasons: gateNoTail.reasons } : null,
          census: s2 ? census(pre, s2) : null
        };
      }

      /* ---- E5：只应用「塌陷那一步」的单个 op（±tail）---- */
      {
        const t2 = rec.E2_trajNoTail;
        const preM = t2.pre.colMetric;
        let ci = -1;
        t2.steps.forEach((s, i) => { if (ci < 0 && (preM - s.snap.colMetric) >= 20) ci = i; });
        rec.collapse = ci >= 0
          ? { idx: ci + 1, of: t2.steps.length, op: t2.steps[ci].op, snapAfter: t2.steps[ci].snap, censusAtCollapse: census(t2.pre, t2.steps[ci].snap) }
          : { idx: null, note: 'E2 轨迹里没有 ≥20 分的 collision 暴跌；改用 E3 相邻步最大跌幅定位' };
        if (ci < 0 && rec.E3_trajTail) {
          let best = -1, bi = -1;
          rec.E3_trajTail.steps.forEach((s, i) => {
            const a = s.beforeTail ? s.beforeTail.colMetric : null;
            const b = s.afterTail ? s.afterTail.colMetric : a;
            const d = (a != null && b != null) ? (a - b) : -1;
            if (d > best) { best = d; bi = i; }
          });
          rec.collapse = { idx: bi + 1, of: rec.E3_trajTail.steps.length, drop: r2(best), op: rec.E3_trajTail.steps[bi] ? rec.E3_trajTail.steps[bi].op : null, snapAfter: rec.E3_trajTail.steps[bi] ? rec.E3_trajTail.steps[bi].afterTail : null, source: 'E3' };
        }
        rec.E5 = { steps: [] };
        const idxs = [];
        if (ci >= 0) idxs.push(ci);
        if (ci > 0) idxs.push(ci - 1);
        for (const idx of idxs) {
          /* 单 op，不带 tail */
          {
            const f = await fresh();
            const pre = snap('E5-pre');
            const ap = Patch.applyAll([f.batch[idx]]);
            const s = snap('E5-op' + (idx + 1) + '-noTail');
            rec.E5.steps.push({ idx: idx + 1, withTail: false, op: opDesc(f.batch[idx]), errors: ap.errors, pre: thin(pre), result: thin(s), census: census(pre, s) });
          }
          /* 单 op，带 tail */
          {
            const f = await fresh();
            const pre = snap('E5-pre');
            const ap = Patch.applyAll([f.batch[idx]]);
            const iA = IR.build(Runtime, SOPT);
            const aA = iA.ok ? Analyzer.run(iA, SOPT) : null;
            let ti = { n: 0 }, s2 = null;
            if (aA) {
              const t = Geo.canvasTail(iA, aA, f.style, PAD);
              ti = tailInfo(t);
              if (t.ops.length) { const ta = Patch.applyAll(t.ops); ti.errors = ta.errors; ti.applied = ta.applied.length; s2 = snap('E5-op' + (idx + 1) + '-afterTail'); }
            }
            rec.E5.steps.push({ idx: idx + 1, withTail: true, op: opDesc(f.batch[idx]), errors: ap.errors, pre: thin(pre), tail: ti, result: s2 ? thin(s2) : thin(snap('E5-op' + (idx + 1) + '-final')), census: s2 ? census(pre, s2) : null });
          }
        }
      }
      experiments.push(rec);
    }

    /* ======================= 4. 塌陷态取证（DOM 祖先链 / 肇事 pair） ======================= */
    const forensics = [];
    for (const gk of TARGET_GKS) {
      const st = await stateFor(gk);
      const batch = st.pv.pl.ops.filter(o => gkOf(o) === gk);
      if (!batch.length) { forensics.push({ gateKey: gk, skipped: 'batch empty' }); continue; }
      const pre = snap('F-pre');
      Patch.applyAll(batch);
      const iT = IR.build(Runtime, SOPT);
      const aT = iT.ok ? Analyzer.run(iT, SOPT) : null;
      let ti = null;
      if (aT) { const t = Geo.canvasTail(iT, aT, st.pv.pl.style, PAD); ti = tailInfo(t); if (t.ops.length) Patch.applyAll(t.ops); }
      const post = snap('F-post');
      const col = IR.build(Runtime, SOPT);
      const an2 = Analyzer.run(col, SOPT);
      const nodeDetail = id => {
        const n = col.nodes.find(x => x.id === id);
        if (!n) return { id, missing: true };
        const chain = [];
        let cur = n.shapeElem;
        while (cur && chain.length < 7) {
          chain.push({
            tag: tagOf(cur), id: cur.id || '', cls: (cur.getAttribute && cur.getAttribute('class')) || '',
            transform: (cur.getAttribute && cur.getAttribute('transform')) || null,
            x: (cur.getAttribute && cur.getAttribute('x')) || null, y: (cur.getAttribute && cur.getAttribute('y')) || null,
            w: (cur.getAttribute && cur.getAttribute('width')) || null, h: (cur.getAttribute && cur.getAttribute('height')) || null,
            fill: (cur.getAttribute && cur.getAttribute('fill')) || null
          });
          if (tagOf(cur) === 'svg' || !cur.parentNode) break;
          cur = cur.parentNode;
        }
        return {
          id: n.id, describe: n.describe, shape: n.shape, fill: String(n.fill || '').slice(0, 26), stroke: String(n.stroke || '').slice(0, 26),
          bbox: RECT(n.bbox), geomBox: RECT(n.geomBox), isBg: !!n.isBg, ctm: n.ctm, elemTag: tagOf(n.elem), shapeTag: tagOf(n.shapeElem),
          labels: n.labels.map(l => ({ text: String(l.text || '').slice(0, 32), bbox: RECT(l.bbox), x: l.elem.getAttribute && l.elem.getAttribute('x'), y: l.elem.getAttribute && l.elem.getAttribute('y') })),
          chain
        };
      };
      const worstPairs = an2.raw.collision.pairs.slice().sort((x, y) => y.cover - x.cover);
      const newPairs = worstPairs.filter(q => !pre.pairs.some(o => o.a === q.a && o.b === q.b));
      const focus = newPairs.length ? newPairs[0] : (worstPairs[0] || null);
      forensics.push({
        gateKey: gk, tailAtApply: ti, pre: thin(pre), post: thin(post), census: census(pre, post),
        occItemsPost: post.occItems, collisionInputPost: post.collisionInput, colDPost: post.colD, occDPost: post.occD,
        newPairsCount: newPairs.length, pairCountPre: pre.colN, pairCountPost: post.colN,
        focusPair: focus ? { a: focus.a, b: focus.b, cover: focus.cover, iw: focus.overlapW, ih: focus.overlapH, rect: focus.rect, aDesc: focus.aDesc, bDesc: focus.bDesc, isNew: !pre.pairs.some(o => o.a === focus.a && o.b === focus.b) } : null,
        topPairsPost: worstPairs.slice(0, 6).map(q => ({ a: q.a, b: q.b, cover: q.cover, iw: q.overlapW, ih: q.overlapH, aDesc: q.aDesc, bDesc: q.bDesc })),
        focusMembers: focus ? [nodeDetail(focus.a), nodeDetail(focus.b)] : [],
        occlusionMembers: post.occItems.slice(0, 3).map(it => ({ item: it, text: nodeDetail(it.textId), shape: nodeDetail(it.shapeId) }))
      });
    }

    /* ======================= 5. 阶段 C：前因核查 =======================
     * 为什么会有 `text_overflow|n3`（n3 = 54,48,1812×984 的满版外框）这一批
     * 「把标题/副标题/图例全部吸到外框中心」的 op？
     * 假设：先前某个**获准**的 batch 的 canvasTail 把画布从 1920×1080 扩成了
     *       2036.5×1129，于是 n3 的面积占比 0.860 → 0.776 跌破 IR.isBg 的 0.85 门
     *       (03_ir.js:152)，n3 从「满版底板」变成普通节点，并把画布上所有落在它范围内的
     *       自由文本（标题/副标题/图例）认领为**自己的标签** (03_ir.js:154~161)；
     *       text_overflow|n3 因此出现，move_text 策略把它们吸到 n3 的中心。
     * 对照实验：同一 DOM，只把 canvas 改回 1920×1080，看 isBg / 标签归属是否翻转。 */
    const stageC = { note: 'same DOM, only canvas.w/h differs → isBg(0.85 门) 与标签归属是否翻转' };
    const frameOf = ir => ir.nodes.find(n => Math.abs(n.geomBox.w - 1812) < 2 && Math.abs(n.geomBox.h - 984) < 2) || null;
    const frameInfo = (ir, an) => {
      const f = frameOf(ir);
      const cvA = ir.canvas.w * ir.canvas.h;
      return {
        canvas: { w: ir.canvas.w, h: ir.canvas.h, area: r2(cvA) },
        frame: f ? {
          id: f.id, describe: f.describe, geomBox: RECT(f.geomBox), area: r2(R.area(f.geomBox)), ratio: r2(R.area(f.geomBox) / cvA),
          isBg: !!f.isBg, nLabels: f.labels.length, labels: f.labels.map(l => String(l.text || '').slice(0, 18))
        } : null,
        titleOwners: ir.nodes.filter(n => n.labels.some(l => String(l.text || '').indexOf('中创元穹本体智能平台') >= 0)).map(n => ({ id: n.id, describe: n.describe, isBg: !!n.isBg })),
        titleIsFreeText: ir.texts.some(t => String(t.text || '').indexOf('中创元穹本体智能平台') >= 0),
        score: an ? an.score : null, collision: an ? an.metrics.collision : null, textFit: an ? an.metrics.textFit : null,
        textOverflowIssues: an ? an.issues.filter(i => i.type === 'text_overflow').map(i => ({ targets: i.targets, pen: i.evidence && i.evidence.pen, label: String((i.evidence && i.evidence.label) || '').slice(0, 20) })) : null
      };
    };
    /* C1：样张原始载入（canvas = 1920×1080） */
    {
      Runtime.load(smp.svg);
      const ir = IR.build(Runtime, SOPT), an = Analyzer.run(ir, SOPT);
      const pv = await Pipeline.preview(Runtime, ir, an, 'rule', 3, Object.assign({}, SOPT, { reject: [], rejectItems: [] }));
      stageC.original = frameInfo(ir, an);
      stageC.original.planByGateKey = planByGK(pv.pl);
      stageC.original.moveTextOps = pv.pl.ops.filter(o => o.strategy === 'move_text').map(opDesc);
    }
    /* C2：目标批的真实批前状态（canvas 已被先前获准 batch 的 canvasTail 扩到 2036.5×1129） */
    {
      const st = await stateFor('text_overflow|move_text');
      stageC.grownCanvas = frameInfo(st.ir, st.an);
      stageC.grownCanvas.reject = st.reject;
      stageC.grownCanvas.planByGateKey = planByGK(st.pv.pl);
      stageC.grownCanvas.moveTextOps = st.pv.pl.ops.filter(o => o.strategy === 'move_text').map(opDesc);
    }
    /* C3：对照 —— 同一 DOM，只把 canvas 改回 1920×1080 */
    {
      const st = await stateFor('text_overflow|move_text');
      const before = frameInfo(st.ir, st.an);
      Runtime.setResolution(1920, 1080);
      const ir = IR.build(Runtime, SOPT), an = Analyzer.run(ir, SOPT);
      const pv = await Pipeline.preview(Runtime, ir, an, 'rule', 3, Object.assign({}, SOPT, { reject: st.reject.slice(), rejectItems: st.rejectItems.slice() }));
      stageC.counterfactual = {
        isolatedVar: 'canvas 2036.5×1129 → 1920×1080（同一 DOM，内容不移动）',
        before: { canvas: before.canvas, frameIsBg: before.frame && before.frame.isBg, frameRatio: before.frame && before.frame.ratio, frameLabels: before.frame && before.frame.nLabels, titleOwners: before.titleOwners, titleIsFreeText: before.titleIsFreeText },
        after: frameInfo(ir, an),
        planByGateKey: planByGK(pv.pl),
        moveTextOps: pv.pl.ops.filter(o => o.strategy === 'move_text').map(opDesc)
      };
    }

    return {
      codeId,
      sample: { id: smp.id, name: smp.name, svgBytes: (smp.svg || '').length },
      stageC,
      realSummary, realCalls: realCalls.map(c => ({ seq: c.seq, gk: c.gk, n: c.n, labels: c.labels, issues: c.issues, strategies: c.strategies, applied: c.applied, errors: c.errors, preSvgHash: c.preSvgHash, captureErr: c.captureErr, lastPreview: c.lastPreview, preSnap: c.preSnap, nextCall: c.nextCall, preSvgBytes: c.preSvgText ? c.preSvgText.length : 0 })),
      callLog: {
        preview: log.preview.map(e => ({ seq: e.seq, reject: e.reject, rejectItems: e.rejectItems, opsN: e.opsN, byGateKey: e.byGateKey })),
        applyAll: log.applyAll.map(e => ({ seq: e.seq, kind: e.kind, n: e.n, gk: e.gk, issue: e.issue, applied: e.applied, errors: e.errors, preSvgHash: e.preSvgHash })),
        canvasTail: log.tail,
        setRes: log.setRes
      },
      phaseB: { note: basePlanStat.note, experiments, forensics }
    };
  }, TARGET_GKS);

  /* ======================= 5. 人读摘要 + 全量 JSON ======================= */
  const lines = [];
  const R = out && out.result ? out.result : out;
  lines.push('== tests/diag_batch.cjs ==');
  lines.push('runAt=' + new Date().toISOString());
  lines.push('mtimes: ' + JSON.stringify(stamped_mtimes()));
  if (R && R.codeId) lines.push('codeId: ' + JSON.stringify(R.codeId));
  if (pageErrors.length) lines.push('pageErrors: ' + JSON.stringify(pageErrors.slice(0, 5)));
  function stamped_mtimes() { return [fileStamp('src/07_patch.js'), fileStamp('src/06_geometry.js'), fileStamp('src/04_analyzer.js'), fileStamp('ui.html')].map(f => f.file + '@' + (f.bytes || '?') + '/' + (f.mtime || f.err)); }

  const rs = R && R.realSummary;
  if (rs && !rs.err) {
    lines.push('-- 阶段 A：真实 Pipeline.beautify --');
    lines.push('score ' + rs.beforeScore + ' -> ' + rs.afterScore + ' (Δ' + rs.delta + ')  ms=' + rs.ms + '  tailRounds=' + rs.tailRounds + ' tailCanvasGrow=' + rs.tailCanvasGrow);
    lines.push('beforeMetrics ' + JSON.stringify(rs.beforeMetrics));
    lines.push('afterMetrics  ' + JSON.stringify(rs.afterMetrics));
    for (const rec of (rs.ledger || [])) {
      lines.push('round ' + rec.round + ': before=' + rec.before + ' after=' + rec.after + ' commit=' + rec.commit + ' acc=' + rec.accepted + ' rej=' + rec.rejected + ' note=' + (rec.note || '-') + ' tail=' + JSON.stringify(rec.tail));
      for (const s of (rec.steps || [])) {
        lines.push('   step' + s.i + ' ' + s.itemKey + ' nOps=' + s.nOps + (s.nPlanned ? '(planned ' + s.nPlanned + ')' : '') + ' mode=' + (s.mode || '-') + ' ' + s.before + '->' + s.after + ' gain=' + s.gain + ' accept=' + s.accept + (s.reasons && s.reasons.length ? '  REJ: ' + s.reasons.join(' | ') : ''));
        if (s.units) for (const u of s.units) lines.push('      unit ' + u.itemKey + ' n=' + u.nOps + ' accept=' + u.accept + ' gain=' + u.gain + (u.reasons && u.reasons.length ? ' REJ: ' + u.reasons.join(' | ') : ''));
      }
    }
  } else lines.push('阶段 A 失败: ' + JSON.stringify(rs));

  for (const c of (R.realCalls || [])) {
    lines.push('-- 真实管线里的目标批 seq=' + c.seq + ' gk=' + c.gk + ' n=' + c.n + ' applied=' + c.applied + ' errors=' + JSON.stringify(c.errors));
    lines.push('   labels=' + JSON.stringify(c.labels) + '  nextCall=' + JSON.stringify(c.nextCall) + '  preSvgHash=' + c.preSvgHash);
    lines.push('   批前 metrics=' + JSON.stringify(c.preSnap && c.preSnap.metrics) + ' 批前 collision=' + (c.preSnap && c.preSnap.colMetric) + ' colD=' + (c.preSnap && c.preSnap.colD) + ' occD=' + (c.preSnap && c.preSnap.occD) + ' occN=' + (c.preSnap && c.preSnap.occN));
    lines.push('   批前 lastPreview reject=' + JSON.stringify(c.lastPreview && c.lastPreview.reject) + ' rejectItems=' + JSON.stringify(c.lastPreview && c.lastPreview.rejectItems));
  }
  lines.push('-- canvasTail / setResolution 调用序 --');
  for (const t of ((R.callLog && R.callLog.canvasTail) || [])) lines.push('   tail seq=' + t.seq + ' n=' + t.n + ' grow=' + t.grow + ' dx=' + t.dx + ' dy=' + t.dy + ' pad=' + t.pad + ' flush=' + t.flush + ' note=' + (t.note || '-') + ' canvas=' + JSON.stringify(t.canvas) + ' collMetric=' + t.collMetric);
  for (const t of ((R.callLog && R.callLog.setRes) || [])) lines.push('   setRes seq=' + t.seq + ' ' + t.w + 'x' + t.h + ' ok=' + t.ok + ' before=' + JSON.stringify(t.before) + ' after=' + JSON.stringify(t.after));

  const fmtSnap = s => s ? ('score=' + s.score + ' collision=' + s.colMetric + ' (colD=' + s.colD + ' occD=' + s.occD + ' input=' + s.collisionInput + ' pairs=' + s.colN + ' occ=' + s.occN + ') align=' + s.metrics.alignment + ' canvas=' + s.canvas.w + 'x' + s.canvas.h + ' cb=' + JSON.stringify(s.contentBox) + ' margins=' + JSON.stringify(s.margins)) : 'null';
  for (const rec of ((R.phaseB && R.phaseB.experiments) || [])) {
    lines.push('');
    lines.push('==== gateKey ' + rec.gateKey + ' ====');
    lines.push('realCall n=' + (rec.realCall && rec.realCall.n) + ' labels=' + JSON.stringify(rec.realCall && rec.realCall.labels));
    lines.push('repro src=' + (rec.repro && rec.repro.src) + ' roundTripOk=' + (rec.repro && rec.repro.roundTripOk) + ' reject=' + JSON.stringify(rec.repro && rec.repro.reject));
    lines.push('batch n=' + (rec.batch && rec.batch.n) + ' matchesRealCall=' + rec.batchMatchesRealCall + ' itemKeys=' + JSON.stringify(rec.batch && rec.batch.itemKeys));
    lines.push('pre : ' + fmtSnap(rec.preSnap));
    lines.push('E1 tailOnly: tail=' + JSON.stringify(rec.E1_tailOnly && rec.E1_tailOnly.tail));
    if (rec.E1_tailOnly && rec.E1_tailOnly.after) { lines.push('   after: ' + fmtSnap(rec.E1_tailOnly.after)); lines.push('   census: ' + JSON.stringify(rec.E1_tailOnly.census)); }
    lines.push('E2 逐 op（不跑 tail）:');
    for (const s of ((rec.E2_trajNoTail && rec.E2_trajNoTail.steps) || [])) lines.push('   op' + s.k + ' ' + JSON.stringify([s.op.kind, s.op.strategy, s.op.issue, s.op.label]) + ' -> ' + fmtSnap(s.snap) + (s.errors && s.errors.length ? ' ERR=' + JSON.stringify(s.errors) : ''));
    lines.push('   censusLast: ' + JSON.stringify(rec.E2_trajNoTail && rec.E2_trajNoTail.censusLast));
    lines.push('E3 逐 op + 每步 tail:');
    for (const s of ((rec.E3_trajTail && rec.E3_trajTail.steps) || [])) {
      lines.push('   op' + s.k + ' noTail ' + fmtSnap(s.beforeTail));
      if (s.tail) lines.push('        tail n=' + s.tail.n + ' grow=' + s.tail.grow + ' dx=' + s.tail.dx + ' dy=' + s.tail.dy + ' flush=' + s.tail.flush + ' note=' + (s.tail.note || '-') + (s.afterTail ? ' | afterTail ' + fmtSnap(s.afterTail) : ''));
    }
    const e4 = rec.E4_exactCheck;
    if (e4) {
      lines.push('E4 精确复刻（applyAll(batch) → canvasTail → checkOp）:');
      lines.push('   pre            : ' + fmtSnap(e4.pre));
      lines.push('   batchNoTail    : ' + fmtSnap(e4.afterBatchNoTail));
      lines.push('   tail           : ' + JSON.stringify(e4.tail));
      lines.push('   afterTail/final: ' + fmtSnap(e4.final));
      lines.push('   gate           : ' + JSON.stringify(e4.gateVerdict));
      lines.push('   gate(no tail)  : ' + JSON.stringify(e4.gateVerdictWithoutTail));
      lines.push('   census         : ' + JSON.stringify(e4.census));
    }
    lines.push('塌陷定位: ' + JSON.stringify(rec.collapse && { idx: rec.collapse.idx, of: rec.collapse.of, drop: rec.collapse.drop, op: rec.collapse.op && [rec.collapse.op.kind, rec.collapse.op.strategy, rec.collapse.op.issue, rec.collapse.op.label] }));
    lines.push('   塌陷时: ' + fmtSnap(rec.collapse && rec.collapse.snapAfter) + ' census=' + JSON.stringify(rec.collapse && rec.collapse.censusAtCollapse));
    for (const s of ((rec.E5 && rec.E5.steps) || [])) lines.push('E5 单 op idx=' + s.idx + ' withTail=' + s.withTail + ' ' + JSON.stringify([s.op.kind, s.op.strategy, s.op.issue, s.op.label]) + ' tail=' + JSON.stringify(s.tail) + ' -> ' + fmtSnap(s.result) + ' census=' + JSON.stringify(s.census) + (s.errors && s.errors.length ? ' ERR=' + JSON.stringify(s.errors) : ''));
  }

  for (const f of ((R.phaseB && R.phaseB.forensics) || [])) {
    lines.push('');
    lines.push('==== 取证 ' + f.gateKey + ' ====');
    lines.push('pre colN=' + f.pairCountPre + ' -> post colN=' + f.pairCountPost + ' newPairs=' + f.newPairsCount + ' postColD=' + f.colDPost + ' postOccD=' + f.occDPost + ' collisionInput=' + f.collisionInputPost);
    lines.push('tailAtApply=' + JSON.stringify(f.tailAtApply));
    lines.push('focusPair=' + JSON.stringify(f.focusPair));
    lines.push('census=' + JSON.stringify(f.census));
    lines.push('occItemsPost=' + JSON.stringify(f.occItemsPost));
    for (const m of (f.focusMembers || [])) lines.push('member ' + JSON.stringify(m));
  }

  const C = R && R.stageC;
  if (C) {
    const fmtF = s => s ? ('canvas=' + s.canvas.w + 'x' + s.canvas.h + ' area=' + s.canvas.area + ' | frame=' + JSON.stringify(s.frame) + ' | titleOwners=' + JSON.stringify(s.titleOwners) + ' titleIsFreeText=' + s.titleIsFreeText + ' | score=' + s.score + ' collision=' + s.collision + ' textFit=' + s.textFit) : 'null';
    lines.push('');
    lines.push('==== 阶段 C：前因核查（canvasTail 的历史副作用 → isBg 翻转） ====');
    lines.push('C1 原始载入      : ' + fmtF(C.original));
    lines.push('   C1 gateKeys    : ' + JSON.stringify(C.original && C.original.planByGateKey));
    lines.push('   C1 move_text op: ' + JSON.stringify((C.original && C.original.moveTextOps || []).map(o => [o.label, o.why])));
    lines.push('   C1 textOverflow: ' + JSON.stringify(C.original && C.original.textOverflowIssues));
    lines.push('C2 批前(已扩画布): ' + fmtF(C.grownCanvas));
    lines.push('   C2 gateKeys    : ' + JSON.stringify(C.grownCanvas && C.grownCanvas.planByGateKey));
    lines.push('   C2 move_text op: ' + JSON.stringify(((C.grownCanvas && C.grownCanvas.moveTextOps) || []).slice(0, 3).map(o => [o.label, o.why])));
    lines.push('C3 对照(只改 canvas 回 1920×1080): ' + (C.counterfactual && C.counterfactual.isolatedVar));
    lines.push('   before: ' + JSON.stringify(C.counterfactual && C.counterfactual.before));
    lines.push('   after : ' + fmtF(C.counterfactual && C.counterfactual.after));
    lines.push('   after gateKeys : ' + JSON.stringify(C.counterfactual && C.counterfactual.planByGateKey));
    lines.push('   after move_text: ' + JSON.stringify(((C.counterfactual && C.counterfactual.moveTextOps) || []).slice(0, 3).map(o => [o.label, o.why])));
  }

  console.log(lines.join('\n'));
  console.log('\n===== RAW JSON =====');
  console.log(JSON.stringify({ probe: 'tests/diag_batch.cjs', runAt: new Date().toISOString(), mtimes: stamped_mtimes(), pageErrors, result: R }, null, 1));
  await b.close();
})().catch(e => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
