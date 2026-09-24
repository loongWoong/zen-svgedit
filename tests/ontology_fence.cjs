/* 内置本体 + 规则围栏：不变量与门禁行为的回归测试（自带合成图，不依赖 gitignored 夹具）。
 *
 * 合成图刻意植入全部被测缺陷：
 *   · 1 个容器框，内有 1 条**越界**横条（左边缘逃出容器 40px）
 *   · 3 个同尺寸方块纵向层叠，左边缘 200/215/230 → 领边散开 30px（模式断裂）
 *   · 2 支箭头从最下方方块向下引出，x=290/305 而方块中心 290 → 锚点错位 0 / 15px
 *   · 1 个 fill=none 的装饰圆环（无标签）+ 1 条 opacity=0.22 的装饰样条
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/ontology_fence.cjs
 */
const { chromium } = require('playwright-core');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const url = 'file:///' + path.resolve(ROOT, 'ui.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600" viewBox="0 0 1000 600">
  <rect id="bg" x="0" y="0" width="1000" height="600" fill="#0b1020"/>
  <rect id="card" x="100" y="100" width="800" height="400" fill="#131a33" stroke="#39d98a"/>
  <rect id="escape" x="60" y="140" width="200" height="40" fill="#1d2a52"/>
  <rect id="b1" x="200" y="140" width="120" height="40" fill="#22407a"/>
  <rect id="b2" x="215" y="200" width="120" height="40" fill="#22407a"/>
  <rect id="b3" x="230" y="260" width="120" height="40" fill="#22407a"/>
  <circle id="ring" cx="500" cy="300" r="60" fill="none" stroke="#39d98a" stroke-width="2"/>
  <path id="a1" d="M290,300 L290,340" stroke="#8ab4ff" stroke-width="2" fill="none"/>
  <path id="a2" d="M305,300 L305,340" stroke="#8ab4ff" stroke-width="2" fill="none"/>
  <path id="deco" d="M0,560 C 300,520 700,600 1000,560" fill="none" stroke="#39d98a" stroke-width="2" opacity="0.22"/>
</svg>`;

(async () => {
  const T = [];
  const ok = (name, cond, extra) => T.push({ name, pass: !!cond, ...(extra !== undefined ? { extra } : {}) });
  const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;

  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const perr = [];
  page.on('pageerror', e => perr.push(String(e && e.message || e).slice(0, 200)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__out && window.__out.stage === 'ready', null, { timeout: 120000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 500));

  const R = await page.evaluate(async (svg) => {
    const o = { svgText: svg };
    const build = () => {
      Runtime.load(svg);
      const ir = IR.build(Runtime, o);
      const an = Analyzer.run(ir, o);
      const ont = Ontology.build(ir, an, o);
      return { ir, an, ont, inv: Ontology.invariants(ont, an) };
    };
    const A = build();

    /* 围栏：顾问 vs 强制 */
    const runFence = async (sopt) => {
      Runtime.load(svg);
      const ir = IR.build(Runtime, o);
      const an = Analyzer.run(ir, o);
      const applied = {};
      /* 直接构造决策结果的最小形态：只有 strategy_<type> 记录（ranks 要真实，否则无从过滤） */
      applied['strategy_overlap'] = { choice: 'move_apart', source: 'rule',
        ranks: [{ key: 'move_apart', score: 9 }, { key: 'global_relayout', score: 5 }] };
      applied['strategy_spacing'] = { choice: 'distribute_equal', source: 'rule',
        ranks: [{ key: 'distribute_equal', score: 9 }, { key: 'distribute_weighted', score: 7 }, { key: 'grow_spacing', score: 4 }] };
      const gate = { relayout: true, safeAll: true };
      const app = JSON.parse(JSON.stringify(applied));
      const tr = Ontology.fence(ir, an, app, gate, sopt);
      return { tr: JSON.parse(JSON.stringify({ mode: tr.mode, ok: tr.ok, conf: tr.conf, fired: (tr.fired || []).map(f => ({ id: f.id, blocked: f.blocked || null, reason: f.reason })), blocked: tr.blocked, notes: tr.notes })), app };
    };
    const adv = await runFence({});
    const enf = await runFence({ ontEnforce: true });

    /* 端到端：顾问模式必须与关闭围栏**完全等价** */
    const e2e = async (sopt) => {
      const rec = await Pipeline.beautify(Runtime, svg, { strategy: 'rule', temp: 3, maxRounds: 4, sopt: Object.assign({}, sopt) });
      return rec && rec.ok ? { score: rec.after.score, delta: rec.delta, svg: rec.finalSvg } : null;
    };
    await e2e({ ontOff: true });                    /* 预热：首次调用与后续不同（见 palantir_value.cjs） */
    const eOff = await e2e({ ontOff: true });
    const eAdv = await e2e({});
    const eEnf = await e2e({ ontEnforce: true });

    return {
      ok: A.ir.ok,
      screen: { w: A.ir.canvas.w, h: A.ir.canvas.h },
      stats: A.ont.stats, conf: A.ont.conf, inv: A.inv, notes: A.ont.notes,
      frames: A.ont.frames.map(f => ({ id: f.id, n: f.members.length, box: f.box, members: f.members })),
      contain: A.ont.containViolations.map(v => ({ id: v.nodeId, over: v.overflow, side: v.side, frame: v.frameId })),
      stacks: A.ont.patterns.stacks.map(s => ({ n: s.members.length, lead: s.lead, gaps: s.gaps, cv: s.gapCv, members: s.members })),
      rows: A.ont.patterns.rows.length, radials: A.ont.patterns.radials.length,
      attach: A.ont.attachments.map(a => ({ e: a.edge, end: a.end, node: a.nodeId, kind: a.kind, err: a.err, mis: a.misaligned })),
      attachEdges: [...new Set(A.ont.attachments.map(a => a.edge))],
      deco: A.ont.decorative, degenerate: A.ont.degenerate, patternBreaks: A.ont.patternBreaks,
      summary: Ontology.summary({ ok: true, conf: A.ont.conf, ont: A.ont, gate: { dMax: A.inv.dMax } }),
      adv, enf,
      e2e: { off: eOff, adv: eAdv, enf: eEnf }
    };
  }, SVG);

  /* ---------- A. 本体的事实层 ---------- */
  ok('IR 构建成功', R.ok);
  ok('识别出 1 个容器框（4 张卡片/容器不重复计）', R.frames.length === 1, R.frames.map(f => f.id + ':' + f.n).join(','));
  ok('容器框成员数 = 4（越界条 + 3 个方块；装饰圆环不计入）', R.frames[0] && R.frames[0].n === 4, R.frames[0] && R.frames[0].n);
  /* 归属唯一性：成员表不得重复计数 */
  {
    const all = [];
    for (const f of R.frames) for (const m of f.members) all.push(m);
    ok('归属唯一：成员表无重复', new Set(all).size === all.length, all.join(','));
  }
  ok('装饰件识别：圆环 + 样条', R.deco.nodes.length === 1 && R.deco.edges.length === 1,
     'nodes=' + JSON.stringify(R.deco.nodes) + ' edges=' + JSON.stringify(R.deco.edges));

  /* ---------- B. 容器越界 ---------- */
  ok('容器越界 = 1 条（escape 横条）', R.contain.length === 1, JSON.stringify(R.contain));
  ok('越界量 = 40px 且方向为 left', R.contain[0] && near(R.contain[0].over, 40, 0.5) && R.contain[0].side === 'left',
     R.contain[0] && (R.contain[0].over + '/' + R.contain[0].side));
  ok('containPx 累计 = 40', near(R.inv.containPx, 40, 0.5), R.inv.containPx);

  /* ---------- C. 模式（堆叠）与导引断裂 ---------- */
  ok('识别出 1 个堆叠模式，成员 3', R.stacks.length === 1 && R.stacks[0].n === 3,
     JSON.stringify(R.stacks.map(s => s.n)));
  ok('堆叠领边散开 = 30px（左边缘 200/215/230）', R.stacks[0] && near(R.stacks[0].lead.spread, 30, 0.5),
     R.stacks[0] && R.stacks[0].lead.spread);
  ok('堆叠步距相等 [60,60]（领边步距；cv=0 → 应被判为「无需修正」）',
     R.stacks[0] && R.stacks[0].gaps.length === 2 && near(R.stacks[0].gaps[0], 60, 0.5) && near(R.stacks[0].cv, 0, 0.001),
     R.stacks[0] && JSON.stringify(R.stacks[0].gaps) + ' cv=' + R.stacks[0].cv);
  ok('导引断裂 = 1（仅按模式判定，不按松容差聚类乱报）', R.inv.guideBreaks === 1, R.inv.guideBreaks);
  ok('导引极差 = 30px', near(R.inv.guideSpreadMax, 30, 0.5), R.inv.guideSpreadMax);
  ok('无成行模式、无径向组（不该凭空造模式）', R.rows === 0 && R.radials === 0, R.rows + '/' + R.radials);

  /* ---------- D. 附着与锚点错位 ---------- */
  const attachNode = R.attach[0] && R.attach[0].node;
  ok('附着解析：两支箭头各只锚到最下方方块（不到底的端点不得锚到容器内部空处）',
     R.attachEdges.length === 2 && R.attach.length === 2 &&
     R.attach.every(a => a.node === attachNode) &&
     R.stacks[0] && R.stacks[0].members.indexOf(attachNode) >= 0 && R.attach[0].kind === 'vertical',
     JSON.stringify(R.attachEdges) + ' → ' + JSON.stringify(R.attach.map(a => a.node + '/' + a.kind + '@' + a.err)));
  ok('锚点错位：a1 = 0px，a2 = 15px（按箭头先后顺序）', R.attach.length === 2 &&
     near(R.attach[0].err, 0, 0.5) && near(R.attach[1].err, 15, 0.5),
     JSON.stringify(R.attach.map(a => a.e + '=' + a.err)));
  ok('attachErrMax = 15px，badAnchors = 1', near(R.inv.attachErrMax, 15, 0.5) && R.inv.badAnchors === 1,
     R.inv.attachErrMax + '/' + R.inv.badAnchors);
  ok('退化路径 = 0（竖直连线不得被误判为退化）', R.inv.edgeDegeneracy === 0, R.inv.edgeDegeneracy);

  /* ---------- E. 围栏：顾问模式必须无副作用 ---------- */
  ok('默认模式 = 顾问（advisory）', R.adv.tr.mode === 'advisory', R.adv.tr.mode);
  ok('顾问模式：规则照常命中并给出理由', R.adv.tr.fired.length >= 1 &&
     R.adv.tr.fired.every(f => typeof f.reason === 'string' && f.reason.length > 0),
     JSON.stringify(R.adv.tr.fired.map(f => f.id)));
  ok('顾问模式：不产生任何被挡动作', R.adv.tr.blocked.length === 0, JSON.stringify(R.adv.tr.blocked));
  ok('顾问模式：一条 rule 也不改 choice', R.adv.app.strategy_spacing.choice === 'distribute_equal' &&
     R.adv.app.strategy_overlap.choice === 'move_apart',
     R.adv.app.strategy_spacing.choice + '/' + R.adv.app.strategy_overlap.choice);
  ok('顾问模式：ranks 不被裁剪', R.adv.app.strategy_spacing.ranks.length === 3 && R.adv.app.strategy_overlap.ranks.length === 2,
     R.adv.app.strategy_spacing.ranks.length + '/' + R.adv.app.strategy_overlap.ranks.length);
  ok('contain_guard 在顾问模式下也照常命中（有越界就必须报告）',
     R.adv.tr.fired.some(f => f.id === 'contain_guard'),
     JSON.stringify(R.adv.tr.fired.map(f => f.id)));

  /* ---------- F. 围栏：强制模式必须真的收窄动作集 ---------- */
  ok('强制模式 = enforce', R.enf.tr.mode === 'enforce', R.enf.tr.mode);
  ok('强制模式：attach_guard/contain_guard 打到具体策略上（blocked 非空）',
     R.enf.tr.fired.some(f => f.blocked && f.blocked.length) || R.enf.tr.blocked.length > 0,
     JSON.stringify(R.enf.tr.fired.filter(f => f.blocked).map(f => f.id + ':' + f.blocked.join(','))));
  ok('强制模式：blocked 记录带合法顺位 legal',
     R.enf.tr.blocked.length > 0 && R.enf.tr.blocked.every(b => Array.isArray(b.legal)),
     JSON.stringify(R.enf.tr.blocked));

  /* ---------- G. 端到端：顾问模式与关闭围栏完全等价（零回归） ---------- */
  ok('端到端：顾问模式分数 = 关闭围栏分数', R.e2e.off && R.e2e.adv && R.e2e.off.score === R.e2e.adv.score,
     (R.e2e.off && R.e2e.off.score) + ' vs ' + (R.e2e.adv && R.e2e.adv.score));
  ok('端到端：顾问模式产物与关闭围栏逐字节相同', R.e2e.off && R.e2e.adv && R.e2e.off.svg === R.e2e.adv.svg);
  ok('端到端：强制模式分数不高于顾问（门禁确实生效）',
     R.e2e.enf && R.e2e.adv && R.e2e.enf.score <= R.e2e.adv.score + 1e-9,
     (R.e2e.enf && R.e2e.enf.score) + ' <= ' + (R.e2e.adv && R.e2e.adv.score));

  /* ---------- H. 台账可用性 ---------- */
  ok('summary 含关键事实（容器/附着/越界）', /容器/.test(R.summary) && /附着/.test(R.summary) && /越界/.test(R.summary), R.summary);
  ok('置信度为 0~1 的有限数', typeof R.conf === 'number' && R.conf >= 0 && R.conf <= 1, R.conf);
  ok('页面无 JS 异常', perr.length === 0, perr.join(' | '));

  const total = T.length, pass = T.filter(x => x.pass).length;
  for (const t of T) if (!t.pass) console.log('FAIL  ' + t.name + (t.extra !== undefined ? '  → ' + t.extra : ''));
  console.log(JSON.stringify({ pass, total, failed: T.filter(x => !x.pass).map(x => x.name) }, null, 1));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
