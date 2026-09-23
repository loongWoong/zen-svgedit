/* =============================================================================
 * SVG Beautifier · 07 Patch 引擎 + 验证器 + 回滚闭环
 *
 * 设计文档 §19：不要直接把完整 SVG 丢给 AI 改，而是 SVG → Patch → Apply。
 * 设计文档 §20：修改后必须重新检查 —— Analyze → Decision → Fix → Render →
 *               Analyze again → Quality ↑ ? commit : rollback
 * 设计文档 §25 堵点六：一键美化不能「越改越丑」，必须有守卫 + 回滚。
 *
 * 关键实现选择：每轮**直接在活 DOM 上重建 IR 重新分析**，不走「导出字符串再载入」，
 * 避免 svgcanvas 往返带来的元素身份与编辑器辅助层污染；导出只用于最终交付与回滚快照。
 * ===========================================================================*/
'use strict';

const Patch = {
  /* 逐条执行 op；op 内含闭包，读的是执行时刻的 DOM 状态 */
  applyAll(ops) {
    const applied = [], errors = [];
    for (const op of ops) {
      try {
        if (isFn(op.apply)) op.apply();
        applied.push(op);
      } catch (e) {
        errors.push({ op: op.label || op.kind, err: e && e.message ? e.message : String(e) });
      }
    }
    return { applied, errors };
  },

  /* 可序列化台账（JSONL 用） */
  record(ops, round) {
    return ops.map((op, i) => ({
      round, i: i + 1, kind: op.kind, strategy: op.strategy, issue: op.issueType,
      target: op.label || '',
      why: op.why || '',
      before: op.preview && op.preview.before ? rectRepr(op.preview.before) : null,
      after: op.preview && op.preview.after ? rectRepr(op.preview.after) : null,
      pathPts: op.preview && op.preview.path ? op.preview.path.length : null,
      skipped: op.skipped || null
    }));
  }
};

function rectRepr(r) {
  if (!r) return null;
  return { x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h) };
}

const Validator = {
  /* 单项守卫：任一维度劣化超过阈值即拒绝本轮（阈值单位 = 分值） */
  GUARD: { collision: -1.0, textFit: -1.0, edgeRouting: -1.5, alignment: -3.0, spacing: -3.0, style: -3.0, canvas: -3.0 },
  MIN_GAIN: 0.05,      /* 整轮门：一轮必须带来可观净提升 */
  MIN_GAIN_OP: 0,      /* op 门：单个 op 只要求「不欠账」 */

  /* 整轮门（Commit/Rollback 的判据，对应设计文档 §20） */
  check(a0, a1) {
    const reasons = [];
    const gain = r2(a1.score - a0.score);
    if (gain <= this.MIN_GAIN) reasons.push(`总分未提升（${a0.score} → ${a1.score}，增益 ${gain}）`);
    for (const k of Object.keys(this.GUARD)) {
      const d = r2(a1.metrics[k] - a0.metrics[k]);
      if (d < this.GUARD[k]) reasons.push(`${Analyzer.METRIC_CN[k]}劣化 ${nf(d, 1)}（${a0.metrics[k]} → ${a1.metrics[k]}）`);
    }
    return { ok: reasons.length === 0, gain, reasons };
  },

  /* op 级门：只要求「不劣化 + 不越界」。
   * 为什么不要求单 op 就有 0.05 分增益：一次字号归一可能只值 0.03 分，
   * 但它不欠账，十几条累加才有整轮的量级；用整轮阈值卡单 op 会全部误杀。
   * 参考：op 级归因让「9 个正确 op + 1 个坏 op」的轮次从整体回滚变成 9 条生效。 */
  checkOp(a0, a1) {
    const reasons = [];
    const gain = r2(a1.score - a0.score);
    if (gain <= this.MIN_GAIN_OP) reasons.push(`该批未带来提升（${a0.score} → ${a1.score}，Δ${gain}）`);
    for (const k of Object.keys(this.GUARD)) {
      const d = r2(a1.metrics[k] - a0.metrics[k]);
      if (d < this.GUARD[k]) reasons.push(`${Analyzer.METRIC_CN[k]}劣化 ${nf(d, 1)}（${a0.metrics[k]} → ${a1.metrics[k]}）`);
    }
    return { ok: reasons.length === 0, gain, reasons };
  }
};

const Pipeline = {
  MAX_STEPS: 16,     /* 单轮内「应用一批 → 重算 → 重规划」的最大步数（issue 共 8 类，留一倍余量） */

  /* 只算不改：给 Proposed 视图与「仅预览」用 */
  async preview(rt, ir, an, strategy, temp, sopt) {
    const dec = await LayaDecide.run(ir, an, strategy, temp, sopt);
    const pl = Geo.plan(ir, an, dec, Object.assign({}, sopt, { style: styleKey(dec.applied.style) }));
    return { dec, pl };
  },

  /* 完整自修复闭环 */
  async beautify(rt, svgText, opts) {
    const o = Object.assign({ strategy: 'rule', temp: 3, maxRounds: 4, sopt: {}, dryRun: false }, opts || {});
    const t0 = nowMs();
    let load = rt.load(svgText);
    if (!load.ok) return { ok: false, err: load.err || '载入失败' };
    let ir = IR.build(rt, o.sopt);
    if (!ir.ok) return { ok: false, err: ir.err || 'IR 构建失败' };
    let an = Analyzer.run(ir, o.sopt);

    const beforeSvg = rt.exportString();
    const before = {
      score: an.score, metrics: Object.assign({}, an.metrics), counts: Object.assign({}, an.counts),
      issues: an.issues.length, stats: Object.assign({}, ir.stats), dialect: ir.dialect,
      raw: { overlap: an.raw.collision.count, overflow: an.raw.textFit.count, misalign: an.raw.alignment.count,
             spacing: an.raw.spacing.count, crossing: an.raw.edgeRouting.count, alignErr: an.raw.alignment.error,
             spacingCv: an.raw.spacing.cv, utilization: an.raw.canvas.utilization,
             canvasOverflow: an.raw.canvas.overflow, margins: an.raw.canvas.margins,
             tiny: an.counts.tiny_element || 0 },
      canvas: { w: ir.canvas.w, h: ir.canvas.h }
    };
    const ledger = [];
    let lastPlan = null, lastDec = null;
    const proposed = [];

    if (o.dryRun) {
      const pv = await this.preview(rt, ir, an, o.strategy, o.temp, o.sopt);
      lastPlan = pv.pl; lastDec = pv.dec;
      for (const op of pv.pl.ops) proposed.push({ target: op.label, strategy: op.strategy, issue: op.issueType, why: op.why, preview: op.preview });
      return { ok: true, dryRun: true, before, after: before, ledger, finalSvg: beforeSvg, ops: pv.pl, dec: pv.dec, skipped: pv.pl.skipped, ms: r2(nowMs() - t0) };
    }

    for (let round = 1; round <= o.maxRounds; round++) {
      if (!an.issues.length) { ledger.push({ round, stopped: '无剩余问题', before: an.score, after: an.score, commit: true }); break; }

      const roundStartSvg = rt.exportString();
      const roundStart = { score: an.score, metrics: Object.assign({}, an.metrics), issues: an.issues.length };
      const reject = [];          /* 本轮 op 级门淘汰的 itemKey */
      const steps = [];           /* 逐批台账 */
      const acceptedTails = [];   /* 已随批生效的画布收尾 */
      let dec0 = null, plan0 = null, firstPlan = null;
      let guard = 0;

      /* ---------- 逐 op 生效校验（op 级归因）----------
       * 为什么不是「整轮一次性应用 + 整轮判定」：一轮里常常是「9 个正确 op + 1 个坏 op」，
       * all-or-nothing 会让 9 个正确的也一起被丢弃，整轮归零（实测 3/22 用例死在这里）。
       * 这里改成：按阶段顺序逐个 op 应用 → 立即重算分并单独过 op 级门 →
       * 被拒的立刻回滚到该 op 之前的子快照，并把该条 issue 记入本轮黑名单后**重新规划**
       * （元素释放后，原先被 owner 占用的策略重新可行，所以必须重规划而不是跳过）。
       * 决策只跑一次（dec0），重规划复用同一份决策 → 符合 §21「一次前向回答全部问题」。 */
      while (guard++ < this.MAX_STEPS) {
        const sopt2 = Object.assign({}, o.sopt, { reject });
        const pv = await this.preview(rt, ir, an, o.strategy, o.temp, sopt2);
        if (!dec0) { dec0 = pv.dec; plan0 = pv.pl; firstPlan = pv.pl; }
        if (!pv.pl.ops.length) break;

        /* ★ 用户在「美化改动清单」里取消勾选的项，在**组装 batch 之前**就滤掉。
         * 为什么放在这里而不是 gate 之后：被取消的项若先执行、再靠门失败回滚，
         * 就会连带触发一次 apply→重算→rt.load 回滚的整轮抖动，而且它还会在
         * claim 阶段占用 owner，把同一元素上其它本来可行的 op 挤掉。
         * 提前过滤等于「这项从未存在」，语义干净。
         * 过滤后若本步一个 op 都不剩，直接结束循环（队列已空）。 */
        const allow = isFn(o.opAllow) ? o.opAllow : null;
        const opsLive = allow ? pv.pl.ops.filter(allow) : pv.pl.ops;
        if (!opsLive.length) break;

        /* ★ 生效校验的最小单元 = 「一条 issue 的完整修复动作」，不是单个 op。
         * 理由一：rebalance_canvas / distribute_equal 是原子组 op —— 只平移一半元素
         *         会让留白更不对称，逐 op 判定必然把整组拆散（实测 canvas 97.9→97.9 归零）。
         * 理由二：撑大内容盒的 op（grow_to_min / resize_container / wrap_text）必须把
         *         「画布收尾」算进同一次校验，否则单看 op 就是 canvas 维度劣化 → 误杀。 */
        const first = opsLive[0];
        const gateKey = first.gateKey || ('#' + (first.strategy || '') + '|' + (first.label || ''));
        const batch = opsLive.filter(o => (o.gateKey || gateKey) === gateKey);
        const preSvg = rt.exportString();
        const preAn = an;
        const tailInfos = [];
        let a2 = null;
        try {
          Patch.applyAll(batch);
          /* 批内画布收尾：为「撑大内容盒」的批准备对称留白 */
          const iT = IR.build(rt, o.sopt);
          const aT = iT.ok ? Analyzer.run(iT, o.sopt) : null;
          if (aT) {
            const t = Geo.canvasTail(iT, aT, plan0 ? plan0.style : null, o.canvasPad);
            if (t.ops.length) {
              const ta = Patch.applyAll(t.ops);
              tailInfos.push({ grow: t.grow, canvas: t.canvas, dx: t.dx, dy: t.dy, n: t.ops.length, applied: ta.applied.length, errors: ta.errors });
            }
          }
          const i2 = IR.build(rt, o.sopt);
          a2 = i2.ok ? Analyzer.run(i2, o.sopt) : null;
          if (a2) {
            const c = Validator.checkOp(preAn, a2);
            const row = {
              i: steps.length + 1, kind: batch.map(o => o.kind).join('+'), strategy: first.strategy, issue: first.issueType,
              target: batch.map(o => o.label || '').join(' ; '), itemKey: gateKey, why: first.why || '',
              nOps: batch.length, tail: tailInfos, before: preAn.score, after: a2.score, gain: c.gain, accept: c.ok
            };
            if (c.ok) { ir = i2; an = a2; acceptedTails.push(...tailInfos); steps.push(row); continue; }
            row.reasons = c.reasons; steps.push(row);
          } else {
            steps.push({ i: steps.length + 1, strategy: first.strategy, issue: first.issueType,
                         target: first.label || '', itemKey: gateKey, nOps: batch.length,
                         accept: false, reasons: ['应用后 IR 构建/分析失败'] });
          }
        } catch (e) {
          steps.push({ i: steps.length + 1, strategy: first.strategy, issue: first.issueType,
                       target: first.label || '', itemKey: gateKey, nOps: batch.length,
                       accept: false, reasons: ['apply 抛错: ' + (e && e.message)] });
        }
        /* 回滚到本批之前（DOM 被整体替换，必须重建 IR/分析态），并屏蔽该条 issue */
        rt.load(preSvg);
        ir = IR.build(rt, o.sopt);
        an = Analyzer.run(ir, o.sopt);
        reject.push(gateKey);
      }
      const accepted = steps.filter(s => s.accept).length;
      const rejected = steps.length - accepted;
      const applyErrors = steps.filter(s => (s.reasons || []).join('').indexOf('apply 抛错') >= 0)
        .map(s => ({ op: s.target, err: (s.reasons || [])[0] }));

      const rec = {
        round, strategy: o.strategy, phase: plan0 ? plan0.phase : '-', style: plan0 ? plan0.style : null,
        issuesIn: roundStart.issues, issueTypes: plan0 ? Object.keys(plan0.byType) : [],
        decisions: dec0 ? Object.keys(dec0.applied).map(k => ({
          q: k, choice: dec0.applied[k].choice, source: dec0.applied[k].source,
          ruleChoice: dec0.applied[k].ruleChoice, fallback: dec0.applied[k].fallback,
          conf: dec0.applied[k].conf, spread: dec0.applied[k].spread
        })) : [],
        gate: dec0 ? dec0.gate : null,
        planDbg: plan0 ? (plan0.dbg || []) : [],
        chosen: dec0 ? Object.keys(dec0.applied).filter(k => k.indexOf('strategy_') === 0)
          .map(k => k.replace('strategy_', '') + '→' + dec0.applied[k].choice) : [],
        steps, accepted, rejected, rejectedKeys: reject.slice(),
        ops: Patch.record(firstPlan ? firstPlan.ops : [], round),
        skipped: (firstPlan ? firstPlan.skipped : []).map(s => ({ why: s.skipped, strategy: s.strategy, issue: s.issueType, target: s.target || '' })),
        before: roundStart.score, beforeMetrics: roundStart.metrics
      };
      rec.applyErrors = applyErrors;

      if (!accepted) {
        rec.commit = false; rec.note = accepted === 0 && rejected === 0 ? '本轮未产出可执行 op' : '本轮全部 op 被 op 级门淘汰';
        ledger.push(rec); break;
      }

      /* ---------- 轮末画布收尾（兜底）----------
       * 批内收尾已经跑过（见 acceptedTails），这里再跑一次是为了覆盖
       * 「批全部被拒但状态仍有留白失衡」的情形。canvastail 幂等且从不缩小画布，
       * 已平衡时返回 0 个 op，因此这次调用在正常情况下是空操作。 */
      const irT = IR.build(rt, o.sopt);
      const anT = irT.ok ? Analyzer.run(irT, o.sopt) : null;
      rec.afterStage1 = acceptedTails.length ? (steps.filter(s => s.accept).slice(-1)[0] || {}).after : (anT ? anT.score : null);
      if (anT) {
        const tail = Geo.canvasTail(irT, anT, plan0 ? plan0.style : null, o.canvasPad);
        if (tail.ops.length) {
          const ap2 = Patch.applyAll(tail.ops);
          rec.tail = {
            phase: 'round-end', grow: tail.grow, canvas: tail.canvas, dx: tail.dx, dy: tail.dy,
            n: tail.ops.length, applied: ap2.applied.length, errors: ap2.errors,
            ops: Patch.record(tail.ops, round)
          };
        } else {
          rec.tail = { n: 0, grow: false, note: '画布已平衡，无需收尾' };
        }
      } else {
        rec.tail = { n: 0, err: '收尾前 IR 重建失败，跳过收尾' };
      }
      rec.tails = acceptedTails;
      rec.tailN = acceptedTails.reduce((a, t) => a + t.n, 0) + (rec.tail ? rec.tail.n || 0 : 0);

      const ir2 = IR.build(rt, o.sopt);
      const an2 = ir2.ok ? Analyzer.run(ir2, o.sopt) : null;
      if (!an2) {
        rec.commit = false; rec.note = '修改后 IR 构建失败，回滚';
        rt.load(roundStartSvg);
        ir = IR.build(rt, o.sopt); an = Analyzer.run(ir, o.sopt);
        ledger.push(rec); break;
      }
      const chk = Validator.check({ score: roundStart.score, metrics: roundStart.metrics }, an2);
      rec.after = an2.score;
      rec.afterMetrics = Object.assign({}, an2.metrics);
      rec.gain = chk.gain;
      rec.gainStage1 = rec.afterStage1 == null ? null : r2(rec.afterStage1 - roundStart.score);
      rec.gainTail = rec.afterStage1 == null ? null : r2(an2.score - rec.afterStage1);
      rec.commit = chk.ok;
      rec.reasons = chk.reasons;
      rec.afterRaw = { overlap: an2.raw.collision.count, overflow: an2.raw.textFit.count, misalign: an2.raw.alignment.count,
                       spacing: an2.raw.spacing.count, crossing: an2.raw.edgeRouting.count, alignErr: an2.raw.alignment.error,
                       spacingCv: an2.raw.spacing.cv, utilization: an2.raw.canvas.utilization,
                       canvasOverflow: an2.raw.canvas.overflow, margins: an2.raw.canvas.margins };
      ledger.push(rec);

      if (chk.ok) {
        ir = ir2; an = an2;
      } else {
        /* 回滚：恢复快照并重建分析态 */
        rt.load(roundStartSvg);
        ir = IR.build(rt, o.sopt);
        an = Analyzer.run(ir, o.sopt);
        rec.rolledBack = true;
        break;
      }
      lastPlan = plan0; lastDec = dec0;
    }

    const finalSvg = rt.exportString();
    return {
      ok: true, before,
      after: { score: an.score, metrics: Object.assign({}, an.metrics), counts: Object.assign({}, an.counts), issues: an.issues.length, stats: Object.assign({}, ir.stats),
               raw: { overlap: an.raw.collision.count, overflow: an.raw.textFit.count, misalign: an.raw.alignment.count,
                      spacing: an.raw.spacing.count, crossing: an.raw.edgeRouting.count, alignErr: an.raw.alignment.error,
                      spacingCv: an.raw.spacing.cv, utilization: an.raw.canvas.utilization } },
      delta: r2(an.score - before.score),
      tailRounds: ledger.filter(l => l.tail && l.tail.n).length,
      tailCanvasGrow: ledger.filter(l => l.tail && l.tail.grow).length,
      ledger, finalSvg, beforeSvg,
      ops: lastPlan, dec: lastDec, skipped: lastPlan ? lastPlan.skipped : [],
      ms: r2(nowMs() - t0)
    };
  }
};
