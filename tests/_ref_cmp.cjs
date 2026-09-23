/* 对照实验：reflow_body 是否引入/遗留了容器越界（#1 的回归风险点）
 *   同一条样例跑两次美化 —— A) 启用 reflow_body  B) 把 reflow_body 从候选里摘掉，
 *   其余完全一致，比较 contain 审计的越界条数与最大越界量。
 *   若两者相同 ⇒ 该越界与 reflow_body 无关（是既有项，不是本次引入的回归）。
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/_ref_cmp.cjs [real-05]
 */
const { chromium } = require('playwright-core');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const url = 'file:///' + path.resolve(ROOT, 'ui.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const want = process.argv[2] || 'real-05';

const AUDIT = () => {
  const rr = R;
  const ir = IR.build(Runtime, {});
  const out = { nOverrun: 0, maxOverrun: 0, rows: [] };
  for (const n of ir.nodes) {
    if (!n.labels || !n.labels.length) continue;
    const g = n.geomBox;
    let worst = 0, wl = null;
    for (const l of n.labels) {
      const over = Math.max(g.x - l.bbox.x, rr.right(l.bbox) - rr.right(g),
        g.y - l.bbox.y, rr.bottom(l.bbox) - rr.bottom(g));
      if (over > worst) { worst = over; wl = l; }
    }
    if (worst > 0.5) out.rows.push({ id: n.id, container: n.describe,
      label: wl ? String(wl.text || '').slice(0, 20) : '', overrun: +worst.toFixed(2) });
  }
  out.nOverrun = out.rows.length;
  out.maxOverrun = out.rows.reduce((m, r) => Math.max(m, r.overrun), 0);
  return out;
};

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  page.on('pageerror', e => console.log('pageerror:', (e.stack || e.message).slice(0, 200)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__out && window.__out.stage === 'ready', null, { timeout: 120000 }).catch(() => {});
  await sleep(700);

  const i = await page.evaluate((w) => UI.samples.findIndex(s => s.id.indexOf(w) >= 0), want);

  const runOnce = async (useReflow) => {
    await page.evaluate((k) => UI.select(k), i);            /* 每条都从原始样例重新开始 */
    await sleep(500);
    return page.evaluate(async ({ k, useReflow }) => {
      const smp = UI.samples[k];
      let restore = null;
      if (!useReflow) {
        const orig = Analyzer.run;
        Analyzer.run = function (ir, o) {
          const r = orig.call(this, ir, o);
          for (const it of (r.issues || [])) {
            if (Array.isArray(it.candidates)) it.candidates = it.candidates.filter(c => c !== 'reflow_body');
          }
          return r;
        };
        restore = () => { Analyzer.run = orig; };
      }
      const before = (() => { const an = Analyzer.run(IR.build(Runtime, {}), {}); return an.score; })();
      const rec = await Pipeline.beautify(Runtime, smp.svg, { strategy: 'rule', temp: 3, maxRounds: 4, sopt: {} });
      const reflowPicked = (rec.ledger || []).reduce((a, x) =>
        a + ((x.steps || []).filter(s => s.strategy === 'reflow_body').length), 0);
      if (restore) restore();
      return { before, after: rec.after ? rec.after.score : null, delta: rec.delta,
        picked: reflowPicked, ms: rec.ms };
    }, { k: i, useReflow });
  };

  await page.evaluate((k) => UI.select(k), i); await sleep(500);
  const audit0 = await page.evaluate(AUDIT);

  const runA = await runOnce(true);
  const auditA = await page.evaluate(AUDIT);

  const runB = await runOnce(false);
  const auditB = await page.evaluate(AUDIT);

  const fmt = o => `nOverrun=${o.nOverrun}  max=${o.maxOverrun}px  ` +
    (o.rows.length ? o.rows.map(r => r.id + '@' + r.overrun + 'px').join(', ') : '—');

  console.log('sample:', want);
  console.log('A) 启用 reflow_body  ', JSON.stringify(runA));
  console.log('   审计              ', fmt(auditA));
  console.log('B) 禁用 reflow_body  ', JSON.stringify(runB));
  console.log('   审计              ', fmt(auditB));
  console.log('原始（未美化）       ', fmt(audit0));
  console.log('');
  const same = auditA.nOverrun === auditB.nOverrun && Math.abs(auditA.maxOverrun - auditB.maxOverrun) < 0.05;
  console.log('结论: 越界情况 A/B ' + (same ? '一致 ⇒ 与 reflow_body 无关' : '不同 ⇒ reflow_body 有影响，需逐条核对'));

  await browser.close();
})();
