/* 诊断探针：real-02 美化后仍存在「文字被矩形遮挡」的根因定位。
 * 载入原始 real-02 → IR.build → Analyzer.run → 美化（dryRun + 实跑），
 * 导出：nodes / texts / collision.pairs / issues / 美化后是否仍存在该遮挡。
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/diag_overlap.cjs
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const url = 'file:///' + path.resolve(ROOT, 'ui.html').replace(/\\/g, '/');
const svgText = fs.readFileSync(path.resolve(ROOT, 'svg/02_知识如何长出来.svg'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__out && window.__out.stage === 'ready', null, { timeout: 120000 }).catch(() => {});
  await sleep(700);

  const out = await page.evaluate(async (svg) => {
    const o = {};
    Runtime.load(svg);
    const ir = IR.build(Runtime, {});
    const an = Analyzer.run(ir, {});
    o.irOk = ir.ok;
    o.stats = ir.stats;
    o.dialect = ir.dialect;
    // nodes
    o.nodes = ir.nodes.map(n => ({ id: n.id, d: n.describe, bbox: n.bbox, area: Math.round(n.area), labels: n.labels.map(l => l.text) }));
    // texts (free)
    o.texts = ir.texts.map(t => ({ id: t.id, text: t.text, bbox: t.bbox, fontSize: t.fontSize }));
    // collision pairs (node vs node only today)
    o.collisionPairs = an.raw.collision.pairs.map(p => ({ a: p.a, b: p.b, cover: p.cover, rect: p.rect }));
    o.issues = an.issues.map(i => ({ type: i.type, targets: i.targets, cover: i.evidence && i.evidence.cover, where: i.evidence && i.evidence.where }));
    // 具体看 title 文字 vs pill 矩形
    const title = ir.texts.find(t => /成长飞轮/.test(t.text));
    const pill = ir.nodes.find(n => n.describe && /svg_66|持续进化|svg_68/.test(n.describe)) || ir.nodes.find(n => n.bbox && n.bbox.x >= 700 && n.bbox.x <= 760 && n.bbox.w >= 400);
    o.titleNode = title ? { id: title.id, text: title.text, bbox: title.bbox } : null;
    o.pillNode = pill ? { id: pill.id, describe: pill.describe, bbox: pill.bbox } : null;
    if (title && pill) {
      const inter = (a, b) => {
        const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
        const r = Math.min(a.x + a.w, b.x + b.w), bo = Math.min(a.y + a.h, b.y + b.h);
        const w = r - x, h = bo - y; return (w > 0 && h > 0) ? { x, y, w, h } : null;
      };
      o.titleVsPillIntersect = inter(title.bbox, pill.bbox);
    }
    return o;
  }, svgText);

  // 实跑美化，看是否产生解决遮挡的 op
  const run = await page.evaluate(async (svg) => {
    Runtime.load(svg);
    const rec = await Pipeline.beautify(Runtime, svg, { strategy: 'rule', temp: 3, maxRounds: 4, sopt: {} });
    const o = { ok: rec.ok, before: rec.before && rec.before.score, after: rec.after && rec.after.score,
      delta: rec.delta, acc: 0, rej: 0, rounds: (rec.ledger || []).length };
    o.ops = [];
    (rec.ledger || []).forEach(L => {
      o.acc += (L.accepted || 0); o.rej += (L.rejected || 0);
      (L.items || []).forEach(it => { if (it.op) o.ops.push({ strategy: it.op.strategy, issue: it.issue && it.issue.type, target: it.op.target, why: it.op.why }); });
    });
    // 最终成品里 title 与 pill 的位置
    Runtime.load(svg);
    const irA = IR.build(Runtime, {});
    const anA = Analyzer.run(irA, {});
    return o;
  }, svgText);

  console.log(JSON.stringify({ diag: out, run }, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
