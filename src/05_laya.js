/* =============================================================================
 * SVG Beautifier · 05 Laya 决策层（System-1）
 *
 * 职责边界（设计文档 §5 / §18 / §21）：Laya 只回答「做什么」，
 *   ✓ 问题类型 / 修复策略 / 优先级 / 风格 / 是否重排 / 是否可自动修
 *   ✗ 绝不输出 x=438.27 y=721.82 这类连续数值（那属于几何引擎）
 *
 * 三种策略与仓库 labs 一致：
 *   rule  — 规则主判（硬门 + 可行性预检），后端不可用也能跑
 *   mix   — 规则给出窄带候选，模型只在带内破平
 *   model — 模型原样，用于对照（非法/带外选择会回退并留痕）
 *
 * 一次前向回答全部问题（README：forward_passes = 1）。
 * ===========================================================================*/
'use strict';

const Laya = {
  base: null,
  ok: false,
  async probe() {
    const cands = location.protocol === 'file:'
      ? ['http://127.0.0.1:8771']
      : ['', 'http://127.0.0.1:8771'];
    for (const c of cands) {
      try {
        const r = await fetch(c + '/api/health', { method: 'GET', cache: 'no-store' });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.ok) { this.base = c; this.ok = true; return c; }
      } catch (e) { /* 下一个候选 */ }
    }
    this.base = null; this.ok = false; return null;
  },
  async post(path, body) {
    const opt = { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await fetch(this.base + path, opt);
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch (e) { throw new Error('非 JSON 响应: ' + t.slice(0, 160)); }
    if (!j.ok) throw new Error(j.error || 'unknown error');
    return j;
  },
  async predict(state, questions, temp) {
    const j = await this.post('/api/predict', {
      state, questions,
      config: { temperature_mode: 'manual', temperature_manual: [temp || 3, 1, 1] }
    });
    return j.result;
  }
};

/* ============================ 规则引擎 ============================ */
const LayaRule = {
  /* 每类 issue 的候选策略与「设计文档 §16 优先级阶梯」的规则打分 */
  evaluate(ir, an, issue, sopt) { return Geo.evaluate(ir, an, issue, sopt); },

  /* 主导问题 = 最弱维度（确定性） */
  dominant(an) {
    const ks = Analyzer.METRIC_KEYS;
    let worst = ks[0];
    for (const k of ks) if (an.metrics[k] < an.metrics[worst]) worst = k;
    return { key: worst, value: an.metrics[worst] };
  },

  /* issue → 按类型分组。抽成独立方法是为了让几何引擎能在「同一决策、多步重规划」时
   * 重新分组（决策只跑一次前向，item 列表必须随最新分析态刷新）。 */
  groupByType(an) {
    const byType = {};
    for (const it of (an && an.issues) || []) (byType[it.type] = byType[it.type] || []).push(it);
    return byType;
  },

  plan(ir, an, sopt) {
    const o = sopt || {};
    const P = {};
    const byType = this.groupByType(an);

    /* --- 1. 主导问题 --- */
    const dom = this.dominant(an);
    const TYPE2METRIC = { overlap: 'collision', occlusion: 'collision', text_overflow: 'textFit', misalignment: 'alignment', spacing: 'spacing', edge_crossing: 'edgeRouting', style_inconsistency: 'style', canvas_margin: 'canvas', tiny_element: 'collision' };
    const typeScores = {};
    for (const k of Analyzer.METRIC_KEYS) typeScores[k] = an.metrics[k];
    const domType = Object.keys(TYPE2METRIC).filter(t => byType[t])
      .sort((a, b) => typeScores[TYPE2METRIC[a]] - typeScores[TYPE2METRIC[b]])[0] || 'none';
    const domOpts = Object.keys(byType).length ? Object.keys(byType).concat(['none']) : ['none'];
    P.dominant_issue = {
      choice: byType[domType] ? domType : 'none',
      ranks: domOpts.map(k => ({
        key: k, label: k, score: k === domType ? 100 : (typeScores[TYPE2METRIC[k]] !== undefined ? typeScores[TYPE2METRIC[k]] : 60),
        detail: byType[k] ? `${byType[k].length} 项 · 维度分 ${typeScores[TYPE2METRIC[k]]}` : '未检出',
        risky: false
      })).sort((a, b) => a.score - b.score),
      note: `最弱维度 ${dom.key} = ${dom.value}`
    };

    /* --- 2. 修复顺序 --- */
    const sev = t => (byType[t] || []).reduce((a, i) => a + ({ critical: 3, high: 2, medium: 1, low: 0.5 }[i.priority] || 0), 0);
    const ord = [
      { key: 'text_first', label: '先修文字', score: 50 + sev('text_overflow') * 14, detail: `文字问题 ${(byType.text_overflow || []).length} 项` },
      { key: 'geometry_first', label: '先修几何', score: 50 + (sev('overlap') + sev('spacing')) * 9, detail: `重叠 ${(byType.overlap || []).length} / 间距 ${(byType.spacing || []).length}` },
      { key: 'edge_first', label: '先修连线', score: 50 + sev('edge_crossing') * 12, detail: `连线 ${(byType.edge_crossing || []).length} 项` },
      { key: 'global_relayout', label: '整体重排', score: 50 + (Object.keys(byType).length >= 3 ? 40 : 0), detail: '候选数 ≥3 时更优' }
    ].sort((a, b) => b.score - a.score);
    P.fix_order = { choice: ord[0].key, ranks: ord, note: `按严重度加权：${ord.map(r => r.key + '=' + nf(r.score, 0)).join(' ')}` };

    /* --- 3. 风格策略（会真实影响 padding / 字号 / 间距目标） --- */
    const styles = [
      { key: 'minimal', label: '极简', score: 40, detail: 'padding 小、留白大' },
      { key: 'technical', label: '技术图', score: 70, detail: '均衡，架构图默认' },
      { key: 'enterprise', label: '企业', score: 55, detail: 'padding 更宽、字号统一' },
      { key: 'presentation', label: '演示', score: 45, detail: '大字号大间距' },
      { key: 'dense', label: '高密度', score: 35, detail: '紧凑，先保不溢出' }
    ];
    const domType2 = P.dominant_issue.choice;
    if (domType2 === 'style_inconsistency') styles.find(s => s.key === 'enterprise').score += 25;
    if (domType2 === 'spacing' || domType2 === 'misalignment') styles.find(s => s.key === 'technical').score += 15;
    if (ir.stats.nodes > 16) styles.find(s => s.key === 'dense').score += 20;
    styles.sort((a, b) => b.score - a.score);
    P.style = { choice: styles[0].key, ranks: styles, note: `节点数 ${ir.stats.nodes}` };

    /* --- 4. 严重度档位（score 型 primitive） --- */
    const sevLevel = an.score >= 90 ? 0 : an.score >= 75 ? 1 : an.score >= 60 ? 2 : an.score >= 40 ? 3 : 4;
    P.severity = {
      choice: sevLevel, ranks: ['cosmetic', 'minor', 'noticeable', 'serious', 'severe'].map((k, i) => ({ key: k, label: k, score: 50 - Math.abs(i - sevLevel) * 10, detail: i === sevLevel ? '规则判定档' : '' })),
      note: `总分 ${an.score} → 档位 ${sevLevel}`
    };

    /* --- 5. 是否需要整体重排 --- */
    const affected = new Set();
    for (const it of an.issues) if (it.priority === 'critical' || it.priority === 'high') it.targets.forEach(t => affected.add(t));
    const affRatio = ir.stats.nodes ? affected.size / ir.stats.nodes : 0;
    P.should_relayout = { choice: affRatio >= 0.6 ? 1 : 0, ranks: [{ key: 'yes', label: 'yes', score: affRatio >= 0.6 ? 80 : 20, detail: `受影响节点 ${affected.size}/${ir.stats.nodes}` }, { key: 'no', label: 'no', score: affRatio >= 0.6 ? 20 : 80, detail: '' }], note: `受影响占比 ${pct(affRatio)}` };

    /* --- 6. 是否可自动修（把人机边界交给决策层） --- */
    const unfixable = an.issues.filter(i => !i.fixable).length;
    const risky = an.issues.filter(i => i.type === 'tiny_element').length;
    const safeYes = unfixable === 0 && risky === 0;
    P.safe_to_auto_fix = { choice: safeYes ? 1 : 0, ranks: [{ key: 'yes', label: 'yes', score: safeYes ? 85 : 15, detail: `${an.issues.length} 项可候选修复` }, { key: 'no', label: 'no', score: safeYes ? 15 : 85, detail: unfixable ? `${unfixable} 项不可自动修` : risky ? `${risky} 项需人工确认` : '' }], note: safeYes ? '全部可自动修' : '存在需人工确认项' };

    /* --- 7. 每类 issue 的策略选择（几何引擎做可行性预检） --- */
    /* 策略可行性依赖风格参数（padding/间距目标），因此先用规则偏好的风格做预检 */
    const probeOpts = Object.assign({}, o, { style: P.style.choice });
    const strategies = {};
    for (const type of Object.keys(byType)) {
      const cands = [];
      for (const s of (byType[type][0].candidates || [])) {
        const ev = this.evaluate(ir, an, byType[type], s, probeOpts);
        cands.push({ key: s, label: Geo.LABEL[s] || s, score: ev.score, detail: ev.detail, risky: ev.risky, preview: ev.preview || null });
      }
      cands.sort((a, b) => b.score - a.score);
      strategies[type] = cands;
      P['strategy_' + type] = { choice: cands[0].key, ranks: cands, note: `${byType[type].length} 项候选，已做可行性预检` };
    }

    /* 过滤掉「模型选不了」的选项由 LayaDecide 负责 */
    P.__byType = byType;
    P.__strategies = strategies;
    return P;
  }
};

/* ============================ 问题组装 ============================ */
const LayaQ = {
  build(ir, an, plan, sopt) {
    const qs = [];
    const P = plan;
    const toCriteria = ranks => {
      const d = {};
      for (const r of ranks) d[r.key] = r.detail ? `${r.key}: ${r.detail}` : r.label;
      return d;
    };
    qs.push({
      id: 'dominant_issue', type: 'choice',
      instructions: 'Which layout defect dominates this diagram and should be repaired first?',
      criteria: toCriteria(P.dominant_issue.ranks)
    });
    qs.push({
      id: 'fix_order', type: 'choice',
      instructions: 'Which repair phase should be executed first?',
      criteria: toCriteria(P.fix_order.ranks)
    });
    qs.push({
      id: 'style', type: 'choice',
      instructions: 'Which visual style should the repaired diagram target?',
      criteria: toCriteria(P.style.ranks)
    });
    qs.push({
      id: 'severity', type: 'score',
      instructions: 'How severe is the worst layout defect in this diagram?',
      criteria: ['cosmetic', 'minor', 'noticeable', 'serious', 'severe']
    });
    qs.push({
      id: 'should_relayout', type: 'noul',
      instructions: 'Do most nodes participate in a layout defect, so that a global relayout is warranted?'
    });
    qs.push({
      id: 'safe_to_auto_fix', type: 'noul',
      instructions: 'Is every detected defect safe to repair automatically without human review?'
    });
    for (const type of Object.keys(P.__strategies || {})) {
      const cands = P.__strategies[type];
      if (!cands.length) continue;
      qs.push({
        id: 'strategy_' + type, type: 'choice',
        instructions: `How should ${type} defects be repaired?`,
        criteria: toCriteria(cands)
      });
    }
    return qs;
  }
};

/* ============================ 决策合成 ============================ */
const LayaDecide = {
  /* 窄带：在规则候选里取「与最优同档」的集合，模型只能在带内破平 */
  band(ranks, bandV) {
    if (!ranks.length) return [];
    const vs = ranks.map(r => r.score);
    const hi = Math.max(...vs), lo = Math.min(...vs);
    const near = ranks.filter(r => hi - r.score <= bandV * Math.max(1, hi - lo));
    return near.length ? near : ranks.slice(0, 1);
  },

  async run(ir, an, strategy, temp, sopt) {
    const o = sopt || {};
    const plan = LayaRule.plan(ir, an, o);
    const qs = LayaQ.build(ir, an, plan, o);
    const stateText = Analyzer.stateText(ir, an, 'svg layout repair');

    let raw = null, answers = {}, err = null;
    const want = Laya.ok && strategy !== 'rule';
    if (want) {
      try { raw = await Laya.predict(stateText, qs, temp); answers = (raw && raw.answers) || {}; }
      catch (e) { err = e.message; }
    }

    const bandV = typeof o.mixBand === 'number' ? o.mixBand : 0.02;
    /* ★ 「模型说了但等于没说」的判据（实测驱动，见 .svgbuild/st1.json）
     *   同一张图（s11）上 Laya 的原始分布：
     *     dominant_issue  conf=0.872  spread=5.76   ← 真信号
     *     fix_order       conf=0.283  spread=0.624  ← 4 路近均匀 = 噪声
     *     style           conf=0.211  spread=0.482  ← 5 路近均匀 = 噪声
     *     severity        entropy=0.993（0~4 档概率 0.142~0.222）← 满载熵 = 无信息
     *   mix 若照单全收这些噪声答案，实测 22 例均值 99.04(rule) → 98.97(mix)；
     *   而 model 原样更差（96.79）。所以给 mix 加一道**信息量门**：
     *     choice：logit_spread < mixMinSpread(默认 0.5) → 无信息，回退 rule
     *     noul  ：|p − 0.5| < noulMargin(默认 0.25)     → 不确定，回退 rule
     *   默认值的来处（.svgbuild/sw1.json，22 例缺陷样例上的 sweep）：
     *     mixMinSpread  0→Δ均+7.491(采纳46) / 0.25→+7.561(27) / 0.5→+7.561(18)
     *                   / 0.75→+7.561(3) / 1.0→+7.561(3) / 99→+7.561(0)
     *     即 **门只要非零就登顶，0.25 起是平台**；取 0.5 是在平台上再留一半余量，
     *     同时保住模型的实际参与度（采纳 18 次而非 0 次）。
     *     noulMargin   0→+7.561(55) / 0.1→+7.561(52) / ≥0.2→+7.561(3)  同样平坦。
     *   ⚠ 必须诚实记录：在这 22 例上，模型 choice 采纳与不采纳的**最终质量相同**，
     *   门的作用是「防止噪声拖累」(−0.071)，而不是「带来增益」。要证明质量增益需要
     *   更难的基准或走 finetune 路线；本层当前的可交付价值是架构性的（一次 20~30ms
     *   前向替代多轮调用 + 决策可审计 + gate 约束动作空间 + 可 veto）。
     *   为什么只作用于 mix：model 的定位是「原样照收」的**对照臂**，不能被本门修饰，
     *   否则「模型到底行不行」这个对照就失去意义。 */
    const minSpread = typeof o.mixMinSpread === 'number' ? o.mixMinSpread : 0.5;
    const nMargin = typeof o.noulMargin === 'number' ? o.noulMargin : 0.25;
    const applied = {};
    for (const q of qs) {
      const r = plan[q.id];
      if (!r) continue;
      const a = answers[q.id];
      const rec = { id: q.id, type: q.type, choice: r.choice, source: 'rule', fallback: false, band: null,
                    ruleChoice: r.choice, probs: null, conf: null, spread: null, note: r.note, ranks: r.ranks };
      if (a && !err) {
        if (a.type === 'choice') {
          rec.probs = a.probs || {};
          rec.conf = a.confidence; rec.spread = a.logit_spread;
          const keys = r.ranks.map(x => x.key);
          const inSet = keys.indexOf(a.choice) >= 0;
          if (strategy === 'model') {
            if (inSet) { rec.choice = a.choice; rec.source = 'model'; }
            else rec.fallback = true;
          } else {
            const cand = this.band(r.ranks, bandV).map(x => x.key);
            rec.band = cand.slice();
            if (typeof a.logit_spread === 'number' && a.logit_spread < minSpread) {
              rec.fallback = true; rec.noisy = 'spread ' + r2(a.logit_spread) + ' < ' + minSpread;
            } else if (cand.indexOf(a.choice) >= 0) { rec.choice = a.choice; rec.source = 'mix'; }
            else rec.fallback = true;
          }
        } else if (a.type === 'score') {
          rec.score = a.score; rec.entropy = a.entropy_norm; rec.ranked = a.ranking || null;
          if (typeof a.score === 'number' && isFinite(a.score)) rec.level = clamp(Math.round(a.score), 0, 4);
          /* score 类只用于「是否重排」这类辅助判断，不改写 strategy 选择 */
        } else if (a.type === 'noul') {
          rec.noul = a.noul;
          const yes = (a.noul >= 0.5) ? 1 : 0;
          if (strategy === 'model') { rec.choice = yes; rec.source = 'model'; }
          else if (Math.abs(a.noul - 0.5) >= nMargin) { rec.choice = yes; rec.source = 'mix'; }
          else { rec.fallback = true; rec.noisy = 'noul ' + r2(a.noul) + ' 距 0.5 过近'; }
        }
      }
      applied[q.id] = rec;
    }

    /* 后置门禁：由决策层结果直接约束几何引擎的可行动作集 */
    if (applied.should_relayout && !applied.should_relayout.choice) {
      for (const k of Object.keys(applied)) if (k.indexOf('strategy_') === 0)
        applied[k].ranks = applied[k].ranks.filter(x => x.key !== 'global_relayout');
    }
    const safeNo = applied.safe_to_auto_fix && !applied.safe_to_auto_fix.choice;
    const gate = { relayout: !!(applied.should_relayout && applied.should_relayout.choice), safeAll: !safeNo };

    /* ★ 本体 + 规则围栏（05b_ontology.js）
     * 职责：在「分数门」之前再加一道**结构门** —— 分数看不见结构破坏（实测一轮美化
     * +8.4 分的同时把平台栈极差 211.83 改成 266.1、把箭头错位 21.5/42.01 改成 36/72、
     * 把两条 1942/1957px 装饰样条压成一条直线）。围栏只**收窄**动作集，绝不新增动作。
     * 软依赖：本体未加载或构建失败时整体放行（不得因本体报错而阻断修复）。 */
    let fence = null;
    if (typeof Ontology !== 'undefined' && Ontology && Ontology.fence) {
      fence = Ontology.fence(ir, an, applied, gate, o);
      if (fence && fence.gate) Object.assign(gate, fence.gate);
    }

    return { plan, qs, applied, raw, stateText, err, gate, fence, meta: raw && raw.meta ? raw.meta : null };
  }
};
