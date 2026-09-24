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

  /* ★ 确定性遮挡消解预通行（正确性缺陷，强制先行）
   * 文字被不透明形状遮挡 = 信息不可读，属正确性缺陷，不应依赖策略优化器的
   * critical 门（该门会过滤掉严重遮挡，见 06 plan() 的 i.priority!=='critical'
   * 过滤），否则高严重度的遮挡反而被漏修。这里在优化轮之前，用 z-order 提升
   * 把被盖文字直接提到遮挡形状之上渲染（视觉位置由 CTM 补偿保持不变），保证可见。
   * 循环收敛：每轮消解后重建 IR 复检，直到无遮挡或连续两轮无进展（guard）。 */
  _resolveOcclusions(rt, sopt, out) {
    const applied = [];
    const errors = (out && out.errors) || null;
    let guard = 0;
    for (;;) {
      if (guard++ > 24) break;
      const ir = IR.build(rt, sopt);
      if (!ir.ok) break;
      const an = Analyzer.run(ir, sopt);
      const items = (an.raw.occlusion && an.raw.occlusion.items) || [];
      if (!items.length) break;
      let did = false;
      for (const oc of items) {
        if (!oc.textRef || !oc.shapeRef) continue;
        const op = Geo.opRaiseText(ir, an, oc, 'raise_text', null);
        if (op && typeof op.apply === 'function') {
          try { op.apply(); applied.push(op.label || oc.textDesc); did = true; }
          catch (e) {
            /* 单个失败不影响其余；但**不再无声**（F10）：正确性缺陷这条路径的失败必须可见 */
            if (errors) errors.push({ op: op.label || oc.textDesc, err: e && e.message ? e.message : String(e) });
          }
        }
      }
      if (!did) break;
    }
    return applied;
  },

  /* ---------- F1：按单元尝试提交 ----------
   * 应用一组 op（每个单元内部仍然原子），然后走完整条校验链：
   *   应用 → 重建 IR → 画布收尾 → 重建 IR/分析 → op 级门
   * 成功时**保持已应用**并返回新的分析态（供调用方作为后续单元的比较基线）；
   * 失败时返回 ok:false，由调用方负责回滚到它自己的快照 —— 本函数不做回滚，
   * 因为慢路径里每个单元的回滚点是不同的。
   * 顺带修掉一个既有缺陷：旧代码 `Patch.applyAll(batch)` 丢弃了返回的 errors，
   * 于是 `op.apply` 内部的异常被静默吞掉，「apply 抛错」这条理由实际只可能来自
   * IR/Analyzer 抛错。这里改为显式检查 errors 并作为失败理由上报。 */
  _tryUnits(rt, baseAn, units, o, plan0) {
    const tails = [];
    try {
      for (const u of units) {
        const app = Patch.applyAll(u);
        if (app.errors.length) {
          return { ok: false, gain: 0, tails, errors: app.errors,
                   reasons: app.errors.map(e => `apply 抛错: ${e.op}（${e.err}）`) };
        }
      }
      /* 批内画布收尾：为「撑大内容盒」的批准备对称留白（语义同旧版 210-219） */
      const iT = IR.build(rt, o.sopt);
      const aT = iT.ok ? Analyzer.run(iT, o.sopt) : null;
      if (aT) {
        const t = Geo.canvasTail(iT, aT, plan0 ? plan0.style : null, o.canvasPad);
        if (t.ops.length) {
          const ta = Patch.applyAll(t.ops);
          tails.push({ grow: t.grow, canvas: t.canvas, dx: t.dx, dy: t.dy, n: t.ops.length,
                       applied: ta.applied.length, errors: ta.errors });
          if (ta.errors.length) {
            return { ok: false, gain: 0, tails, errors: ta.errors,
                     reasons: ta.errors.map(e => `画布收尾抛错: ${e.op}（${e.err}）`) };
          }
        }
      }
      const i2 = IR.build(rt, o.sopt);
      if (!i2.ok) return { ok: false, gain: 0, tails, reasons: ['应用后 IR 构建失败'] };
      const a2 = Analyzer.run(i2, o.sopt);
      const c = Validator.checkOp(baseAn, a2);
      return { ok: c.ok, ir: i2, an: a2, gain: c.gain, reasons: c.reasons, tails };
    } catch (e) {
      return { ok: false, gain: 0, tails, reasons: ['apply 抛错: ' + (e && e.message ? e.message : String(e))] };
    }
  },

  /* 把一个 batch 按 item 拆成单元。itemKey 在 06 的 claim() 里就已挂好
   * （`cur.type + '|' + targets.join(',')`），这里只是把它提升为提交单元。 */
  _groupByItem(ops) {
    const map = new Map(), order = [];
    for (const op of ops) {
      const k = op.itemKey || ('#' + (op.label || '') + '|' + (op.kind || ''));
      if (!map.has(k)) { map.set(k, []); order.push(k); }
      map.get(k).push(op);
    }
    return order.map(k => map.get(k));
  },

  /* 完整自修复闭环 */
  async beautify(rt, svgText, opts) {
    const o = Object.assign({ strategy: 'rule', temp: 3, maxRounds: 4, sopt: {}, dryRun: false }, opts || {});
    /* ★F5 区域命名：beautify 收到的 svgText 是**作者原始文档** —— 全部 11 个调用点
     * （ui.html / dev.html / 各 tests / sweep）传的都是 s.svg 或 smp.svg。
     * 这是唯一可靠的设计意图来源：svgcanvas 的 identifyLayers() 会把非 layer 元素
     * 重挂进新建的 g.layer，注释节点留在 #svgcontent 原位，于是「注释紧邻区元素」
     * 这层关系在载入后**永久丢失**（实测 9 个区的 name 全为 ''）。
     * 之所以挂在 o.sopt 上、而不是记在 Runtime 上：Pipeline 内部的 rt.load(preSvg/uSvg)
     * 回滚只换 DOM 不换这个字段，因此**全程（含每次 _tryUnits 重算）区域名恒定**。
     * 若改记在 Runtime 上，第一次回滚就会用「导出串」（注释已丢）覆盖掉原文，
     * hierarchy 维度会随重算抖动，评分失去幂等性。 */
    if (typeof svgText === 'string' && svgText.length) o.sopt = Object.assign({}, o.sopt, { svgText });
    /* ★F11 根因修复（配套）：把**作者画布**尺寸一并钉进 sopt，理由见 03_ir.js 里 isBg 的注释。
     * 此刻 DOM 刚载入、canvasTail 还没跑过，读到的就是作者尺寸。 */
    {
      const aw = parseFloat(rt.canvas && rt.canvas.contentW), ah = parseFloat(rt.canvas && rt.canvas.contentH);
      if (isFinite(aw) && aw > 0 && isFinite(ah) && ah > 0) {
        o.sopt = Object.assign({}, o.sopt, { authoredCanvas: { w: aw, h: ah } });
      }
    }
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
    const proposed = [];        /* dryRun 的预览清单（旧版构造后未返回，F10 已补进返回值） */
    /* ★ F2：跨轮失败记忆。gateKey → 已在多少轮中失败。
     * 为什么不用「永久黑名单」：元素在后续轮次被释放后，原先不可行的策略会重新可行
     * （正是下面重规划那段注释所说的理由）。永久拉黑会挡掉这种情形；
     * 只做「重试次数上限」既避免无限重复，又保留状态变化后的第二次机会。
     * 实测动机：本体图轮 2 把轮 1 的 9 条失败**逐条重试**后再全部淘汰，整轮空转。 */
    const attempts = new Map();
    const maxAttempts = o.maxAttempts == null ? 2 : o.maxAttempts;

    if (o.dryRun) {
      const pv = await this.preview(rt, ir, an, o.strategy, o.temp, o.sopt);
      lastPlan = pv.pl; lastDec = pv.dec;
      for (const op of pv.pl.ops) proposed.push({ target: op.label, strategy: op.strategy, issue: op.issueType, why: op.why, preview: op.preview });
      return { ok: true, dryRun: true, before, after: before, ledger, finalSvg: beforeSvg, ops: pv.pl, proposed, dec: pv.dec, skipped: pv.pl.skipped, ms: r2(nowMs() - t0) };
    }

    /* 确定性遮挡消解预通行：文字被不透明形状遮挡是正确性缺陷，必须在优化轮之前强制消解，
     * 否则严重遮挡会被策略优化器的 critical 门漏掉（见 06 plan() 过滤）。 */
    const occOut = { errors: [] };
    const occFixed = this._resolveOcclusions(rt, o.sopt, occOut);
    if (occFixed.length) {
      ir = IR.build(rt, o.sopt);
      an = Analyzer.run(ir, o.sopt);
    }

    for (let round = 1; round <= o.maxRounds; round++) {
      if (!an.issues.length) { ledger.push({ round, stopped: '无剩余问题', before: an.score, after: an.score, commit: true }); break; }

      const roundStartSvg = rt.exportString();
      const roundStart = { score: an.score, metrics: Object.assign({}, an.metrics), issues: an.issues.length };
      const reject = [];          /* 本轮 op 级门淘汰的 gateKey（立即抑制，语义同旧版） */
      const rejectItems = [];     /* ★ F1：本轮按 item 提交失败的 itemKey（item 级归因，本轮内不再产出） */
      /* ★ F1：本轮子集搜索的校验预算（每次 _tryUnits = 一次打分）。
       * 二分搜索找「一个坏 op」约需 2·log2(n) 次；整批全坏时最坏 2n−1 次。
       * 20 次足以覆盖 n≈24 的常见规模，同时把最坏耗时钉住（本体图整轮约 0.7s）。 */
      const budget = { left: o.unitBudget == null ? 20 : o.unitBudget };
      const steps = [];           /* 逐批台账 */
      const acceptedTails = [];   /* 已随批生效的画布收尾 */
      const committedOps = [];    /* ★ F10：真正生效的 op（rec.appliedOps 的来源） */
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
        /* ★ F2：有效黑名单 = 本轮已失败者 ∪ 跨轮已达重试上限者 */
        const capped = [];
        if (attempts.size) { for (const kv of attempts) { if (kv[1] >= maxAttempts) capped.push(kv[0]); } }
        const sopt2 = Object.assign({}, o.sopt, {
          reject: capped.length ? reject.concat(capped) : reject,
          rejectItems
        });
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
         *         「画布收尾」算进同一次校验，否则单看 op 就是 canvas 维度劣化 → 误杀。
         *
         * ★ F1：把「原子性」从隐含假设改成**显式分级**（Geo.ATOMIC）。
         * 上面两条理由只对**天然原子**的类型成立（整幅平移 / 整行等距 / 整组重路由）；
         * text_overflow / style_inconsistency / tiny_element 等是**逐 item 独立**的，
         * 整类捆绑会让「9 个 item 对、1 个 item 错」退化成整类丢弃 ——
         * 实测：move_text(10 op) 与 normalize_style(24 op) 被整类淘汰，两类问题一条没修。
         * 因此：原子类型维持整批提交；非原子类型在整批失败后**按 item 增量提交**，
         * 每个 item 内部仍然原子，每个单元仍然过同一个 op 级门 —— 只会「少丢」，不会「多改」。 */
        const first = opsLive[0];
        const gateKey = first.gateKey || ('#' + (first.strategy || '') + '|' + (first.label || ''));
        const batch = opsLive.filter(o => (o.gateKey || gateKey) === gateKey);
        const preSvg = rt.exportString();
        const preAn = an;
        const mode = (typeof Geo.atomicity === 'function') ? Geo.atomicity(first.issueType) : 'whole';
        const mkRow = extra => Object.assign({
          i: steps.length + 1, kind: batch.map(x => x.kind).join('+'), strategy: first.strategy,
          issue: first.issueType, target: batch.map(x => x.label || '').join(' ; '),
          itemKey: gateKey, why: first.why || '', nOps: batch.length, before: preAn.score
        }, extra);

        /* 快路径：整批一次提交（保持既有原子语义，绝大多数情况走这条） */
        const whole = this._tryUnits(rt, preAn, [batch], o, plan0);
        if (whole.ok) {
          ir = whole.ir; an = whole.an;
          acceptedTails.push(...whole.tails);
          committedOps.push(...batch);
          steps.push(mkRow({ tail: whole.tails, after: an.score, gain: whole.gain, accept: true, mode: 'whole' }));
          continue;
        }
        /* 整批失败：先恢复到 preSvg（慢路径必须从干净态出发），再决定后续策略 */
        rt.load(preSvg);
        ir = IR.build(rt, o.sopt);
        an = Analyzer.run(ir, o.sopt);
        /* 失败批次的「若提交」分数仍记录进台账（沿用旧版语义，供人工判读） */
        const failAfter = whole.an ? whole.an.score : preAn.score;

        /* 非原子类型 + 批次够大 + 还有预算 → item 级增量提交；否则维持旧行为 */
        const canSplit = mode !== 'whole' && batch.length >= 3 && budget.left > 0;
        if (!canSplit) {
          attempts.set(gateKey, (attempts.get(gateKey) || 0) + 1);
          reject.push(gateKey);
          steps.push(mkRow({ tail: whole.tails, after: failAfter, gain: whole.gain,
                             accept: false, mode, reasons: whole.reasons }));
          continue;
        }

        /* ★F1 强化：整批失败后不再只做「逐 item 提交」，而是**二分搜索可用子集**。
         * 为什么逐 item 不够（实测 tests/diag_batch.cjs + 本体图台账）：
         * normalize_style 的 24 个 op 里只有**第 7 个**有害 —— 它把一段文字的字号 16→18px，
         * 于是文字探到文档序更靠后的不透明容器下 → occlusion 由 0 变 2 →
         * occlusion.density = 0.5 恰好等于 collSat → metrics.collision 从 96 塌到 0
         * → **整批 24 op 被一并否决**。此时逐 item 提交完全无效：单个字号改动自身的
         * Δ≈0，而 op 级门要求 Δ>0 严格提升 → 24 个单元全数落空 → 「23 个中性 op + 1 个毒 op」
         * 的批次一条也修不成。这是「一键美化对该图几乎不动」的直接原因。
         * 二分把「整批过/不过」扩展成「闭区间内找一个能过门的子集」：
         *   try(S) 通过 → 整段提交；|S|=1 仍不过 → 记为坏单元；
         *   否则对半拆分递归。毒 op 数为 b 时约需 O(b·log(n/b)) 次校验。
         * ★ 安全性（为什么不会让结果变差）：每一次提交都必须先过**同一个 op 级门**
         *   （_tryUnits → applyAll → IR/Analyzer 重算 → Validator.checkOp），
         *   并且每个单元的 `gain` 都是相对**当前已提交状态**测得的。
         *   因此本算法只可能「额外提交已被证明有提升的子集」，不可能引入劣化 ——
         *   最坏情况是什么都不提交，与旧行为等价。 */
        const units = this._groupByItem(batch);
        const unitRows = [];
        const committed = [];
        let curAn = preAn;
        /* 二分搜索作用在**单元（item）**上，不是裸 op 上 —— 保证同一 item 的多个 op
         * 永远整体提交/整体否决，不会把「改尺寸」和它配套的「文字归位」拆开。
         * sub.length === 1 时即退化为原来的逐 item 提交，故本算法**严格包含**旧行为。 */
        const trySub = (sub, depth) => {
          if (!sub.length) return;
          const flat = sub.length === 1 ? sub[0] : [].concat.apply([], sub);
          if (budget.left <= 0) {
            unitRows.push({ itemKey: sub[0][0].itemKey || '', nUnits: sub.length, skipped: '单元预算耗尽' });
            return;
          }
          budget.left--;
          const sSvg = rt.exportString();
          const r = this._tryUnits(rt, curAn, [flat], o, plan0);
          if (r.ok) {
            committed.push(...flat); curAn = r.an; acceptedTails.push(...r.tails);
            unitRows.push({ itemKey: sub[0][0].itemKey || '', nUnits: sub.length, nOps: flat.length, accept: true, gain: r.gain, depth });
            return;
          }
          rt.load(sSvg);
          if (sub.length === 1) {
            /* 单个 item 都过不了门 → 按 (策略, item) 记黑名单，本轮不再重复产出。
             * 必须是二元组：只按 item 记会连带封杀同类问题在该 item 上的其它策略
             * （实测 real-02 / real-03 各丢一次本会被接受的 resize_container）。 */
            const o0 = sub[0][0];
            if (o0.itemTargets !== undefined) {
              rejectItems.push((o0.gateKey || gateKey) + '|' + o0.itemTargets);
            }
            unitRows.push({ itemKey: o0.itemKey || '', nUnits: 1, nOps: flat.length, accept: false, gain: r.gain, reasons: r.reasons, depth });
            return;
          }
          const mid = Math.ceil(sub.length / 2);
          trySub(sub.slice(0, mid), depth + 1);
          trySub(sub.slice(mid), depth + 1);
        };
        trySub(units, 0);

        if (committed.length) {
          /* 部分单元存活：DOM 已停在「已提交单元」的状态上，直接重建分析态即可 */
          ir = IR.build(rt, o.sopt);
          an = Analyzer.run(ir, o.sopt);
          committedOps.push(...committed);
          steps.push(mkRow({ target: committed.map(x => x.label || '').join(' ; '),
                             nOps: committed.length, nPlanned: batch.length, mode: 'item',
                             units: unitRows, tail: [],
                             after: an.score, gain: r2(an.score - preAn.score), accept: true }));
          continue;
        }
        /* 一个单元都没活下来 → 回到 preSvg 并拉黑该 gateKey */
        rt.load(preSvg);
        ir = IR.build(rt, o.sopt);
        an = Analyzer.run(ir, o.sopt);
        attempts.set(gateKey, (attempts.get(gateKey) || 0) + 1);
        reject.push(gateKey);
        steps.push(mkRow({ mode: 'item', units: unitRows, tail: whole.tails,
                           after: failAfter, gain: whole.gain, accept: false, reasons: whole.reasons }));
      }
      const accepted = steps.filter(s => s.accept).length;
      const rejected = steps.length - accepted;
      const applyErrors = steps.filter(s => (s.reasons || []).join('').indexOf('apply 抛错') >= 0)
        .map(s => ({ op: s.target, err: (s.reasons || [])[0] }));
      const attemptsSnap = {};
      for (const kv of attempts) attemptsSnap[kv[0]] = kv[1];

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
        steps, accepted, rejected, rejectedKeys: reject.slice(), rejectedItems: rejectItems.slice(),
        /* ★ F10：rec.ops 的旧语义其实是「本轮首步的**计划**」（含被 opAllow 拒绝、被门淘汰者），
         * 与「实际生效集」不是一回事。保留 ops 字段名（UI 兼容），同时补上两个语义明确的新字段：
         *   plannedOps —— 计划集（旧 ops 的真实含义）
         *   appliedOps —— 真正生效集（来自被接受的 batch / 单元） */
        ops: Patch.record(firstPlan ? firstPlan.ops : [], round),
        plannedOps: Patch.record(firstPlan ? firstPlan.ops : [], round),
        appliedOps: Patch.record(committedOps, round),
        attempts: attemptsSnap,
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
      occFixed, occFixedCount: occFixed.length, occErrors: occOut.errors,
      ledger, finalSvg, beforeSvg,
      ops: lastPlan, dec: lastDec, skipped: lastPlan ? lastPlan.skipped : [],
      ms: r2(nowMs() - t0)
    };
  }
};
